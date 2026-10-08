const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const express = require('express');
const { once } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');
const WebSocket = require('ws');
const ffmpeg = require('ffmpeg-static');
const { buildStreamRouter } = require('../src/routes/stream');
const { temporary, listen, until } = require('./helpers');

for (const hasAudio of [false, true]) test(`WebSocket relay produces playable H.264/AAC with ${hasAudio ? 'shared audio' : 'silence'} and stops`, { timeout: 45000 }, async t => {
  let streaming;
  const dir = await temporary({ after: cleanup => t.after(async () => { await streaming?.stop(); await cleanup(); }) }), input = path.join(dir, 'fixture.webm'), output = path.join(dir, 'received.flv');
  const inputArgs = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15'];
  if (hasAudio) inputArgs.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'libopus');
  execFileSync(ffmpeg, [...inputArgs, '-t', '2', '-c:v', 'libvpx', '-threads', '1', '-f', 'webm', input], { stdio: 'pipe', timeout: 10000 });
  const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const rtmpPort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const receiver = spawn(ffmpeg, ['-v', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${rtmpPort}/live/fixture-only`, '-c', 'copy', '-t', '1', '-f', 'flv', output]);
  let receiverError = ''; receiver.stderr.on('data', chunk => { receiverError += chunk; });
  // A failed handshake can leave FFmpeg waiting inside its listener; fixture
  // cleanup must close it unconditionally so failures still finish the suite.
  t.after(() => { if (receiver.exitCode === null) receiver.kill('SIGKILL'); });
  await new Promise(resolve => setTimeout(resolve, 250));
  let socket; t.after(() => socket?.terminate());
  const app = express(); require('express-ws')(app); streaming = buildStreamRouter({ app, paths: { data: dir }, allowLocal: true });
  const base = await listen(t, app);
  socket = new WebSocket(base.replace('http:', 'ws:') + '/api/stream/youtube');
  const messages = []; socket.on('message', message => messages.push(JSON.parse(message.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ key: 'fixture-only', hasAudio, rtmpBase: `rtmp://127.0.0.1:${rtmpPort}/live` }));
  await until(() => messages.some(message => message.type === 'ready'));
  socket.send(await fs.readFile(input));
  // Closing the producer flushes the finite fixture; a real MediaRecorder sends an ongoing stream.
  socket.close(); await once(socket, 'close');
  await until(() => receiver.exitCode !== null, 25000).catch(async error => { throw new Error(error.message + '\n' + await fs.readFile(path.join(dir, 'stream-diagnostics.json'), 'utf8')); });
  assert.equal(receiver.exitCode, 0, receiverError);
  const received = await fs.readFile(output); assert.equal(received.subarray(0, 3).toString(), 'FLV'); assert.ok(received.length > 1000);
  execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { stdio: 'pipe', timeout: 5000 });
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-f', 's16le', '-'], { stdio: 'pipe', timeout: 5000 });
  let energy = 0; for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  const rms = Math.sqrt(energy / (pcm.length / 2)); assert.ok(pcm.length > 4000);
  assert.ok(hasAudio ? rms > 100 : rms < 10, `Unexpected audio RMS ${rms}`);
  if (socket.readyState === WebSocket.OPEN) { socket.close(); await once(socket, 'close'); }
});

test('server Chromium captures the local published scene through RTMP and stops without a browser producer', { timeout: 60000 }, async t => {
  let streaming;
  const dir = await temporary({ after: cleanup => t.after(async () => { await streaming?.stop(); await cleanup(); }) }), output = path.join(dir, 'server.flv');
  const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const receiver = spawn(ffmpeg, ['-v', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/fixture-server`, '-c', 'copy', '-t', '2', '-f', 'flv', output]);
  let errors = ''; receiver.stderr.on('data', b => { errors += b; }); t.after(() => { if (receiver.exitCode === null) receiver.kill('SIGKILL'); });
  await new Promise(r => setTimeout(r, 250));
  const app = express(); app.use(express.json());
  app.get('/live', (_req, res) => res.send('<!doctype html><style>html,body{margin:0;background:#072011;width:100%;height:100%;overflow:hidden}.live-item{height:100vh;display:flex;justify-content:space-between}.edge{width:20%;background:#dd1122}.right{background:#1122dd}</style><div class="live-item"><div class="edge"></div><span>Published scene fixture</span><div class="edge right"></div></div>'));
  streaming = buildStreamRouter({ app, paths: { data: dir }, allowLocal: true });
  const base = await listen(t, app);
  const response = await fetch(base + '/api/stream/youtube/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'fixture-server', rtmpBase: `rtmp://127.0.0.1:${port}/live`, bitrate: 3000 }) });
  assert.equal(response.status, 202); const { session } = await response.json();
  await until(() => streaming.status().outputBytes > 0, 45000).catch(async error => { throw new Error(error.message + '\n' + JSON.stringify(streaming.status()) + '\n' + await fs.readFile(path.join(dir, 'stream-diagnostics.json'), 'utf8')); });
  // No control WebSocket or page is required to keep this producer alive.
  assert.equal(streaming.status().source, 'server'); assert.equal(streaming.status().id, session.id);
  await until(() => receiver.exitCode !== null, 15000); assert.equal(receiver.exitCode, 0, errors);
  await fetch(base + '/api/stream/youtube/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: session.id }) });
  assert.equal(streaming.status().state, 'stopped');
  const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-frames:v', '1', '-vf', 'scale=10:2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 5000 });
  assert.equal(pixels.length, 60); assert.ok(pixels[0] > 150 && pixels[2] < 80, 'left scene edge should be red'); assert.ok(pixels[29] > 150 && pixels[27] < 80, 'right scene edge should be blue');
  execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 5000, stdio: 'pipe' });
});
