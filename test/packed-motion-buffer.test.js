const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

const firstLayerSample = { elapsedMs: 0, receivedAt: 1, observedAt: 0, advancing: true };

async function fixture(t) {
  const { createPackedMotionBuffer } = await import('../public/widgets/gcode-viz/packed-motion-buffer.js');
  const pending = [];
  const buffer = createPackedMotionBuffer({
    load(index, { signal }) {
      return new Promise((resolve, reject) => pending.push({ index, signal, resolve, reject }));
    },
  }, 3000, () => {});
  t.after(() => buffer.dispose());
  return { buffer, pending };
}

test('motion underflow prioritizes a cold window, then warms its successor and recovers a backward seek', async t => {
  const { buffer, pending } = await fixture(t);
  buffer.select(1400);
  await sleep(0);
  assert.deepEqual(pending.map(work => work.index), [1400]);
  assert.equal(buffer.current(), undefined);
  pending[0].resolve({ bytes: 10 });
  await sleep(0);
  assert.equal(buffer.current().bytes, 10);
  assert.deepEqual(pending.map(work => work.index), [1400, 1401]);
  pending[1].resolve({ bytes: 20 });
  await sleep(0);
  buffer.select(1401);
  assert.equal(buffer.current().bytes, 20);
  await sleep(0);
  buffer.select(7);
  assert.equal(pending[2].signal.aborted, true);
  assert.equal(buffer.current(), undefined);
  pending[2].resolve({ bytes: 999 });
  await sleep(0);
  assert.deepEqual(buffer.stats(), { bytes: 0, layers: [], windows: [], pendingWindow: 7 });
  pending[3].resolve({ bytes: 30 });
  await sleep(0);
  assert.equal(buffer.current().bytes, 30);
  assert.deepEqual(buffer.stats().windows, [7]);
});

test('a temporary request failure retries the same layer and disposal cancels pending warm work', async t => {
  const { buffer, pending } = await fixture(t);
  buffer.select(9);
  await sleep(0);
  pending[0].reject(new Error('temporary'));
  for (let tries = 0; pending.length < 2 && tries < 50; tries++) await sleep(10);
  assert.equal(pending[1].index, 9);
  pending[1].resolve({ bytes: 40 });
  await sleep(0);
  assert.equal(buffer.current().bytes, 40);
  buffer.dispose();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve({ bytes: 888 });
  await sleep(0);
  assert.deepEqual(buffer.stats(), { bytes: 0, layers: [], windows: [], pendingWindow: null });
});

test('live motion uses the latest clock after underflow, freezes across pause, and never loops', async () => {
  const { createPackedNozzlePlayback } = await import('../public/widgets/gcode-viz/packed-nozzle-playback.js');
  let time = 0, release;
  const playback = createPackedNozzlePlayback({
    windowCount: 4,
    layer: () => ({ duration: 10, basis: 'feed', locate: fraction => ({ index: 3, fraction }) }),
    load: () => new Promise(resolve => { release = resolve; }),
  }, () => {}, () => time);
  playback.live(3, firstLayerSample);
  await sleep(0);
  assert.equal(playback.frame().state, 'buffering');
  time = 3000;
  release({ duration: 10, sample: x => ({ x, deposited: x * 100 }) });
  await sleep(0);
  assert.equal(playback.frame().position.x, 0.3);
  playback.pause();
  time = 13000;
  assert.equal(playback.frame().state, 'paused');
  playback.live(3, firstLayerSample);
  assert.equal(playback.frame().position.x, 0.3);
  time = 26000;
  assert.equal(playback.frame().position, null);
  assert.equal(playback.frame().state, 'awaiting-layer');
  assert.equal(playback.frame().deposition.deposited, 100);
  assert.equal(playback.frame().ended, true);
  playback.seek(3, 0);
  assert.equal(playback.frame().position.x, 0);
  playback.seek(3, 1);
  assert.equal(playback.frame().position.x, 1);
  playback.dispose();
});


test('cold viewers wait for an anchor, preserve deposition past nominal end, and resume on the next layer', async t => {
  const { createPackedNozzlePlayback } = await import('../public/widgets/gcode-viz/packed-nozzle-playback.js');
  let time = 100_000;
  const loaded = [];
  const playback = createPackedNozzlePlayback({
    windowCount: 8,
    layer: index => ({
      duration: 20,
      basis: 'feed',
      locate: progress => {
        const window = Math.min(1, Math.floor(progress * 2));
        return { index: index * 2 + window, fraction: progress * 2 - window };
      },
    }),
    load: async index => {
      loaded.push(index);
      return { bytes: 10, sample: fraction => ({ x: index + fraction, deposited: index * 100 + fraction * 100 }) };
    },
  }, () => {}, () => time);
  t.after(playback.dispose);

  playback.live(2, null);
  assert.equal(playback.frame().state, 'waiting');
  assert.deepEqual(loaded, []);

  const sampleAt = (elapsedMs, advancing = true) => ({ elapsedMs, advancing, receivedAt: time, observedAt: time });
  playback.live(2, sampleAt(15_000));
  await sleep(0);
  assert.equal(loaded[0], 5);
  assert.equal(playback.frame().position.x, 5.5);

  time += 1000;
  assert.equal(playback.frame().position.x, 5.6);
  playback.live(2, sampleAt(15_200));
  assert.equal(playback.frame().position.x, 5.6, 'A polling lag cannot rewind sampled deposition');

  time += 5000;
  assert.equal(playback.frame().state, 'awaiting-layer');
  assert.equal(playback.frame().position, null);
  assert.equal(playback.frame().deposition.deposited, 600);
  for (const elapsedMs of [19_500, 22_000, 57_000, 86_000]) {
    time += 35_000;
    playback.live(2, sampleAt(elapsedMs));
    assert.equal(playback.frame().state, 'awaiting-layer');
    assert.equal(playback.frame().deposition.deposited, 600);
  }

  time += 1000;
  playback.pause(2, sampleAt(87_000, false));
  assert.equal(playback.frame().state, 'paused');
  assert.equal(playback.frame().position, null);
  time += 60_000;
  playback.live(2, sampleAt(87_000));
  assert.equal(playback.frame().state, 'awaiting-layer');

  playback.live(2, null);
  assert.equal(playback.frame().state, 'waiting');
  assert.equal(playback.frame().deposition.deposited, 600);
  playback.seek(2, 0);
  assert.equal(playback.frame().state, 'buffering');
  assert.equal(playback.frame().deposition, null);

  time += 1000;
  playback.live(3, sampleAt(2000));
  await sleep(0);
  assert.equal(playback.frame().state, 'ready');
  assert.equal(playback.frame().position.x, 6.2);
});

