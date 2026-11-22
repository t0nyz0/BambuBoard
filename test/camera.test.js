const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const ffmpeg = require('ffmpeg-static');
const { ChamberImageStream, buildAuthPacket } = require('../src/lib/chamberImage');
const { buildVideoRouter } = require('../src/routes/video');
const { temporary, listen, certificate, until } = require('./helpers');
test('chamber camera authenticates, assembles split JPEG frames and reconnects', async t => {
  const dir = await temporary(t), cert = await certificate(dir), sockets = new Set();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const header = Buffer.alloc(16); header.writeUIntLE(jpeg.length, 0, 3);
  let connections = 0;
  const camera = tls.createServer(cert, socket => {
    connections++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let auth = Buffer.alloc(0);
    const onAuth = chunk => {
      auth = Buffer.concat([auth, chunk]); if (auth.length < 80) return;
      assert.deepEqual(auth, buildAuthPacket('fixture-only'));
      socket.off('data', onAuth);
      const frame = Buffer.concat([header, jpeg]);
      socket.write(frame.subarray(0, 7));
      setTimeout(() => { if (!socket.destroyed) socket.write(frame.subarray(7, 20)); }, 10);
      setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.concat([frame.subarray(20), frame])); }, 20);
    };
    socket.on('data', onAuth);
  });
  camera.listen(0, '127.0.0.1'); await once(camera, 'listening');
  // Redirect only this test worker's camera connection to the random fixture port.
  const connect = tls.connect;
  t.mock.method(tls, 'connect', (options, callback) => connect({ ...options, port: camera.address().port }, callback));
  const stream = new ChamberImageStream({ host: '127.0.0.1', accessCode: 'fixture-only' });
  const frames = []; stream.on('frame', frame => frames.push(frame)); stream.on('error', () => {});
  t.after(async () => { stream.stop(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => camera.close(resolve)); });
  stream.start(); await until(() => frames.length === 2);
  assert.ok(frames.every(frame => frame.equals(jpeg))); assert.deepEqual(stream.lastFrame, jpeg);
  for (const socket of sockets) socket.destroy();
  await until(() => connections === 2 && frames.length === 4, 8000);
  stream.stop(); await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(connections, 2, 'stopping the camera cancels reconnects');
});

