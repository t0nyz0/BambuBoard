const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: sleep } = require('node:timers/promises');
const express = require('express');
const { buildVideoRouter } = require('../src/routes/video');
const { listen, until } = require('./helpers');

const header = Buffer.from([0x6a, 0x73, 0x6d, 0x70, 0, 0, 0, 0]);
function packet(marker) {
  const bytes = Buffer.alloc(188, marker);
  bytes[0] = 0x47;
  return bytes;
}

async function fixture(t, { timing, onSpawn } = {}) {
  const app = express();
  const printer = { type: 'H2D', url: 'printer-a.invalid', accessCode: 'fixture-only' };
  const report = { rtsp_url: 'enable' };
  const children = [];
  function spawn(_binary, args, options) {
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'pipe']);
    assert.equal(args[args.indexOf('-progress') + 1], 'pipe:3');
    assert.equal(args.includes('-nostdin'), true);
    const child = new EventEmitter();
    child.source = new URL(args[args.indexOf('-i') + 1]);
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.progress = new PassThrough();
    child.stdio = [null, child.stdout, child.stderr, child.progress];
    child.signals = [];
    const plan = onSpawn?.(children.length) || {};
    child.close = () => {
      child.stdout.end(); child.stderr.end(); child.progress.end();
      queueMicrotask(() => child.emit('close'));
    };
    child.kill = signal => {
      child.signals.push(signal);
      if (!plan.stubborn || signal === 'SIGKILL') child.close();
    };
    child.reportFrame = n => child.progress.write(`frame=${n}\nprogress=continue\n`);
    child.writeFrame = (n, media) => { child.stdout.write(media); child.reportFrame(n); };
    children.push(child);
    if (plan.exit) setImmediate(child.close);
    return child;
  }

  const routes = buildVideoRouter({
    app, getConfig: () => ({ printer }), getCameraTelemetry: () => report,
    relayOptions: {
      spawn,
      timing: { firstFrameMs: 200, frameGapMs: 120, backoffMs: 70, maxBackoffMs: 220,
        killGraceMs: 30, graceMs: 80, refreshMs: 30, ...timing },
    },
  });
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await routes.stop();
  });
  const base = await listen(t, app);
  return {
    printer, report, children, routes,
    status: async () => (await fetch(base + '/api/printer/video/status')).json(),
    async connect() {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/printer/video');
      sockets.add(socket);
      socket.binaryType = 'arraybuffer';
      const messages = [];
      socket.addEventListener('message', ({ data }) => messages.push(Buffer.from(data)));
      await until(() => messages.length);
      assert.deepEqual(messages[0], header);
      return { socket, messages };
    },
  };
}

test('a header and frame counter without media cannot pass startup; existing viewers recover together', async t => {
  const camera = await fixture(t, { timing: { backoffMs: 180 }, onSpawn: i => ({ stubborn: i === 0 }) });
  assert.equal((await camera.status()).state, 'idle');
  const one = await camera.connect();
  const two = await camera.connect();
  assert.equal(camera.children.length, 1, 'two real WebSockets share one child');
  const first = camera.children[0];
  first.reportFrame(3);
  first.stdout.write(packet(0x40).subarray(0, 17));
  assert.equal((await camera.status()).state, 'connecting');
  assert.deepEqual(one.messages, [header]);
  assert.deepEqual(two.messages, [header]);
  await until(() => first.signals.length > 0);
  assert.equal((await camera.status()).state, 'reconnecting');
  await until(() => camera.children.length === 2);
  assert.deepEqual(first.signals, ['SIGTERM', 'SIGKILL']);

  const second = camera.children[1];
  const media = packet(0x41);
  second.reportFrame(1);
  second.stdout.write(media.subarray(0, 37));
  assert.equal((await camera.status()).state, 'reconnecting');
  second.stdout.write(media.subarray(37));
  await until(() => one.messages.length === 2 && two.messages.length === 2);
  assert.equal((await camera.status()).state, 'streaming');
  assert.deepEqual(one.messages, [header, media]);
  assert.deepEqual(two.messages, [header, media]);
  assert.equal(one.socket.readyState, WebSocket.OPEN);
  assert.equal(two.socket.readyState, WebSocket.OPEN);
});