test('an in-flight warm window becomes active without restarting its decode', async t => {
  const { buffer, pending } = await fixture(t);
  buffer.select(10);
  await sleep(0);
  pending[0].resolve({ bytes: 10 });
  await sleep(0);
  assert.equal(pending[1].index, 11);
  buffer.select(11);
  assert.equal(pending[1].signal.aborted, false);
  assert.equal(buffer.current(), undefined);
  pending[1].resolve({ bytes: 20 });
  await sleep(0);
  assert.equal(buffer.current().bytes, 20);
  assert.deepEqual(pending.map(work => work.index), [10, 11, 12]);
});

test('without a known feed, manual distance seek is available without invented live timing', async () => {
  const { createPackedNozzlePlayback } = await import('../public/widgets/gcode-viz/packed-nozzle-playback.js');
  const endpoint = { x: 1, y: 2, z: 3 };
  const playback = createPackedNozzlePlayback({
    windowCount: 2,
    layer: () => ({ duration: 0, basis: 'distance', locate: fraction => ({ index: 1, fraction }) }),
    load: async () => ({
      bytes: 10,
      sample: (_fraction, basis) => {
        assert.equal(basis, 'distance');
        return endpoint;
      },
    }),
  }, () => {});
  playback.live(1, firstLayerSample);
  await sleep(0);
  assert.equal(playback.frame().state, 'untimed');
  assert.equal(playback.frame().position, null);
  playback.seek(1, 1);
  assert.equal(playback.frame().state, 'buffering');
  await sleep(0);
  assert.equal(playback.frame().position, endpoint);
  playback.dispose();
});

test('repeated decoding failure becomes a bounded unavailable result', async t => {
  const { createPackedMotionBuffer } = await import('../public/widgets/gcode-viz/packed-motion-buffer.js');
  let tries = 0;
  const buffer = createPackedMotionBuffer({
    load: async () => {
      tries++;
      throw new Error('decoder failed');
    },
  }, 2, () => {});
  t.after(() => buffer.dispose());
  buffer.select(1);
  for (let i = 0; i < 100 && !buffer.current(); i++) await sleep(25);
  assert.deepEqual(buffer.current(), { unavailable: 'decode', bytes: 0 });
  await sleep(120);
  assert.equal(tries, 5);
  assert.equal(buffer.stats().pendingWindow, null);
});

test('motion inside one layer catches up after a skipped window and backward seek cancels lookahead', async t => {
  const { createPackedNozzlePlayback } = await import('../public/widgets/gcode-viz/packed-nozzle-playback.js');
  let time = 0;
  const requests = [];
  const playback = createPackedNozzlePlayback({
    windowCount: 140,
    layer: () => ({
      duration: 140,
      basis: 'feed',
      moves: 286_720,
      locate(progress) {
        const point = progress * 140;
        const index = Math.min(139, Math.floor(point));
        return { index, fraction: point - index };
      },
    }),
    load(index, { signal }) {
      return new Promise(resolve => requests.push({ index, signal, resolve }));
    },
  }, () => {}, () => time);
  t.after(playback.dispose);
  const accept = async req => {
    req.resolve({
      bytes: 125_000, layer: 1, moves: 2048,
      sample: fraction => ({ x: req.index + fraction, y: 0, z: 0 }),
    });
    await sleep(0);
  };

  playback.live(1, firstLayerSample);
  await sleep(0);
  await accept(requests[0]);
  assert.equal(playback.frame().position.x, 0);
  assert.equal(requests[1].index, 1);
  time = 124_250;
  assert.equal(playback.frame().state, 'buffering');
  assert.equal(requests[1].signal.aborted, true);
  await sleep(0);
  assert.equal(requests[2].index, 124);
  time = 126_500;
  assert.equal(playback.frame().window, 126);
  assert.equal(requests[2].signal.aborted, true);
  await accept(requests[2]);
  assert.equal(playback.frame().state, 'buffering');
  await accept(requests[3]);
  assert.equal(playback.frame().position.x, 126.5);
  assert.equal(playback.frame().layerMoves, 286_720);

  playback.seek(1, 0.025);
  assert.equal(requests[4].signal.aborted, true);
  await sleep(0);
  assert.equal(requests[5].index, 3);
  await accept(requests[5]);
  assert.equal(playback.frame().position.x, 3.5);
  assert.deepEqual(playback.stats().layers, [1]);
  assert.ok(playback.stats().bytes <= 250_000);
});
