const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { once } = require('node:events');
const { ChamberImageStream, buildAuthPacket } = require('../src/lib/chamberImage');
const { temporary, certificate, until } = require('./helpers');
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
