const assert = require('node:assert/strict');
const test = require('node:test');

async function fixture(options) {
  const { WebGLPreview } = await import('../public/vendor/gcode-preview.esm.js');
  const { createPackedToolpath } = await import('../public/widgets/gcode-viz/packed-toolpath.js');
  const native = Object.create(WebGLPreview.prototype);
  native.minLayerThreshold = 0.05;
  native.clear();
  return { packed: createPackedToolpath(native.parser, options), native };
}

function unpack(data) {
  return data.chunks.flatMap(chunk => Array.from({ length: chunk.count }, (_, i) => ({
    points: [...chunk.positions.subarray(i * 6, i * 6 + 6)],
    tool: chunk.tools[i],
  })));
}

test('packed linear extrusion keeps native layer boundaries and all endpoints across chunk boundaries', async () => {
  const { native, packed } = await fixture({ chunkSegments: 2 });
  const lines = [
    'G90', 'M83', 'G1 X10 Y10 Z0.2', 'T1', 'G1 X20 Y10 E1', 'G1 X20 Y20 E1',
    'T0', 'G1 X20 Y20 Z0.4', 'G1 X10 Y20 E1', 'G1 X10 Y10 E1', 'G0 X40 Y40',
  ];
  packed.parseBatch(lines.slice(0, 7));
  packed.parseBatch(lines.slice(7));
  native.parser.parseGCode(lines);
  const result = packed.finish();
  assert.deepEqual(result.layers.map(layer => layer.height), native.layers.map(layer => layer.height));
  assert.deepEqual(result.layers.map(layer => layer.end), [0, 2, 4]);
  assert.deepEqual(result.bounds, [10, 10, 0.2, 20, 20, 0.4]);
  assert.deepEqual(result.chunks.map(chunk => [chunk.start, chunk.count]), [[0, 2], [2, 2]]);
  const z1 = Math.fround(0.2);
  const z2 = Math.fround(0.4);
  assert.deepEqual(unpack(result), [
    { points: [10, 10, z1, 20, 10, z1], tool: 1 }, { points: [20, 10, z1, 20, 20, z1], tool: 1 },
    { points: [20, 20, z2, 10, 20, z2], tool: 0 }, { points: [10, 20, z2, 10, 10, z2], tool: 0 },
  ]);
});

test('packed moves preserve position offsets, relative axes, absolute extrusion and extended tool IDs', async () => {
  const { packed } = await fixture({ chunkSegments: 2 });
  packed.parseBatch(['G90', 'M82', 'G1 X10 Y10 Z0.2', 'T13', 'G1 X11 E2', 'G1 X12 E1']);
  packed.parseBatch(['G92 X0 E0', 'G91', 'G1 X2 E0', 'G90', 'G1 X3 E1', 'G1 Z0.7', 'M83', 'G1 Y11 E0.5']);
  const result = packed.finish();
  const z1 = Math.fround(0.2);
  const z2 = Math.fround(0.7);
  assert.deepEqual(unpack(result), [
    { points: [10, 10, z1, 11, 10, z1], tool: 13 },
    { points: [14, 10, z1, 15, 10, z1], tool: 13 },
    { points: [15, 10, z2, 15, 11, z2], tool: 13 },
  ]);
  assert.deepEqual(result.layers.map(layer => layer.end), [0, 2, 3]);
});

test('packed CW, CCW and full-circle arcs tessellate real geometry and carry units', async () => {
  const { packed } = await fixture({ chunkSegments: 4 });
  packed.parseBatch(['G21', 'G90', 'M83', 'G1 X0 Y0 Z0.2', 'G2 X10 Y0 R5 E1']);
  packed.parseBatch(['G3 X0 Y0 I-5 J0 E1', 'G2 I5 J0 E1', 'G20', 'G1 X1 Y0 E1']);
  const result = packed.finish();
  const lines = unpack(result).map(segment => segment.points);
  assert.ok(lines.length >= 33);
  assert.ok(lines.some(points => points[1] >= 4.9));
  assert.ok(lines.some(points => points[1] <= -4.9));
  for (let i = 1; i < lines.length; i++) assert.deepEqual(lines[i - 1].slice(3), lines[i].slice(0, 3));
  assert.deepEqual(lines.at(-1).slice(3), [Math.fround(25.4), 0, Math.fround(0.2)]);
  assert.deepEqual(result.layers.map(layer => layer.end), [0, lines.length]);
});

test('packed previews refuse over-budget, invalid and unsupported geometry without retry', async () => {
  const { packed } = await fixture({ maxSegments: 3, chunkSegments: 2 });
  packed.parseBatch(['G90', 'M83', 'G1 X1 Y1 Z0.2 E1', 'G1 X2 E1', 'G1 X3 E1']);
  assert.deepEqual(packed.finish().chunks.map(chunk => chunk.tools.length), [2, 1]);
  const refusal = { code: 'PREVIEW_COMPLEXITY', retryable: false, recovery: false };
  assert.throws(() => packed.parseBatch(['G1 X4 E1']), { ...refusal, message: /geometry budget/ });
  const radii = (await fixture()).packed;
  radii.parseBatch(['M83', 'G0 Z0.2']);
  assert.throws(() => radii.parseBatch(['G2 X10 Y0 R1 E1']), { ...refusal, message: /radius arc/ });
  const plane = (await fixture()).packed;
  plane.parseBatch(['M83', 'G18', 'G1 Z0.2']);
  assert.throws(() => plane.parseBatch(['G2 Z2.2 K1 E1']), { ...refusal, message: /supported XY plane/ });
  const turns = (await fixture()).packed;
  turns.parseBatch(['M83', 'G1 Z0.2']);
  assert.throws(() => turns.parseBatch(['G2 I5 J0 P2 E1']), { ...refusal, message: /turn count/ });
});
