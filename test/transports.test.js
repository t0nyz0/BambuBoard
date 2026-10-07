const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const packets = require('mqtt-packet');
const { fetchPlateGcode } = require('../src/services/printerFiles');
const { createPrinterClient } = require('../src/mqtt');
const { temporary, certificate, until } = require('./helpers');
function zipEntry(name, body) {
  let crc = -1;
  for (const value of body) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ -1) >>> 0;
  const filename = Buffer.from(name);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(header.length + filename.length + body.length, 16);
  return Buffer.concat([header, filename, body, central, filename, end]);
}
async function ftpsServer(t, archive, missing = false) {
  const dir = await temporary(t), cert = await certificate(dir);
  const sockets = new Set(), dataServers = [];
  const commands = [];
  const control = tls.createServer(cert, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.write('220 Loopback FTPS fixture\r\n');
    let pending = '', dataSocket = null, retrieved = false;
    const transfer = () => {
      if (!retrieved || !dataSocket) return;
      socket.write('150 Opening data connection\r\n');
      dataSocket.end(archive);
      dataSocket.once('close', () => { if (!socket.destroyed) socket.write('226 Transfer complete\r\n'); });
    };
    socket.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'), line = pending.slice(0, end); pending = pending.slice(end + 2);
        const command = line.split(' ')[0]; commands.push(command);
        if (command === 'USER') socket.write('331 Password required\r\n');
        else if (command === 'PASS') socket.write('230 Logged in\r\n');
        else if (command === 'FEAT') socket.write('211-Features\r\n EPSV\r\n UTF8\r\n211 End\r\n');
        else if (command === 'EPSV') {
          const data = tls.createServer(cert, s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); dataSocket = s; transfer(); });
          dataServers.push(data); data.listen(0, '127.0.0.1', () => socket.write(`229 Entering Extended Passive Mode (|||${data.address().port}|)\r\n`));
        } else if (command === 'RETR') {
          assert.equal(line, 'RETR /cache/Fixture.gcode.3mf');
          if (missing) socket.write('550 File not found\r\n'); else { retrieved = true; transfer(); }
        } else if (command === 'SIZE') socket.write(`213 ${archive.length}\r\n`);
        else if (command === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('200 OK\r\n');
      }
    });
  });
  control.listen(0, '127.0.0.1'); await once(control, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([control, ...dataServers].map(server => new Promise(resolve => server.close(resolve)))); });
  return { port: control.address().port, commands };
}
test('basic-ftp 6 downloads an implicit-TLS 3MF and yauzl extracts its plate', async t => {
  const gcode = Buffer.from('G90\nG1 X10 Y10 Z0.2 E1\n');
  const fixture = await ftpsServer(t, zipEntry('Metadata/plate_1.gcode', gcode));
  const result = await fetchPlateGcode({ host: '127.0.0.1', port: fixture.port, accessCode: 'fixture-only', subtaskName: 'Fixture', plateIdx: 1 });
  assert.deepEqual(result, gcode); assert.ok(fixture.commands.includes('PROT')); assert.ok(!fixture.commands.includes('LIST'));
});
test('FTPS and missing-plate failures retain actionable errors', async t => {
  const missing = await ftpsServer(t, Buffer.alloc(0), true);
  const options = { host: '127.0.0.1', accessCode: 'fixture-only', subtaskName: 'Fixture', plateIdx: 1 };
  await assert.rejects(fetchPlateGcode({ ...options, port: missing.port }), /550.*sliced file not found/);
  const wrongPlate = await ftpsServer(t, zipEntry('Metadata/plate_2.gcode', Buffer.from('G90')));
  await assert.rejects(fetchPlateGcode({ ...options, port: wrongPlate.port }), /entry not found.*plate 1/);
});
test('MQTT connects, detects a printer, persists telemetry and reconnects', async t => {
  const dir = await temporary(t), cert = await certificate(dir), sockets = new Set();
  let connections = 0, detected = null;
  const broker = tls.createServer(cert, socket => {
    connections++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const parser = packets.parser(); socket.on('data', data => parser.parse(data));
    const send = object => socket.write(packets.generate(object));
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      else if (packet.cmd === 'subscribe') {
        send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
        send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify({ info: { command: 'get_version', module: [{ name: 'ota', product_name: 'Bambu Lab H2D' }] } }) });
        send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify({ print: { mc_percent: 47, gcode_state: 'RUNNING' } }) });
      } else if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    });
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const client = createPrinterClient({ printer: { name: 'Fixture', type: 'X1', url: '127.0.0.1', port: broker.address().port, serialNumber: 'FIXTURE', accessCode: 'fixture-only' }, dataPath: path.join(dir, 'data.json'), log: () => {}, onPrinterDetected: value => { detected = value; } });
  t.after(async () => { client.stop(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => broker.close(resolve)); });
  client.connect(); await until(() => client.status === 'online' && detected?.type === 'H2D');
  await until(async () => { try { return JSON.parse(await fs.readFile(path.join(dir, 'data.json'))).print.mc_percent === 47; } catch (_) { return false; } });
  assert.equal(detected.type, 'H2D');
  for (const socket of sockets) socket.destroy();
  await until(() => connections === 2 && client.status === 'online', 8000);
  client.stop(); assert.equal(client.status, 'offline');
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(connections, 2, 'stop must cancel pending reconnects');
});
