import { PreviewWorkloadError, PREVIEW_WORKLOAD_LIMITS } from './preview-workload.js';
import {
  addMotionWeights, createPackedMotionSource, createWindowMoves, indexMotionWindows, locateMotionWindow,
  replayPackedMotionSource, MOTION_WINDOW_LINES,
} from './packed-motion-index.js';
import { parseToolpathLayerMarker } from './toolpath-layer-marker.js';

const CHUNK_SEGMENTS = 32_768;
const MAX_PACKED_SEGMENTS = 3_800_000;
// Each segment uses 24 position bytes and one tool byte in the reader. The
// renderer adds six RGB bytes per segment. Both bounds include allocation in
// full chunks. No retained command objects or simulated nozzle paths.
const TAU = Math.PI * 2;
const motions = new Set(['g0', 'g00', 'g1', 'g01', 'g2', 'g02', 'g3', 'g03']);
const arcs = new Set(['g2', 'g02', 'g3', 'g03']);
const axes = ['x', 'y', 'z'];
const modal = new Set([
  'g20', 'g21', 'g90', 'g91', 'g90.1', 'g91.1', 'm82', 'm83',
  'g17', 'g18', 'g19', 'g92', 'g28', 'g29', 'g380', 'g38.2', 'g38.3', 'g38.4', 'g38.5',
]);
const axisMask = { x: 1, y: 2, z: 4 };
const isTool = gcode => gcode.startsWith('t') && /^t-?\d+$/.test(gcode);
const isMotionSource = gcode => motions.has(gcode) || modal.has(gcode) || isTool(gcode);
const coordinateLimit = 1_000_000;

function complexity(message) {
  return new PreviewWorkloadError(message);
}

function checkCoordinate(number) {
  if (!Number.isFinite(number) || Math.abs(number) > coordinateLimit) {
    throw complexity('The toolpath contains coordinates outside the supported preview range.');
  }
  return number;
}

function sweepAngle(from, to, clockwise, fullCircle) {
  if (fullCircle) return clockwise ? -TAU : TAU;
  let angle = to - from;
  if (clockwise && angle > 0) angle -= TAU;
  if (!clockwise && angle < 0) angle += TAU;
  return angle;
}

function describeArc(start, end, params, units, clockwise) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const fullCircle = dx === 0 && dy === 0;
  let i = 0, j = 0;
  if (params.r !== undefined) {
    const signedRadius = checkCoordinate(params.r * units);
    const radius = Math.abs(signedRadius);
    const chord = Math.hypot(dx, dy);
    if (!chord || chord / 2 > radius + 0.02) {
      throw complexity('The toolpath contains a radius arc without a supported centre.');
    }
    const side = (clockwise ? -1 : 1) * Math.sign(signedRadius);
    const offset = side * Math.sqrt(Math.max(0, radius ** 2 - (chord / 2) ** 2)) / chord;
    i = dx / 2 - dy * offset;
    j = dy / 2 + dx * offset;
  } else {
    i = checkCoordinate((params.i ?? 0) * units);
    j = checkCoordinate((params.j ?? 0) * units);
  }
  const radius = Math.hypot(i, j);
  const endRadius = Math.hypot(dx - i, dy - j);
  if (!radius || Math.abs(radius - endRadius) > Math.max(0.08, radius * 0.01)) {
    throw complexity('The toolpath contains an arc without a valid centre.');
  }
  const angle = Math.atan2(-j, -i);
  const sweep = sweepAngle(angle, Math.atan2(dy - j, dx - i), clockwise, fullCircle);
  const count = Math.max(1, Math.ceil(Math.abs(sweep) * radius / 1.8), Math.ceil(Math.abs(sweep) / (Math.PI / 8)));
  if (count > PREVIEW_WORKLOAD_LIMITS.arcSegments) {
    throw complexity('An arc in this toolpath needs too many render segments.');
  }
  return { x: start.x + i, y: start.y + j, radius, angle, sweep, count };
}

