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

const yieldTask = () => new Promise(resolve => setImmediate(resolve));

test('packed lazy motion preserves modal feed, the preceding Z transition, travel arcs and retraction', async () => {
  const controller = new AbortController();
  const { packed } = await fixture({ signal: controller.signal, yieldTask });
  await packed.parseBatch([
    'G28', 'G21', 'G90', 'M83', 'G0 X10 Y10 Z0.2 F600',
    'G1 X20 E1', 'G1 E-1', 'G2 X30 Y10 Z0.4 I5 J0 F600',
  ]);
  await packed.parseBatch([
    'M82', 'G92 E10', 'T1', 'G1 X35 E11', 'G91', 'G1 X5 E12',
    'G90', 'G0 X100 Y100 Z10', // post-print parking is excluded
  ]);
  const data = await packed.finish();
  assert.deepEqual(data.layers.map(layer => layer.end), [0, 1, 3]);
  assert.ok(data.motion.sourceBytes > 0 && data.motion.sourceBytes < data.motion.rawSourceBytes);
  assert.equal(await data.motion.load(0), null);
  const first = await data.motion.load(1);
  assert.equal(first.duration, 1);
  assert.deepEqual(first.sample(0.5), { x: 15, y: 10, z: Math.fround(0.2), extruding: true });
  const second = await data.motion.load(2);
  assert.equal(second.basis, 'feed');
  const arcSeconds = Math.hypot(5 * Math.PI, 0.2) / 10;
  assert.ok(Math.abs(second.duration - (0.1 + arcSeconds + 1)) < 1e-8);
  assert.deepEqual(second.sample(0), { x: 20, y: 10, z: Math.fround(0.2), extruding: false });
  const middleArc = second.sample((0.1 + arcSeconds / 2) / second.duration);
  assert.ok(Math.abs(middleArc.x - 25) < 1e-6 && Math.abs(middleArc.y - 15) < 1e-6);
  assert.ok(Math.abs(middleArc.z - 0.3) < 1e-6);
  assert.equal(middleArc.extruding, false);
  const end = second.sample(1);
  assert.deepEqual(end, { x: 40, y: 10, z: Math.fround(0.4), extruding: true });
  assert.equal(second.moves, 4);
});

test('packed lazy motion exposes distance seek without inventing missing or partially supplied feed', async () => {
  const { packed } = await fixture({ yieldTask });
  await packed.parseBatch(['G90', 'M83', 'G0 X10 Y10 Z0.2', 'G1 X20 E1', 'G1 X40 E1 F600']);
  const data = await packed.finish();
  const path = await data.motion.load(1);
  assert.equal(path.duration, 0);
  assert.equal(path.distance, 30);
  assert.equal(path.basis, 'distance');
  assert.deepEqual(path.sample(1 / 2), { x: 25, y: 10, z: Math.fround(0.2), extruding: true });
  assert.equal(path.sample(NaN), null);
});

test('packed motion replays exact line ranges across compressed blocks and honors cancellation', async () => {
  const { packed } = await fixture({ yieldTask });
  const lines = ['G90', 'M83', 'G0 X10 Y10 Z0.2 F600'];
  for (let n = 0; n < 15_000; n++) lines.push(`G1 X${n % 2 ? '10.0000' : '11.0000'} E1`);
  lines.push('G0 Z0.4', 'G1 X12 E1');
  for (let i = 0; i < lines.length; i += 512) await packed.parseBatch(lines.slice(i, i + 512));
  const { motion } = await packed.finish();
  assert.ok(motion.rawSourceBytes > 192 * 1024);
  assert.ok(motion.sourceBytes < 5 * 1024);
  const first = await motion.load(1);
  assert.equal(first.moves, 15_000);
  assert.ok(Math.abs(first.duration - 1500) < 1e-6);
  assert.equal(first.sample(1).x, 10);
  const second = await motion.load(2);
  assert.equal(second.moves, 2);
  assert.deepEqual(second.sample(1), { x: 12, y: 10, z: Math.fround(0.4), extruding: true });
  const controller = new AbortController();
  const stop = new Error('canceled stale layer');
  controller.abort(stop);
  await assert.rejects(motion.load(1, { signal: controller.signal }), error => error === stop);
});

test('packed long extrusion arc expansion yields and stops on cancellation', async () => {
  const controller = new AbortController();
  const stop = new Error('canceled dense arc expansion');
  let yielded = false;
  const { packed } = await fixture({
    signal: controller.signal,
    yieldTask: async () => { yielded = true; controller.abort(stop); },
  });
  const arcs = Array(24).fill('G2 I2000 J0 E1');
  await assert.rejects(packed.parseBatch(['G90', 'M83', 'G0 X10 Y10 Z0.2 F600', ...arcs]), error => error === stop);
  assert.equal(yielded, true);
});

test('a supported static plate can distinguish an unsupported travel arc from an empty motion layer', async () => {
  const { packed } = await fixture({ yieldTask });
  await packed.parseBatch([
    'G90', 'M83', 'G0 X10 Y10 Z0.2 F600', 'G1 X20 E1',
    'G18', 'G2 Z0.6 K0.2', 'G17', 'G1 X30 E1',
  ]);
  const { motion, segmentCount } = await packed.finish();
  assert.equal(segmentCount, 2);
  assert.equal(await motion.load(0), null);
  assert.equal((await motion.load(1)).sample(1).x, 20);
  assert.deepEqual(await motion.load(2), { unavailable: 'unsupported-arc', bytes: 0 });
});

test('a layer beyond the decoded move budget leaves other animation layers and static paths usable', async () => {
  const { packed } = await fixture({ yieldTask });
  await packed.parseBatch(['G90', 'M83', 'G0 X10 Y10 Z0.2 F600', 'G1 X20 E1']);
  const travels = Array.from({ length: 500 }, (_, i) => i % 2 ? 'G0 X22' : 'G0 X21');
  for (let i = 0; i < 501; i++) await packed.parseBatch(travels);
  await packed.parseBatch(['G1 X30 E1', 'G0 Z0.4', 'G1 X40 E1']);
  const { motion, segmentCount } = await packed.finish();
  assert.equal(segmentCount, 3);
  assert.deepEqual(await motion.load(1), { unavailable: 'complexity', bytes: 0 });
  assert.equal((await motion.load(2)).sample(1).x, 40);
});
