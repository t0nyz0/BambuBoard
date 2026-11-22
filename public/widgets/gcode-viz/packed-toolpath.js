import { PreviewWorkloadError, PREVIEW_WORKLOAD_LIMITS } from './preview-workload.js';

const CHUNK_SEGMENTS = 32_768;
const MAX_PACKED_SEGMENTS = 3_800_000;
// Each segment uses 24 position bytes and one tool byte in the reader. The
// renderer adds six RGB bytes per segment. Both bounds include allocation in
// full chunks. No retained command objects or simulated nozzle paths.
const TAU = Math.PI * 2;
const motions = new Set(['g0', 'g00', 'g1', 'g01', 'g2', 'g02', 'g3', 'g03']);
const arcs = new Set(['g2', 'g02', 'g3', 'g03']);
const axes = ['x', 'y', 'z'];
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

export function createPackedToolpath(parser, {
  maxSegments = MAX_PACKED_SEGMENTS,
  chunkSegments = CHUNK_SEGMENTS,
} = {}) {
  const chunks = [];
  const allBounds = emptyBounds();
  const modelBounds = emptyBounds();
  const preamble = { height: 0, end: 0 };
  const layers = [preamble];
  let layer = preamble, layerStart = 0, lastZ = null;
  let segmentCount = 0;
  let chunk;
  const pos = { x: 0, y: 0, z: 0 };
  const offset = { x: 0, y: 0, z: 0 };
  const next = { x: 0, y: 0, z: 0 };
  let units = 1, plane = 'g17', absolute = true, absoluteArcCenter = false;
  let extruderRelative = true, e = 0, tool = 0;

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

  function process(line) {
    if (line.length > PREVIEW_WORKLOAD_LIMITS.commandCharacters) {
      throw complexity('A single G-code command is too large to preview safely.');
    }
    const { gcode, params } = parser.parseCommand(line, false);
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
      case 'g92':
        for (const axis of axes) {
          if (params[axis] !== undefined) offset[axis] = pos[axis] - checkCoordinate(params[axis] * units);
        }
        if (params.e !== undefined) e = checkCoordinate(params.e * units);
        return;
    }
    if (gcode.startsWith('t') && /^t-?\d+$/.test(gcode)) {
      const index = Number(gcode.slice(1));
      tool = index >= 0 && index <= 31 ? index : 255;
      return;
    }
    if (!motions.has(gcode)) return;
    for (const axis of axes) {
      const value = params[axis];
      next[axis] = value === undefined ? pos[axis] : checkCoordinate(value * units + (absolute ? offset[axis] : pos[axis]));
    }
    const extruder = params.e === undefined ? e : checkCoordinate(params.e * units);
    const extruding = params.e !== undefined && (extruderRelative ? extruder > 0 : extruder > e);
    if (!extruderRelative) e = extruder;
    const changesXY = next.x !== pos.x || next.y !== pos.y;
    const arc = arcs.has(gcode) && (changesXY || next.z !== pos.z ||
      params.i !== undefined || params.j !== undefined || params.k !== undefined || params.r !== undefined);
    if (extruding && arc && plane !== 'g17') {
      throw complexity('This plate uses an arc outside the supported XY plane.');
    }
    if (extruding && arc && (absoluteArcCenter || (params.p !== undefined && params.p !== 1))) {
      throw complexity('This plate uses an unsupported arc centre or turn count.');
    }
    const movesXY = changesXY || arc;
    if (extruding && movesXY) {
      if (lastZ === null || Math.abs(next.z - lastZ) > parser.tolerance) {
        if (layers.length > PREVIEW_WORKLOAD_LIMITS.layers) throw complexity('The preview cannot safely hold this many layers.');
        layer = { height: Math.abs(next.z - (lastZ ?? 0)), end: segmentCount };
        layers.push(layer);
        layerStart = segmentCount;
        lastZ = next.z;
      }
      if (arc) {
        const curve = describeArc(pos, next, params, units, gcode === 'g2' || gcode === 'g02');
        let ax = pos.x, ay = pos.y, az = pos.z;
        for (let step = 1; step < curve.count; step++) {
          const t = step / curve.count;
          const angle = curve.angle + curve.sweep * t;
          const bx = checkCoordinate(curve.x + curve.radius * Math.cos(angle));
          const by = checkCoordinate(curve.y + curve.radius * Math.sin(angle));
          const bz = pos.z + (next.z - pos.z) * t;
          addSegment(ax, ay, az, bx, by, bz);
          ax = bx; ay = by; az = bz;
        }
        addSegment(ax, ay, az, next.x, next.y, next.z);
      } else {
        addSegment(pos.x, pos.y, pos.z, next.x, next.y, next.z);
      }
    }
    pos.x = next.x;
    pos.y = next.y;
    pos.z = next.z;
  }

  return {
    parseBatch(lines) {
      for (const line of lines) process(line);
    },
    finish() {
      return { chunks, layers, segmentCount, bounds: Number.isFinite(modelBounds[0]) ? modelBounds : allBounds };
    },
  };
}
