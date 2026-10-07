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

test('WebSocket relay produces playable H.264/AAC at a loopback RTMP receiver and stops', { timeout: 20000 }, async t => {
  const dir = await temporary(t), input = path.join(dir, 'fixture.webm'), output = path.join(dir, 'received.flv');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '2', '-c:v', 'libvpx', '-threads', '1', '-f', 'webm', input], { stdio: 'pipe', timeout: 10000 });
  const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const rtmpPort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const receiver = spawn(ffmpeg, ['-v', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${rtmpPort}/live/fixture-only`, '-c', 'copy', '-t', '1', '-f', 'flv', output]);
  let receiverError = ''; receiver.stderr.on('data', chunk => { receiverError += chunk; });
  // A failed handshake can leave FFmpeg waiting inside its listener; fixture
  // cleanup must close it unconditionally so failures still finish the suite.
  t.after(() => { if (receiver.exitCode === null) receiver.kill('SIGKILL'); });
  await new Promise(resolve => setTimeout(resolve, 250));
  let socket; t.after(() => socket?.terminate());
  const app = express(); require('rtsp-relay')(app); buildStreamRouter({ app });
  const base = await listen(t, app);
  socket = new WebSocket(base.replace('http:', 'ws:') + '/api/stream/youtube');
  const messages = []; socket.on('message', message => messages.push(JSON.parse(message.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ key: 'fixture-only', rtmpBase: `rtmp://127.0.0.1:${rtmpPort}/live` }));
  await until(() => messages.some(message => message.type === 'started'));
  socket.send(await fs.readFile(input));
  // Closing the producer flushes the finite fixture; a real MediaRecorder sends an ongoing stream.
  socket.close(); await once(socket, 'close');
  await until(() => receiver.exitCode !== null, 10000);
  assert.equal(receiver.exitCode, 0, receiverError);
  const received = await fs.readFile(output); assert.equal(received.subarray(0, 3).toString(), 'FLV'); assert.ok(received.length > 1000);
  execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { stdio: 'pipe', timeout: 5000 });
  if (socket.readyState === WebSocket.OPEN) { socket.close(); await once(socket, 'close'); }
});