test('H3C Liveview redacts its endpoint and recovers when an authenticated RTSPS feed goes silent', async t => {
  const dir = await temporary(t);
  const dataPath = path.join(dir, 'data.json');
  const code = 'fixture@only';
  const cameraPath = '/streaming/live/fixture';
  const expectedAuth = 'Basic ' + Buffer.from('bblp:' + code).toString('base64');
  const media = execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=30',
    '-t', '6', '-c:v', 'mpeg2video', '-q:v', '4', '-threads', '1', '-an', '-f', 'mpegts', '-',
  ]);
  const peers = new Set();
  let verifiedStream = false;
  let plays = 0, firstFeedSilent = false;
  const camera = tls.createServer(await certificate(dir), socket => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => peers.delete(socket));
    let buffer = Buffer.alloc(0);
    let timer;
    socket.on('close', () => clearInterval(timer));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        // Ignore optional interleaved RTCP frames from the client.
        if (buffer[0] === 0x24) {
          if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt16BE(2)) return;
          buffer = buffer.subarray(4 + buffer.readUInt16BE(2));
          continue;
        }
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const request = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        const [method, uri] = request.split(' ', 2);
        const sequence = request.match(/^CSeq:\s*(\d+)/im)?.[1];
        const respond = (status, headers = [], body = '') => {
          socket.write([`RTSP/1.0 ${status}`, `CSeq: ${sequence}`, ...headers, '', body].join('\r\n'));
        };
        if (method === 'OPTIONS') {
          respond('200 OK', ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN']);
          continue;
        }
        if (request.match(/^Authorization:\s*(.+)/im)?.[1].trim() !== expectedAuth) {
          respond('401 Unauthorized', ['WWW-Authenticate: Basic realm="Fixture"']);
          continue;
        }
        if (method === 'DESCRIBE') {
          verifiedStream = new URL(uri).pathname === cameraPath && new URL(uri).search === '?view=main';
          const sdp = [
            'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Fixture', 'c=IN IP4 127.0.0.1',
            't=0 0', 'a=control:*', 'm=video 0 RTP/AVP 33', 'a=rtpmap:33 MP2T/90000',
            'a=control:trackID=0', '',
          ].join('\r\n');
          respond('200 OK', ['Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`], sdp);
        } else if (method === 'SETUP') {
          respond('200 OK', ['Session: fixture', 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1']);
        } else if (method === 'PLAY') {
          respond('200 OK', ['Session: fixture']);
          if (timer) continue;
          const play = ++plays;
          let offset = 0;
          let index = 0;
          timer = setInterval(() => {
            if (offset >= media.length) {
              clearInterval(timer);
              // Leave the authenticated connection established but starve
              // FFmpeg of further RTP. Its process has no exit to observe.
              if (play === 1) firstFeedSilent = true;
              return;
            }
            const payload = media.subarray(offset, offset + 7 * 188);
            offset += payload.length;
            const header = Buffer.alloc(16);
            header[0] = 0x24;
            header.writeUInt16BE(payload.length + 12, 2);
            header[4] = 0x80;
            header[5] = 33;
            header.writeUInt16BE(index, 6);
            header.writeUInt32BE(index++ * 900, 8);
            header.writeUInt32BE(1, 12);
            socket.write(Buffer.concat([header, payload]));
          }, 5);
        } else respond('200 OK', ['Session: fixture']);
      }
    });
  });
  camera.listen(0, '127.0.0.1');
  await once(camera, 'listening');
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => camera.close(resolve));
  });
  const port = camera.address().port;
  const url = `rtsps://ignored:reported-secret@192.0.2.20:${port}${cameraPath}?view=main`;
  const config = { printer: { type: 'H3C', url: '127.0.0.1', accessCode: code } };
  let cameraTelemetry;
  const app = express();
  const relay = buildVideoRouter({
    app, getConfig: () => config, dataPath, getCameraTelemetry: () => cameraTelemetry,
    relayOptions: { timing: { frameGapMs: 1600, backoffMs: 200, killGraceMs: 250 } },
  });
  t.after(() => relay.stop());
  const base = await listen(t, app);
  const status = async () => (await fetch(base + '/api/printer/video/status')).json();
  // A saved endpoint may belong to the previous printer, so H3C must wait for fresh MQTT.
  await fs.writeFile(dataPath, JSON.stringify({ print: { ipcam: { rtsp_url: url } } }));
  assert.equal((await status()).available, false);
  cameraTelemetry = { rtsp_url: 'disable' };
  assert.match((await status()).hint, /LAN Only Liveview/);
  cameraTelemetry = { rtsp_url: 'rtsp://192.0.2.20/streaming/live/1' };
  assert.equal((await status()).available, false, 'do not send the LAN access code over an insecure RTSP endpoint');
  cameraTelemetry = { rtsp_url: url, resolution: '1080p' };
  const available = await status();
  assert.equal(available.available, true);
  assert.equal(available.state, 'idle');
  assert.equal(available.cameraType, 'rtsp');
  assert.equal(available.resolution, '1080p');
  assert.equal(available.url, null);
  assert.ok(!JSON.stringify(available).includes(code));
  assert.ok(!JSON.stringify(available).includes('192.0.2.20'));
  assert.equal((await fetch(base + '/api/printer/camera.mjpeg')).status, 404);

  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/printer/video');
  ws.binaryType = 'arraybuffer';
  const frames = [];
  ws.onmessage = event => frames.push(Buffer.from(event.data));
  t.after(() => ws.close());
  await until(() => frames.some(frame => frame.length >= 188 && frame[0] === 0x47), 10000);
  await until(async () => (await status()).state === 'streaming');
  assert.ok(verifiedStream, 'the relay uses the reported port and path, the configured host, and its own authenticated session');
  assert.equal(frames[0].subarray(0, 4).toString(), 'jsmp');
  await until(() => firstFeedSilent);
  assert.equal(peers.size, 1, 'the printer has not closed the transport');
  await until(async () => (await status()).state === 'reconnecting');
  const beforeRestart = frames.length;
  await until(async () => plays === 2 && frames.length > beforeRestart && (await status()).state === 'streaming');
  assert.equal(ws.readyState, WebSocket.OPEN, 'the existing viewer receives the replacement stream');
  assert.equal(frames.filter(frame => frame.subarray(0, 4).toString() === 'jsmp').length, 1);
  ws.close();
});
