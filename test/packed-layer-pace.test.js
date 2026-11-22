const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

function tracks(durations) {
  return {
    windowCount: 300,
    layer(index) {
      const duration = durations[index];
      return duration && { duration, basis: 'feed', locate: fraction => ({ index, fraction }) };
    },
    async load(index) {
      return { bytes: 10, sample: x => ({ x, z: index * 0.2, deposited: Math.floor(x * 1000) }) };
    },
  };
}

const evidence = (samples, speedPercent = 100, layerSpeedStable = true) =>
  ({ speedPercent, layerSpeedStable, samples });

test('layer pace pairs recent comparable physical tracks, excludes outliers and requires corroboration', async () => {
  const { estimateLayerPace } = await import('../public/widgets/gcode-viz/packed-layer-pace.js');
  const source = tracks({ 1: 40, 2: 46, 3: 47, 5: 6, 6: 48, 7: 45, 8: 46, 9: 45, 10: 46 });
  const samples = [
    { layer: 1, durationMs: 72_000 },  // outside the recent window
    { layer: 5, durationMs: 24_000 },  // dissimilar nominal duration
    { layer: 6, durationMs: 76_800 },
    { layer: 6, durationMs: 240_000 }, // repeated layer
    { layer: 7, durationMs: 71_100 },
    { layer: 8, durationMs: 220_000 }, // incompatible with neighboring ratios
    { layer: 9, durationMs: -100 },
    { layer: 10, durationMs: 70_000 }, // current layer is incomplete
  ];
  assert.ok(Math.abs(estimateLayerPace(source, 10, evidence(samples)) - 1.59) < 1e-9);
  assert.equal(estimateLayerPace(source, 10, evidence(samples, 100, false)), 1.25);
  assert.equal(estimateLayerPace(source, 10, evidence([{ layer: 7, durationMs: 71_100 }])), 1.25);
  assert.equal(estimateLayerPace(source, 10, evidence([], 50)), 2.5);
  assert.equal(estimateLayerPace(source, 10, evidence(samples, 0)), 1.25);

  const incompatible = [{ layer: 6, durationMs: 48_000 }, { layer: 7, durationMs: 180_000 }];
  assert.equal(estimateLayerPace(source, 10, evidence(incompatible)), 1.25);
});

test('tail easing starts at the tracked rate, preserves remaining moves and stops at a bounded endpoint', async () => {
  const { estimatedLayerFraction } = await import('../public/widgets/gcode-viz/packed-layer-pace.js');
  assert.equal(estimatedLayerFraction(0.8), 0.8);
  assert.ok(Math.abs((estimatedLayerFraction(0.80001) - 0.8) / 0.00001 - 1) < 0.001);
  assert.ok(estimatedLayerFraction(1) > 0.9 && estimatedLayerFraction(1) < 1);
  assert.ok(estimatedLayerFraction(1.25) > estimatedLayerFraction(1.18));
  assert.equal(estimatedLayerFraction(1.3), 1);
  assert.equal(estimatedLayerFraction(20), 1);
});

test('the recorded 72.289-second H2D age is still moving on its 45.505-second nominal path', async t => {
  const { createPackedNozzlePlayback } = await import('../public/widgets/gcode-viz/packed-nozzle-playback.js');
  const source = tracks({ 98: 46.511, 99: 45.999, 100: 45.505, 101: 43.236 });
  let now = 200_000;
  const playback = createPackedNozzlePlayback(source, () => {}, () => now);
  t.after(playback.dispose);
  // Use synthetic adjacent samples consistent with the measured H2D ratio.
  const pace = evidence([{ layer: 98, durationMs: 74_418 }, { layer: 99, durationMs: 73_138 }]);
  const packet = (elapsedMs, sourcePace = pace, advancing = true) =>
    ({ elapsedMs, observedAt: now, receivedAt: ++now, advancing, pace: sourcePace });

  playback.live(100, packet(72_289));
  await sleep(0);
  const late = playback.frame();
  assert.equal(late.state, 'ready');
  assert.ok(late.paceFactor >= 1.58 && late.paceFactor <= 1.61);
  assert.ok(late.position.x > 0.9 && late.position.x < 0.99);
  assert.equal(late.position.deposited, late.deposition.deposited);

  now += 200;
  playback.live(100, packet(72_100)); // a late poll cannot rewind the visible pose
  assert.ok(playback.frame().position.x >= late.position.x);
  playback.live(100, packet(73_000));
  assert.ok(playback.frame().position.x > late.position.x);

  playback.live(101, packet(0, evidence([...pace.samples, { layer: 100, durationMs: 72_900 }])));
  await sleep(0);
  assert.equal(playback.frame().state, 'ready');
  assert.ok(playback.frame().position.x < 0.001);
  assert.equal(playback.frame().position.z, 101 * 0.2);
});

test('a mid-layer speed switch changes future pace without moving past deposition or restarting an exhausted layer', async t => {
  const { createPackedNozzlePlayback } = await import('../public/widgets/gcode-viz/packed-nozzle-playback.js');
  const source = tracks({ 1: 40, 2: 40, 3: 40 });
  let now = 10_000, receipt = 0;
  const playback = createPackedNozzlePlayback(source, () => {}, () => now);
  t.after(playback.dispose);
  const packet = (elapsedMs, pace, advancing = true) =>
    ({ elapsedMs, observedAt: now, receivedAt: ++receipt, advancing, pace });
  const standard = evidence([]);
  const slower = evidence([], 50, false);
  playback.live(1, packet(20_000, standard));
  await sleep(0);
  assert.equal(playback.frame().position.x, 0.4);

  playback.live(1, packet(20_000, slower));
  assert.equal(playback.frame().position.x, 0.4);
  assert.equal(playback.frame().paceFactor, 2.5);
  now += 10_000;
  assert.equal(playback.frame().position.x, 0.5);

  playback.pause(1, packet(30_000, slower, false));
  now += 500_000;
  assert.equal(playback.frame().state, 'paused');
  assert.equal(playback.frame().deposition.x, 0.5);
  playback.live(1, packet(30_000, slower));
  assert.equal(playback.frame().position.x, 0.5);

  now += 200_000;
  assert.equal(playback.frame().state, 'awaiting-layer');
  playback.live(1, packet(30_001, standard));
  assert.equal(playback.frame().state, 'awaiting-layer');
  assert.equal(playback.frame().position, null);
  assert.equal(playback.frame().deposition.deposited, 1000);

  playback.hide();
  playback.live(1, packet(20_000, slower));
  await sleep(0);
  assert.equal(playback.frame().position.x, 0.4, 'A cold speed switch uses cautious prior positioning');
  playback.live(2, packet(20_000, evidence([], 50)));
  await sleep(0);
  assert.equal(playback.frame().position.x, 0.2, 'A newly observed layer at stable speed gets a new pace');
});