function extendBounds(bounds, x, y, z) {
  bounds[0] = Math.min(bounds[0], x);
  bounds[1] = Math.min(bounds[1], y);
  bounds[2] = Math.min(bounds[2], z);
  bounds[3] = Math.max(bounds[3], x);
  bounds[4] = Math.max(bounds[4], y);
  bounds[5] = Math.max(bounds[5], z);
}

function emptyBounds() {
  return [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
}

// The static model and lazy animation replay interpret the same modal state.
// Checkpoints capture the state immediately before relevant source blocks, so
// hydrating a layer never needs to parse the rest of the print.
function createMotionReader(checkpoint) {
  const pos = { x: 0, y: 0, z: 0, ...checkpoint?.pos };
  const offset = { x: 0, y: 0, z: 0, ...checkpoint?.offset };
  const next = { x: 0, y: 0, z: 0 };
  let {
    units = 1, plane = 'g17', absolute = true, absoluteArcCenter = false,
    extruderRelative = true, e = 0, tool = 0, feed = 0, known = 0,
  } = checkpoint ?? {};
  const motion = { pos, next };
  return {
    snapshot: () => ({ pos: { ...pos }, offset: { ...offset }, units, plane, absolute, absoluteArcCenter,
      extruderRelative, e, tool, feed, known }),
    read({ gcode, params }, onSetting, onMove) {
      if (!motions.has(gcode)) {
        onSetting();
        switch (gcode) {
          case 'g20': units = 25.4; return;
          case 'g21': units = 1; return;
          case 'g90': absolute = true; return;
          case 'g91': absolute = false; return;
          case 'g90.1': absoluteArcCenter = true; return;
          case 'g91.1': absoluteArcCenter = false; return;
          case 'm82': extruderRelative = false; return;
          case 'm83': extruderRelative = true; return;
          case 'g17':
          case 'g18':
          case 'g19': plane = gcode; return;
          case 'g28':
          case 'g29':
          case 'g380':
          case 'g38.2':
          case 'g38.3':
          case 'g38.4':
          case 'g38.5':
            // Homing/probing can move the real head without a specified
            // destination. Do not draw a path from the invented origin.
            known = 0;
            return;
          case 'g92':
            for (const axis of axes) {
              if (params[axis] !== undefined) offset[axis] = pos[axis] - checkCoordinate(params[axis] * units);
            }
            if (params.e !== undefined) e = checkCoordinate(params.e * units);
            return;
        }
        const index = Number(gcode.slice(1));
        tool = index >= 0 && index <= 31 ? index : 255;
        return;
      }
      let nextKnown = known;
      for (const axis of axes) {
        const value = params[axis];
        next[axis] = value === undefined ? pos[axis] : checkCoordinate(value * units + (absolute ? offset[axis] : pos[axis]));
        if (absolute && value !== undefined) nextKnown |= axisMask[axis];
      }
      const extruder = params.e === undefined ? e : checkCoordinate(params.e * units);
      const deltaE = params.e === undefined ? 0 : extruderRelative ? extruder : extruder - e;
      const changesXY = next.x !== pos.x || next.y !== pos.y;
      const arc = arcs.has(gcode) && (changesXY || next.z !== pos.z ||
        params.i !== undefined || params.j !== undefined || params.k !== undefined || params.r !== undefined);
      const newFeed = params.f === undefined ? feed : params.f * units;
      motion.feed = Number.isFinite(newFeed) && newFeed > 0 ? newFeed : 0;
      motion.deltaE = deltaE;
      motion.extrusion = deltaE > 0 && (changesXY || arc);
      motion.anchored = known === 7;
      motion.arc = arc;
      motion.plane = plane;
      motion.unsupportedArc = absoluteArcCenter || (params.p !== undefined && params.p !== 1);
      motion.clockwise = gcode === 'g2' || gcode === 'g02';
      motion.params = params;
      motion.tool = tool;
      motion.units = units;
      const pending = onMove(motion);
      if (!extruderRelative) e = extruder;
      feed = motion.feed;
      pos.x = next.x; pos.y = next.y; pos.z = next.z;
      known = nextKnown;
      return pending;
    },
  };
}

function getCurve(move) {
  if (move.plane !== 'g17') throw complexity('This plate uses an arc outside the supported XY plane.');
  if (move.unsupportedArc) throw complexity('This plate uses an unsupported arc centre or turn count.');
  return describeArc(move.pos, move.next, move.params, move.units, move.clockwise);
}

export function restorePackedMotion(parser, descriptor) {
  if (!descriptor) return null;
  const { layers, windows, blocks, sourceBytes } = descriptor;
  const tracks = layers.map(track => track?.through ? {
    ...track,
    locate: fraction => locateMotionWindow(windows, track, fraction),
  } : track);
  return {
    windowCount: windows.length,
    layer: index => tracks[index] ?? null,
    sourceBytes,
    rawSourceBytes: sourceBytes,
    async load(index, { signal, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
      signal?.throwIfAborted();
      const window = windows[index];
      if (!window) return null;
      const reader = createMotionReader(window.state);
      const moves = createWindowMoves();
      const onSetting = () => {};
      let unsupportedArc = false;
      let deposited = window.deposited;
      const onMove = move => {
        if (!move.anchored && !move.extrusion) return;
        let curve;
        if (move.arc) {
          try { curve = getCurve(move); }
          catch (error) {
            if (!(error instanceof PreviewWorkloadError)) throw error;
            unsupportedArc = true;
            return;
          }
        }
        // An unanchored motion never supplies a nozzle pose. Its commanded
        // static geometry still contributes to subsequent segment ordinals.
        if (move.anchored) moves.add(move, curve, deposited);
        if (move.extrusion) deposited += curve?.count ?? 1;
      };
      await replayPackedMotionSource(blocks, window.line, window.end, signal, async (lines, from, to) => {
        let deadline = performance.now() + 8;
        for (let i = from; i < to; i++) {
          reader.read(parser.parseCommand(lines[i], false), onSetting, onMove);
          if (unsupportedArc) return false;
          if (i % 128 === 0 && performance.now() >= deadline) {
            await yieldTask();
            signal?.throwIfAborted();
            deadline = performance.now() + 8;
          }
        }
      });
      signal?.throwIfAborted();
      if (unsupportedArc) return { unavailable: 'unsupported-arc', bytes: 0 };
      const path = moves.finish();
      return path ? { ...path, layer: window.layer } : null;
    },
  };
}

// A verified slicer layer may contain several distinct geometry Z values.
// Keep the natural Z grouping as a fallback until the complete marker chain
// is known. Both indexes point into exactly the same global segment buffer.
function createSlicerLayerIndex(checkpoint) {
  const markers = [];
  let pending = null;
  let expectedTotal = null;
  let valid = true;
  const complete = marker => marker.modelLayer !== undefined && marker.z !== undefined;

  function invalidate() {
    valid = false;
    pending = null;
    markers.length = 0;
  }

  return {
    read(marker, segments) {
      if (!valid) return;
      switch (marker.kind) {
        case 'invalid':
          invalidate();
          return;
        case 'change':
          if ((pending && !complete(pending)) || markers.length >= PREVIEW_WORKLOAD_LIMITS.layers) {
            invalidate();
            return;
          }
          pending = { start: checkpoint(), segments };
          markers.push(pending);
          return;
        case 'height':
          if (!pending || pending.expectedZ !== undefined) {
            invalidate();
            return;
          }
          pending.expectedZ = marker.z;
          return;
        case 'number':
          if (!pending || pending.modelLayer !== undefined || marker.layer !== markers.length ||
              marker.total < marker.layer || marker.total > PREVIEW_WORKLOAD_LIMITS.layers ||
              (expectedTotal !== null && marker.total !== expectedTotal)) {
            invalidate();
            return;
          }
          pending.modelLayer = marker.layer;
          expectedTotal = marker.total;
      }
    },
    confirm(z) {
      if (pending?.expectedZ !== undefined && pending.z === undefined && Math.abs(z - pending.expectedZ) <= 0.01) {
        pending.z = z;
      }
    },
    finish(segments, lastDeposition) {
      if (!valid || !pending || !complete(pending) || markers.length !== expectedTotal) return null;
      const layers = [{ height: 0, z: 0, end: markers[0].segments }];
      const ranges = [null];
      let previousZ = 0;
      for (let i = 0; i < markers.length; i++) {
        const { modelLayer, z, start } = markers[i];
        const next = markers[i + 1];
        layers.push({ modelLayer, z, height: Math.abs(z - previousZ), end: next?.segments ?? segments });
        ranges.push(start ? { start, end: next?.start ?? lastDeposition } : null);
        previousZ = z;
      }
      return { layers, ranges };
    },
  };
}

export function createPackedToolpath(parser, {
  maxSegments = MAX_PACKED_SEGMENTS,
  chunkSegments = CHUNK_SEGMENTS,
  signal,
  yieldTask,
  transferable = false,
} = {}) {
  const chunks = [];
  const allBounds = emptyBounds();
  const modelBounds = emptyBounds();
  const preamble = { height: 0, end: 0 };
  const layers = [preamble];
  let layer = preamble, layerStart = 0, lastZ = null;
  let segmentCount = 0;
  let chunk;
  const reader = createMotionReader();
  const spool = yieldTask ? createPackedMotionSource() : null;
  const ranges = spool ? [null] : null;
  const spans = spool ? [] : null;
  let span = null;
  let lineIndex = 0;
  let deadline = 0;
  let transition = null;
  let tool = 0;

  function checkpoint() {
    if (!spool) return null;
    const boundary = span?.end ?? {
      line: 0, duration: 0, distance: 0, moves: 0, unsupported: 0, untimed: 0, deposited: segmentCount,
    };
    return { ...boundary, state: reader.snapshot(), span: Math.max(0, spans.length - 1) };
  }
  const slicer = createSlicerLayerIndex(checkpoint);

  function addSegment(ax, ay, az, bx, by, bz) {
    if (segmentCount >= maxSegments) {
      throw complexity('This whole plate exceeds the available 3D preview geometry budget.');
    }
    if (segmentCount - layerStart >= PREVIEW_WORKLOAD_LIMITS.layerSegments) {
      throw complexity('A layer is too dense for a reliable 3D preview.');
    }
    if (!chunk || chunk.count === chunk.tools.length) {
      const capacity = Math.min(chunkSegments, maxSegments - segmentCount);
      chunk = { positions: new Float32Array(capacity * 6), tools: new Uint8Array(capacity), start: segmentCount, count: 0 };
      chunks.push(chunk);
    }
    const at = chunk.count * 6;
    const p = chunk.positions;
    p[at] = ax; p[at + 1] = ay; p[at + 2] = az;
    p[at + 3] = bx; p[at + 4] = by; p[at + 5] = bz;
    chunk.tools[chunk.count++] = tool;
    extendBounds(allBounds, ax, ay, az);
    extendBounds(allBounds, bx, by, bz);
    if (layer.height >= 0.05 && layer.height <= 0.5) {
      extendBounds(modelBounds, ax, ay, az);
      extendBounds(modelBounds, bx, by, bz);
    }
    layer.end = ++segmentCount;
  }

  function captureTransition() {
    if (spool && !transition) {
      transition = { ...span.end, state: reader.snapshot(), span: spans.length - 1 };
    }
  }

  function measureMotion(move, curve) {
    if (!move.anchored) return;
    if (move.arc && !curve) {
      try { curve = getCurve(move); }
      catch (error) {
        if (!(error instanceof PreviewWorkloadError)) throw error;
        span.end.unsupported++;
        return;
      }
    }
    addMotionWeights(span.end, move, curve);
  }

  function addCurve(curve, from, to) {
    let ax = from.x, ay = from.y, az = from.z;
    // Keep stable endpoints across a yield; the interpreter immediately
    // advances its position for the following line.
    const x = to.x, y = to.y, z = to.z, startZ = from.z;
    function appendFrom(index) {
      for (let step = index; step < curve.count; step++) {
        if (yieldTask && step % 128 === 0 && performance.now() >= deadline) {
          return yieldTask().then(() => {
            signal?.throwIfAborted();
            deadline = performance.now() + 8;
            return appendFrom(step);
          });
        }
        const t = step / curve.count;
        const angle = curve.angle + curve.sweep * t;
        const bx = checkCoordinate(curve.x + curve.radius * Math.cos(angle));
        const by = checkCoordinate(curve.y + curve.radius * Math.sin(angle));
        const bz = startZ + (z - startZ) * t;
        addSegment(ax, ay, az, bx, by, bz);
        ax = bx; ay = by; az = bz;
      }
      addSegment(ax, ay, az, x, y, z);
    }
    return appendFrom(1);
  }

  function onMove(move) {
    if (!move.extrusion) {
      captureTransition();
      if (spool) measureMotion(move);
      return;
    }
    const { pos, next, arc } = move;
    const curve = arc ? getCurve(move) : null;
    if (move.anchored) slicer.confirm(next.z);
    if (lastZ === null || Math.abs(next.z - lastZ) > parser.tolerance) {
      if (layers.length > PREVIEW_WORKLOAD_LIMITS.layers) throw complexity('The preview cannot safely hold this many layers.');
      layer = { height: Math.abs(next.z - (lastZ ?? 0)), z: next.z, end: segmentCount };
      layers.push(layer);
      layerStart = segmentCount;
      lastZ = next.z;
      if (spool) {
        captureTransition();
        ranges.push({ start: transition, end: {} });
      }
    }
    if (spool) {
      // Include any inter-layer travel in the next layer, but never replay
      // parking and post-processing after the final deposition.
      measureMotion(move, curve);
      span.end.deposited = segmentCount + (curve?.count ?? 1);
      const end = ranges.at(-1).end;
      Object.assign(end, span.end);
      end.line = lineIndex + 1;
      end.span = spans.length - 1;
      transition = null;
    }
    tool = move.tool;
    if (curve) return addCurve(curve, pos, next);
    addSegment(pos.x, pos.y, pos.z, next.x, next.y, next.z);
  }

  function process(line) {
    if (line.length > PREVIEW_WORKLOAD_LIMITS.commandCharacters) {
      throw complexity('A single G-code command is too large to preview safely.');
    }
    if (line.startsWith(';')) {
      const marker = parseToolpathLayerMarker(line);
      if (marker) slicer.read(marker, segmentCount);
      return;
    }
    const command = parser.parseCommand(line, false);
    if (!isMotionSource(command.gcode)) return;
    if (spool) {
      lineIndex = spool.count;
      if (lineIndex % MOTION_WINDOW_LINES === 0) {
        const boundary = {
          line: lineIndex, duration: 0, distance: 0, moves: 0, unsupported: 0, untimed: 0, deposited: segmentCount,
        };
        span = { start: { ...boundary, state: reader.snapshot() }, end: boundary };
        spans.push(span);
      }
      spool.append(line);
    }
    const pending = reader.read(command, captureTransition, onMove);
    if (spool) span.end.line = lineIndex + 1;
    return pending;
  }

  async function parseMotionBatch(lines) {
    signal?.throwIfAborted();
    if (!deadline) deadline = performance.now() + 8;
    for (const line of lines) {
      const pending = process(line);
      if (pending) await pending;
    }
  }

  function result() {
    signal?.throwIfAborted();
    let descriptor = null;
    let timing;
    const marked = slicer.finish(segmentCount, ranges?.at(-1)?.end);
    if (spool) {
      const { writeMs, ...source } = spool.finish();
      const start = performance.now();
      descriptor = { ...source, ...indexMotionWindows(marked?.ranges ?? ranges, spans) };
      timing = { sourceMs: writeMs, indexMs: performance.now() - start };
    }
    return {
      chunks, layers: marked?.layers ?? layers, segmentCount, bounds: Number.isFinite(modelBounds[0]) ? modelBounds : allBounds,
      motion: transferable ? descriptor : restorePackedMotion(parser, descriptor), timing,
    };
  }

  return {
    parseBatch(lines) {
      if (spool) return parseMotionBatch(lines);
      for (const line of lines) process(line);
    },
    finish: result,
  };
}