test('a stationary frame counter cannot keep the live relay healthy even when transport bytes continue', async t => {
  const camera = await fixture(t, { timing: { backoffMs: 130 } });
  const viewer = await camera.connect();
  const first = camera.children[0];
  first.writeFrame(1, packet(0x42));
  await until(async () => (await camera.status()).state === 'streaming');
  const duplicates = setInterval(() => {
    if (!first.signals.length) first.writeFrame(1, packet(0x42));
  }, 16);
  t.after(() => clearInterval(duplicates));
  await until(() => first.signals.length > 0);
  assert.deepEqual(first.signals, ['SIGTERM']);
  assert.equal((await camera.status()).state, 'reconnecting');
  await until(() => camera.children.length === 2);
  const replacement = packet(0x43);
  camera.children[1].writeFrame(1, replacement);
  await until(() => viewer.messages.some(message => message.equals(replacement)));
  assert.equal((await camera.status()).state, 'streaming');
  assert.equal(viewer.socket.readyState, WebSocket.OPEN);
});

test('backoff survives status polls and additional viewers, and a changed source supersedes old work', async t => {
  const camera = await fixture(t, {
    timing: { backoffMs: 180, maxBackoffMs: 320, retriesBeforeUnavailable: 2 }, onSpawn: i => ({ exit: i < 2 }),
  });
  const viewer = await camera.connect();
  assert.equal(camera.children.length, 1);
  await until(async () => (await camera.status()).state === 'reconnecting');
  const other = await camera.connect();
  for (let n = 0; n < 5; n++) await camera.status();
  assert.equal(camera.children.length, 1, 'extra viewers and polls cannot bypass the retry timer');
  await until(async () => (await camera.status()).state === 'unavailable');
  assert.equal(camera.children.length, 2);
  assert.equal((await camera.status()).available, true, 'configuration is ready even when video has failed');
  camera.printer.url = 'printer-b.invalid';
  camera.printer.accessCode = 'test@new';
  assert.equal((await camera.status()).state, 'connecting');
  assert.equal(camera.children.length, 3);
  const latest = camera.children[2];
  assert.equal(latest.source.hostname, 'printer-b.invalid');
  assert.equal(decodeURIComponent(latest.source.password), 'test@new');
  latest.writeFrame(1, packet(0x44));
  await until(() => viewer.messages.length === 2 && other.messages.length === 2);
  assert.equal((await camera.status()).state, 'streaming');
  camera.report.rtsp_url = 'disable';
  assert.equal((await camera.status()).state, 'unavailable');
  assert.equal((await camera.status()).available, false);
  await until(() => latest.signals.length > 0);
  assert.deepEqual(latest.signals, ['SIGTERM']);
  assert.deepEqual(viewer.messages, [header, packet(0x44)]);
  await sleep(340);
  assert.equal(camera.children.length, 3, 'old retry and stale process events never restart the old feed');
});

test('a brief viewer gap reuses the camera child, then the grace timer releases it', async t => {
  const camera = await fixture(t, { timing: { graceMs: 150, frameGapMs: 600 } });
  const first = await camera.connect();
  camera.children[0].writeFrame(1, packet(0x45));
  await until(async () => (await camera.status()).state === 'streaming');
  let close = once(first.socket, 'close');
  first.socket.close(); await close;
  const second = await camera.connect();
  assert.equal(camera.children.length, 1);
  camera.children[0].writeFrame(2, packet(0x46));
  await until(() => second.messages.length === 2);
  close = once(second.socket, 'close');
  second.socket.close(); await close;
  await until(() => camera.children[0].signals.length > 0);
  assert.deepEqual(camera.children[0].signals, ['SIGTERM']);
  assert.equal((await camera.status()).state, 'idle');
  assert.equal(camera.children.length, 1);
});
