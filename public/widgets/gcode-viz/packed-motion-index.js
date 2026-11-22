const SOURCE_BLOCK_CHARACTERS = 192 * 1024;
const MOVE_BLOCK_SIZE = 1024;
// Checkpoints and replay windows share this command boundary. The character
// bound can also split a source block when unusually long lines require it.
export const MOTION_WINDOW_LINES = 2048;

export function createPackedMotionSource() {
  const blocks = [];
  let pending = [];
  let characters = 0;
  let count = 0;
  let sourceBytes = 0;
  let pendingStart = 0;
  let writeMs = 0;

  function flush() {
    if (!pending.length) return;
    // Keep immutable source in bounded Blob blocks. Encoding happens in
    // the ingestion worker without waiting for serial compression.
    const start = performance.now();
    const blob = new Blob([pending.join('')]);
    writeMs += performance.now() - start;
    blocks.push({ first: pendingStart, end: count, blob });
    pending = [];
    characters = 0;
    pendingStart = count;
    sourceBytes += blob.size;
  }

  return {
    get count() { return count; },
    append(line) {
      // A trailing comment contains no modal data and never needs replay.
      const comment = line.indexOf(';');
      const command = comment === -1 ? line : line.slice(0, comment);
      pending.push(command, '\n');
      characters += command.length + 1;
      count++;
      if (characters >= SOURCE_BLOCK_CHARACTERS || count % MOTION_WINDOW_LINES === 0) flush();
    },
    finish() {
      flush();
      return { blocks, sourceBytes, writeMs };
    },
  };
}

export async function replayPackedMotionSource(blocks, start, end, signal, consume) {
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
    const readable = block.blob.stream().pipeThrough(new TransformStream(), { signal });
    const lines = (await new Response(readable).text()).split('\n');
    signal?.throwIfAborted();
    if (await consume(lines, Math.max(0, start - block.first), Math.min(block.end, end) - block.first) === false) break;
  }
}

function travelDistance(from, to, arc) {
  return arc
    ? Math.hypot(arc.radius * arc.sweep, to.z - from.z)
    : Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

export function addMotionWeights(weights, move, arc) {
  const xyz = travelDistance(move.pos, move.next, arc);
  const length = xyz || Math.abs(move.deltaE);
  if (!(length > 0)) return;
  const seconds = length * 60 / move.feed;
  if (move.feed > 0 && Number.isFinite(weights.duration + seconds)) weights.duration += seconds;
  else weights.untimed++;
  weights.distance += xyz;
  weights.moves++;
}

// A layer range starts before its entering travel and ends at its last
// deposition. Intersect those exact boundaries with fixed source spans so
// no portion of a long layer needs to be decoded before its first sample.
export function indexMotionWindows(ranges, spans) {
  const windows = [];
  const layers = ranges.map((range, layer) => {
    if (!range) return null;
    const parts = [];
    let duration = 0, distance = 0, moves = 0, untimed = false;
    for (let i = range.start.span; i <= range.end.span; i++) {
      const span = spans[i];
      const start = i === range.start.span ? range.start : span.start;
      const end = i === range.end.span ? range.end : span.end;
      if (end.unsupported > start.unsupported) return { unavailable: 'unsupported-arc' };
      const length = end.distance - start.distance;
      const time = end.duration - start.duration;
      parts.push({ line: start.line, state: start.state, end: end.line, length, time });
      distance += length;
      duration += time;
      moves += end.moves - start.moves;
      untimed ||= end.untimed > start.untimed;
    }
    if (!(distance > 0)) return null;
    if (untimed || !Number.isFinite(duration)) duration = 0;
    const basis = duration > 0 ? 'feed' : 'distance';
    const first = windows.length;
    let through = 0;
    for (const { line, state, end, length, time } of parts) {
      const weight = basis === 'feed' ? time : length;
      if (!(weight > 0)) continue;
      const before = through;
      through += weight;
      windows.push({ line, state, end, before, through, layer });
    }
    const last = windows.length - 1;
    return { duration, distance, moves, basis, first, last, through };
  });
  return { layers, windows };
}

export function locateMotionWindow(windows, layer, fraction) {
  if (!Number.isFinite(fraction)) return null;
  const { first, last, through } = layer;
  if (fraction <= 0) return { index: first, fraction: 0 };
  if (fraction >= 1) return { index: last, fraction: 1 };
  const target = fraction * through;
  let lo = first;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (windows[mid].through <= target) lo = mid + 1;
    else hi = mid;
  }
  const { before, through: end } = windows[lo];
  return { index: lo, fraction: Math.max(0, Math.min(1, (target - before) / (end - before))) };
}

export function createWindowMoves() {
  const blocks = [];
  let count = 0;
  let time = 0;
  let distance = 0;
  let timed = true;
  let bytes = 0;

  function add(from, to, deltaE, feed, extrusion, arc) {
    const xyz = travelDistance(from, to, arc);
    const length = xyz || Math.abs(deltaE);
    if (!(length > 0)) return;
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
    finish() {
      if (!count) return null;
      const duration = timed ? time : 0;
      return {
        bytes,
        duration,
        distance,
        moves: count,
        sample(fraction, basis) {
          const distanceBased = basis === 'distance';
          const total = distanceBased ? distance : duration;
          if (!Number.isFinite(fraction) || !(total > 0)) return null;
          const target = Math.max(0, Math.min(1, fraction)) * total;
          const weightOffset = Number(distanceBased);
          function weight(i) {
            if (i < 0) return 0;
            const block = blocks[Math.floor(i / MOVE_BLOCK_SIZE)];
            return block.weights[(i % MOVE_BLOCK_SIZE) * 2 + weightOffset];
          }
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
