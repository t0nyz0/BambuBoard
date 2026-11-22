const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

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

test('motion underflow prioritizes a cold layer, then warms its successor and recovers a backward seek', async t => {
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
  assert.deepEqual(buffer.stats(), { bytes: 0, layers: [], pending: 7 });
  pending[3].resolve({ bytes: 30 });
  await sleep(0);
  assert.equal(buffer.current().bytes, 30);
  assert.deepEqual(buffer.stats().layers, [7]);
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
  assert.deepEqual(buffer.stats(), { bytes: 0, layers: [], pending: null });
});

test('live motion uses the latest clock after underflow, freezes across pause, and never loops', async () => {
  const { createPackedNozzlePlayback } = await import('../public/widgets/gcode-viz/packed-nozzle-playback.js');
  let time = 0, release;
  const playback = createPackedNozzlePlayback({
    load: () => new Promise(resolve => { release = resolve; }),
  }, 4, () => {}, () => time);
  playback.live(3);
  await sleep(0);
  assert.equal(playback.frame().state, 'buffering');
  time = 3000;
  release({ duration: 10, sample: f => f });
  await sleep(0);
  assert.equal(playback.frame().position, 0.3);
  playback.pause();
  time = 13000;
  assert.equal(playback.frame().state, 'paused');
  playback.live(3);
  assert.equal(playback.frame().position, 0.3);
  time = 26000;
  assert.equal(playback.frame().position, 1);
  assert.equal(playback.frame().ended, true);
  playback.seek(3, 0);
  assert.equal(playback.frame().position, 0);
  playback.seek(3, 1);
  assert.equal(playback.frame().position, 1);
  playback.dispose();
});

test('an in-flight warm layer becomes active without restarting its decode', async t => {
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
    load: async () => ({ bytes: 10, duration: 0, sample: () => endpoint }),
  }, 2, () => {});
  playback.live(1);
  await sleep(0);
  assert.equal(playback.frame().state, 'untimed');
  assert.equal(playback.frame().position, null);
  playback.seek(1, 1);
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
  assert.equal(buffer.stats().pending, null);
});
