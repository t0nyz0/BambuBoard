const assert = require('node:assert/strict');
const test = require('node:test');

const color = [0.05, 0.05, 0.05];
const nextTool = [0.18, 0.46, 0.75];

async function modules() {
  const [geometry, three] = await Promise.all([
    import('../public/widgets/gcode-viz/recent-deposition-path.js'),
    import('../public/vendor/three.module.js'),
  ]);
  return { ...geometry, three };
}

test('the accent clips real chords to its screen length and preserves the sampled tip', async () => {
  const { three, createRecentDepositionPath } = await modules();
  const camera = new three.OrthographicCamera(-100, 100, 100, -100, 1, 1000);
  camera.position.z = 100;
  camera.updateMatrixWorld();
  const path = createRecentDepositionPath(camera, null, 800, 600);

  assert.equal(path.add([8, 0, 0], [10, 0, 0], nextTool), true);
  assert.equal(path.add([-25, 0, 0], [8, 0, 0], color), false);
  assert.deepEqual(path.segments(), [
    { from: [1.5, 0, 0], to: [8, 0, 0], color },
    { from: [8, 0, 0], to: [10, 0, 0], color: nextTool },
  ]);
});

test('the recent path accepts a zero-length move without drawing it and stops at a travel gap', async () => {
  const { three, createRecentDepositionPath } = await modules();
  const camera = new three.OrthographicCamera(-250, 250, 250, -250, 1, 1000);
  camera.position.z = 100;
  camera.updateMatrixWorld();
  const path = createRecentDepositionPath(camera, null, 640, 640);
  assert.equal(path.add([4, 1, 0], [4, 1, 0], color), true);
  assert.equal(path.add([0, 1, 0], [4, 1, 0], color), true);
  assert.equal(path.add([-8, 1, 0], [-5, 1, 0], color), false);
  assert.deepEqual(path.segments(), [{ from: [0, 1, 0], to: [4, 1, 0], color }]);

  const restarting = createRecentDepositionPath(camera, null, 640, 640, [8, 1, 0]);
  assert.equal(restarting.add([0, 1, 0], [4, 1, 0], color), false);
  assert.deepEqual(restarting.segments(), [], 'A detached prior extrusion cannot highlight at a fresh tip');
});

test('far-off and extremely fine paths remain bounded', async () => {
  const { three, createRecentDepositionPath, RECENT_DEPOSITION_SEGMENTS } = await modules();
  const camera = new three.OrthographicCamera(-2500, 2500, 2500, -2500, 1, 1000);
  camera.position.z = 100;
  camera.updateMatrixWorld();
  const far = createRecentDepositionPath(camera, null, 640, 640);
  assert.equal(far.add([-250, 0, 0], [0, 0, 0], color), false);
  assert.deepEqual(far.segments()[0].from, [-48, 0, 0]);

  const tiny = createRecentDepositionPath(camera, null, 640, 640);
  for (let index = 0; index < RECENT_DEPOSITION_SEGMENTS; index++) {
    assert.equal(tiny.add([-0.01 * (index + 1), 0, 0], [-0.01 * index, 0, 0], color),
      index + 1 < RECENT_DEPOSITION_SEGMENTS);
  }
  assert.equal(tiny.segments().length, RECENT_DEPOSITION_SEGMENTS);
  assert.equal(tiny.segments().at(-1).to[0], -0);
});

test('perspective clipping remains on an oblique 3D chord and ends at 34 CSS pixels', async () => {
  const { three, createRecentDepositionPath } = await modules();
  const camera = new three.PerspectiveCamera(25, 1, 1, 1000);
  camera.position.set(20, 70, 180);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const path = createRecentDepositionPath(camera, null, 640, 640);
  const tip = [0, 0, 10], prior = [45, 0, -10];

  assert.equal(path.add(prior, tip, color), false);
  const segment = path.segments()[0];
  assert.ok(Math.abs(segment.from[2] - (tip[2] + (prior[2] - tip[2]) * segment.from[0] / prior[0])) < 1e-9);
  const a = new three.Vector3(...segment.from).project(camera);
  const b = new three.Vector3(...segment.to).project(camera);
  assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) * 320 - 34) < 1e-8);
  assert.deepEqual(segment.to, tip);
});
