const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const express = require('express');
const WebSocket = require('ws');
const { buildStreamRouter } = require('../src/routes/stream');
const { settings, encoderArgs, StreamEncoder, StreamError } = require('../src/services/streamEncoder');
const { temporary, listen, until } = require('./helpers');
const KEY = 'fixture-private-key';

function fakeChild({ blocked = false } = {}) {
  const child = new EventEmitter(); child.closed = false; child.exitCode = null;
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { if (!blocked) callback(); }, final(callback) { callback(); queueMicrotask(() => child.exit(0)); } });
  child.stderr = new PassThrough(); child.stdio = [child.stdin, null, child.stderr, new PassThrough()];
  child.exit = (code = 1) => { if (child.closed) return; child.closed = true; child.exitCode = code; child.emit('close', code, null); };
  child.kill = () => { child.exit(1); return true; };
  child.progress = (frame = 30, bytes = 10000) => child.stdio[3].write(`frame=${frame}\nfps=30\ntotal_size=${bytes}\nout_time_us=1000000\nspeed=1.0x\nprogress=continue\n`);
  queueMicrotask(() => child.emit('spawn'));
  return child;
}
async function harness(t, overrides = {}) {
  let streaming; const sockets = [];
  const dir = await temporary({ after: cleanup => t.after(async () => { for (const ws of sockets) ws.terminate(); await streaming?.stop(); await cleanup(); }) }), app = express(); require('express-ws')(app); app.use(express.json());
  const children = [], encoders = [], captures = [], captureHooks = [];
  const factory = options => { const child = fakeChild(); children.push(child); const encoder = new StreamEncoder(options, { spawnEncoder: () => child }); encoders.push(encoder); return encoder; };
  streaming = buildStreamRouter({ app, paths: { data: dir }, createEncoder: factory, createCapture: async hooks => { captureHooks.push(hooks); const capture = { stopped: false, async stop() { this.stopped = true; } }; captures.push(capture); return capture; }, retryDelays: [15, 20, 30], preflight: async () => ({ ok: true, message: 'Fixture check passed.' }), ...overrides });
  const base = await listen(t, app);
  const request = async (route, body, headers = {}) => { const response = await fetch(`${base}/api/stream/youtube/${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, data: await response.json() }; };
  const connect = async (options = {}, headers = {}) => { const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/stream/youtube', { headers }); sockets.push(ws); const messages = []; ws.on('message', data => messages.push(JSON.parse(data.toString()))); await once(ws, 'open'); if (options !== null) ws.send(JSON.stringify({ key: KEY, ...options })); return { ws, messages }; };
  return { dir, app, base, streaming, request, connect, children, encoders, captures, captureHooks };
}

test('YouTube destinations are encrypted and arbitrary destinations and unsupported settings are rejected', () => {
  const primary = settings({ key: KEY }); assert.match(primary.url, /^rtmps:\/\/a\.rtmps\.youtube\.com:443\/live2\//);
  const backup = settings({ key: KEY, destination: 'backup', profile: '1080p60' }); const args = encoderArgs(backup);
  assert.equal(args[args.indexOf('-rtmp_app') + 1], 'live2?backup=1'); assert.equal(args[args.indexOf('-tls_verify') + 1], '1');
  assert.equal(args[args.indexOf('-g') + 1], '120'); assert.equal(args[args.indexOf('-b:v') + 1], '17000k');
  for (const bad of [{ key: 'https://example.com/key' }, { bitrate: 0 }, { bitrate: 100000 }, { profile: '8K' }, { rtmpBase: 'rtmp://example.com/live' }, { source: 'server', profile: '1080p60' }]) assert.throws(() => settings({ key: KEY, ...bad }), StreamError);
  assert.throws(() => settings({ key: KEY, rtmpBase: 'rtmp://example.com/live' }, true));
});

test('video output, rather than process startup, establishes sending status and real encoder metrics', async t => {
  const h = await harness(t); const { ws, messages } = await h.connect(); await until(() => messages.some(m => m.type === 'ready'));
  assert.equal(h.streaming.status().state, 'connecting'); assert.equal(h.streaming.status().outputBytes, undefined);
  ws.send(Buffer.from('fixture-video')); await until(() => h.streaming.status().inputBytes > 0);
  h.children[0].progress(); await until(() => messages.some(m => m.state === 'sending'));
  const state = h.streaming.status(); assert.equal(state.frames, 30); assert.equal(state.outputBytes, 10000); assert.equal(state.speed, 1); assert.equal(state.fps, 30);
  await h.request('stop', { id: state.id }); await until(() => ws.readyState === WebSocket.CLOSED);
  assert.equal((await h.request('status')).data.active, false);
});

test('binary-first and invalid controls never create an encoder', async t => {
  const h = await harness(t);
  for (const data of [Buffer.from('video-before-settings'), '{bad-json', 'x'.repeat(4097), JSON.stringify({ key: KEY, rtmpBase: 'rtmp://malicious.test/live' })]) {
    const { ws, messages } = await h.connect(null); ws.send(data); await until(() => ws.readyState === WebSocket.CLOSED); assert.ok(messages.some(m => m.type === 'error'));
  }
  assert.equal(h.children.length, 0); assert.equal((await h.request('status')).data.active, false);
});

test('concurrent producers and stale stop commands cannot replace or stop the current session', async t => {
  const h = await harness(t); const first = await h.connect(); await until(() => first.messages.some(m => m.type === 'ready'));
  const id = h.streaming.status().id, second = await h.connect(); await until(() => second.messages.some(m => m.code === 'BUSY'));
  assert.equal((await h.request('start', { key: KEY })).status, 409);
  assert.equal((await h.request('stop', { id: 'stale' })).data.error.code, 'SESSION_CHANGED');
  assert.equal(h.streaming.status().id, id); assert.equal(h.children.length, 1);
  await h.request('stop', { id });
});

test('cross-origin WebSockets and POST requests are rejected without starting an encoder', async t => {
  const h = await harness(t); const headers = { Origin: 'https://unrelated.example' };
  const { ws, messages } = await h.connect(null, headers); await until(() => ws.readyState === WebSocket.CLOSED);
  assert.ok(messages.some(m => m.code === 'ORIGIN'));
  for (const route of ['start', 'check', 'stop']) assert.equal((await h.request(route, { key: KEY }, headers)).status, 403);
  assert.equal((await h.request('start', { key: KEY }, { ...headers, 'X-Forwarded-Host': 'unrelated.example' })).status, 403);
  assert.equal((await h.request('check', { source: 'browser' }, { Origin: h.base })).status, 200);
  assert.equal(h.children.length, 0);
});

test('authentication failures are not retried and diagnostics redact split stderr secrets before persistence', async t => {
  const h = await harness(t); await h.request('start', { key: KEY }); await until(() => h.children.length === 1);
  h.children[0].stderr.write('Server rejected rtmps://a.rtmps.youtube.com/live2/fixture-');
  h.children[0].stderr.write('private-key: unauthorized 403; key=fixture-private-key\n'); h.children[0].exit();
  await until(async () => !(await h.request('status')).data.active);
  assert.equal(h.streaming.status().error.code, 'STREAM_KEY'); assert.equal(h.children.length, 1);
  await h.streaming.stop(); const persisted = await fs.readFile(path.join(h.dir, 'stream-diagnostics.json'), 'utf8');
  assert.ok(!persisted.includes(KEY)); assert.ok(!persisted.includes('rtmps://')); assert.match(persisted, /REDACTED/);
  assert.ok(!(JSON.stringify((await h.request('diagnostics')).data)).includes(KEY)); assert.ok(h.captures.every(c => c.stopped));
  // A new app instance can retrieve the last redacted report after restart.
  const app = express(); buildStreamRouter({ app, paths: { data: h.dir } }); const base = await listen(t, app);
  const report = await (await fetch(base + '/api/stream/youtube/diagnostics')).json(); assert.equal(report.session.error.code, 'STREAM_KEY'); assert.ok(!JSON.stringify(report).includes(KEY));
});

test('server network failures recover with bounded retries while retaining capture, then release resources', async t => {
  const h = await harness(t); await h.request('start', { key: KEY }); await until(() => h.captures.length === 1);
  for (let i = 0; i < 4; i++) {
    await until(() => h.children.length === i + 1);
    h.children[i].stderr.write('Connection refused\n'); h.children[i].exit();
    if (i < 3) await until(() => h.children.length === i + 2);
  }
  await until(async () => !(await h.request('status')).data.active);
  assert.equal(h.children.length, 4); assert.equal(h.captures.length, 1); assert.equal(h.streaming.status().attempt, 3);
  assert.equal(h.streaming.status().error.code, 'CONNECTION'); assert.ok(h.captures[0].stopped);
});

test('stopping during recovery cancels the retry and keeps the original session identity', async t => {
  const h = await harness(t, { retryDelays: [300, 300, 300] }); await h.request('start', { key: KEY }); await until(() => h.children.length === 1);
  const id = h.streaming.status().id; h.children[0].stderr.write('Connection reset by peer\n'); h.children[0].exit();
  await until(() => h.streaming.status().state === 'reconnecting'); assert.equal(h.streaming.status().id, id);
  await h.request('stop', { id }); await new Promise(r => setTimeout(r, 350));
  assert.equal(h.children.length, 1); assert.equal(h.streaming.status().state, 'stopped'); assert.ok(h.captures.every(c => c.stopped));
});

test('a capture browser crash restarts capture and encoder, and cancellation closes a delayed capture', async t => {
  const h = await harness(t); await h.request('start', { key: KEY }); await until(() => h.captures.length === 1);
  h.captureHooks[0].onFailure(new StreamError('CAPTURE_BROWSER', 'Fixture capture closed.', true));
  await until(() => h.captures.length === 2); assert.ok(h.captures[0].stopped); assert.equal(h.children.length, 2);
  await h.request('stop', { id: h.streaming.status().id }); assert.ok(h.captures[1].stopped);
  let delayedClosed = false, resolveCapture;
  const delayed = await harness(t, { createCapture: () => new Promise(resolve => { resolveCapture = resolve; }) });
  await delayed.request('start', { key: KEY });
  const stopping = delayed.request('stop', { id: delayed.streaming.status().id });
  await until(() => delayed.streaming.status().state === 'stopping');
  resolveCapture({ async stop() { delayedClosed = true; } }); await stopping;
  assert.ok(delayedClosed); assert.equal((await delayed.request('status')).data.active, false);
});

test('chunk and encoder queue limits stop the producer with actionable errors', async t => {
  for (const [limits, bytes, blocked, code] of [[{ chunk: 16 }, 17, false, 'CHUNK_LIMIT'], [{ queue: 16, chunk: 100 }, 12, true, 'ENCODER_OVERLOADED']]) {
    const child = fakeChild({ blocked }), encoder = new StreamEncoder(settings({ key: KEY }), { spawnEncoder: () => child, limits }); t.after(() => child.kill());
    encoder.start(); await once(encoder, 'ready'); encoder.write(Buffer.alloc(bytes)); if (blocked) encoder.write(Buffer.alloc(bytes));
    assert.equal(encoder.error.code, code); child.kill(); await encoder.done; assert.ok(encoder.finished);
  }
});

test('startup, capture and output stalls have distinct diagnostics and close the encoder', async t => {
  for (const code of ['START_TIMEOUT', 'CAPTURE_STALLED', 'OUTPUT_STALLED']) {
    const child = fakeChild(), encoder = new StreamEncoder(settings({ key: KEY }), { spawnEncoder: () => child, limits: { startup: 20, inputIdle: 20, outputIdle: 20 } }); t.after(() => child.kill());
    encoder.start(); await once(encoder, 'ready');
    if (code !== 'START_TIMEOUT') { encoder.write(Buffer.from('video')); child.progress(); }
    if (code === 'OUTPUT_STALLED') { const timer = setInterval(() => encoder.write(Buffer.from('video')), 10); t.after(() => clearInterval(timer)); }
    await until(() => encoder.error, 2000); assert.equal(encoder.error.code, code); await encoder.done; assert.equal(child.closed, true);
  }
});

test('missing encoder executable fails cleanly instead of leaving a claimed session or leaking its key', async () => {
  const encoder = new StreamEncoder(settings({ key: KEY }), { spawnEncoder() { throw new Error('ENOENT'); } }); encoder.start(); await encoder.done;
  assert.equal(encoder.error.code, 'ENCODER_START'); assert.ok(encoder.finished); assert.equal(encoder.options.key, ''); assert.equal(encoder.options.url, '');
});

test('setup checks do not ingest video and clean shutdown releases the managed session', async t => {
  const h = await harness(t); assert.equal((await h.request('check', { source: 'server' })).data.ok, true); assert.equal(h.children.length, 0);
  await h.request('start', { key: KEY }); await until(() => h.captures.length === 1); assert.equal((await h.request('check', {})).status, 409);
  await h.streaming.stop(); assert.equal((await h.request('status')).data.active, false); assert.ok(h.children.every(c => c.closed)); assert.ok(h.captures.every(c => c.stopped));
  assert.ok(!JSON.stringify((await h.request('diagnostics')).data).includes(KEY));
});
