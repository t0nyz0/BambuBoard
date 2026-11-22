const SOURCE_BLOCK_CHARACTERS = 192 * 1024;
const MOVE_BLOCK_SIZE = 1024;
// At most two decoded layers are kept by the viewer. At 61 bytes per move
// in the worst case, the existing 250,000-command layer budget keeps both
// under 30 MiB of typed buffers, separate from the immutable source spool.
const MAX_LAYER_MOVES = 250_000;

export function createPackedMotionSource() {
  const blocks = [];
  const encoder = new TextEncoder();
  const compress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  let pending = [];
  let characters = 0;
  let count = 0;
  let sourceBytes = 0;
  let rawSourceBytes = 0;
  let pendingStart = 0;

  return {
    get count() { return count; },
    get sourceBytes() { return sourceBytes; },
    get rawSourceBytes() { return rawSourceBytes; },
    append(line) {
      // The caller retains only commands that affect the interpreted path.
      // A trailing comment contains no modal data and never needs replay.
      const comment = line.indexOf(';');
      const command = comment === -1 ? line : line.slice(0, comment);
      pending.push(command, '\n');
      characters += command.length + 1;
      count++;
      return characters >= SOURCE_BLOCK_CHARACTERS;
    },
    async flush(signal) {
      if (!pending.length) return;
      signal?.throwIfAborted();
      const bytes = encoder.encode(pending.join(''));
      pending = [];
      characters = 0;
      let blob;
      if (compress) {
        const compressor = new CompressionStream('gzip');
        const writer = compressor.writable.getWriter();
        const stream = new Response(compressor.readable).blob();
        const [, result] = await Promise.all([
          writer.write(bytes).then(() => writer.close()),
          stream,
        ]);
        blob = result;
      } else {
        blob = new Blob([bytes]);
      }
      signal?.throwIfAborted();
      blocks.push({ first: pendingStart, end: count, blob });
      pendingStart = count;
      sourceBytes += blob.size;
      rawSourceBytes += bytes.byteLength;
    },
    async replay(start, end, signal, consume) {
      let lo = 0;
      let hi = blocks.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (blocks[mid].end <= start) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < blocks.length && blocks[i].first < end; i++) {
        signal?.throwIfAborted();
        const block = blocks[i];
        const decoder = compress ? new DecompressionStream('gzip') : new TransformStream();
        const readable = block.blob.stream().pipeThrough(decoder, { signal });
        const lines = (await new Response(readable).text()).split('\n');
        signal?.throwIfAborted();
        if (await consume(lines, Math.max(0, start - block.first), Math.min(block.end, end) - block.first) === false) break;
      }
    },
  };
}

export function createLayerMoves() {
  const blocks = [];
  let count = 0;
  let time = 0;
  let distance = 0;
  let timed = true;
  let bytes = 0;
  let exceeding = false;

  function add(from, to, deltaE, feed, extrusion, arc) {
    if (exceeding) return;
    const xyz = arc
      ? Math.hypot(arc.radius * arc.sweep, to.z - from.z)
      : Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = xyz || Math.abs(deltaE);
    if (!(length > 0)) return;
    if (count === MAX_LAYER_MOVES) {
      exceeding = true;
      return;
    }
    let block = blocks.at(-1);
    if (count % MOVE_BLOCK_SIZE === 0) {
      block = {
        points: new Float32Array(MOVE_BLOCK_SIZE * 6),
        weights: new Float64Array(MOVE_BLOCK_SIZE * 2),
        flags: new Uint8Array(MOVE_BLOCK_SIZE),
        arcs: null,
      };
      blocks.push(block);
      bytes += block.points.byteLength + block.weights.byteLength + block.flags.byteLength;
    }
    const idx = count % MOVE_BLOCK_SIZE;
    const p = idx * 6;
    block.points[p] = from.x; block.points[p + 1] = from.y; block.points[p + 2] = from.z;
    block.points[p + 3] = to.x; block.points[p + 4] = to.y; block.points[p + 5] = to.z;
    const seconds = length * 60 / feed;
    if (feed > 0 && Number.isFinite(time + seconds)) time += seconds;
    else timed = false;
    distance += xyz;
    block.weights[idx * 2] = time;
    block.weights[idx * 2 + 1] = distance;
    block.flags[idx] = Number(extrusion) | (arc ? 2 : 0);
    if (arc) {
      if (!block.arcs) {
        block.arcs = new Float32Array(MOVE_BLOCK_SIZE * 5);
        bytes += block.arcs.byteLength;
      }
      const a = idx * 5;
      block.arcs[a] = arc.x; block.arcs[a + 1] = arc.y; block.arcs[a + 2] = arc.radius;
      block.arcs[a + 3] = arc.angle; block.arcs[a + 4] = arc.sweep;
    }
    count++;
  }

  return {
    add,
    get exceeded() { return exceeding; },
    finish() {
      if (exceeding || !count || !(distance > 0)) return null;
      const duration = timed ? time : 0;
      const distanceBased = duration === 0;
      const total = distanceBased ? distance : duration;
      const weightOffset = Number(distanceBased);
      function weight(i) {
        if (i < 0) return 0;
        const block = blocks[Math.floor(i / MOVE_BLOCK_SIZE)];
        return block.weights[(i % MOVE_BLOCK_SIZE) * 2 + weightOffset];
      }
      return {
        bytes,
        duration,
        distance,
        moves: count,
        basis: distanceBased ? 'distance' : 'feed',
        sample(fraction) {
          if (!Number.isFinite(fraction)) return null;
          const target = Math.max(0, Math.min(1, fraction)) * total;
          let lo = 0;
          let hi = count - 1;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (weight(mid) < target) lo = mid + 1;
            else hi = mid;
          }
          const end = weight(lo);
          const start = weight(lo - 1);
          const portion = end > start ? (target - start) / (end - start) : 0;
          const block = blocks[Math.floor(lo / MOVE_BLOCK_SIZE)];
          const idx = lo % MOVE_BLOCK_SIZE;
          const p = idx * 6;
          const a = idx * 5;
          const values = block.points;
          let x = values[p] + (values[p + 3] - values[p]) * portion;
          let y = values[p + 1] + (values[p + 4] - values[p + 1]) * portion;
          // Use exact command endpoints at the boundary, with the interior
          // using the commanded arc rather than replaying drawing chords.
          if ((block.flags[idx] & 2) && portion > 0 && portion < 1) {
            const curve = block.arcs;
            const angle = curve[a + 3] + curve[a + 4] * portion;
            x = curve[a] + curve[a + 2] * Math.cos(angle);
            y = curve[a + 1] + curve[a + 2] * Math.sin(angle);
          }
          return {
            x, y, z: values[p + 2] + (values[p + 5] - values[p + 2]) * portion,
            extruding: Boolean(block.flags[idx] & 1),
          };
        },
      };
    },
  };
}
