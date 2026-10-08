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
const { archive, ftpsFixture } = require('./ftps-fixture');
test('basic-ftp 6 downloads an implicit-TLS 3MF and yauzl extracts its plate', async t => {
  const gcode = Buffer.from('G90\nG1 X10 Y10 Z0.2 E1\n');
  const fixture = await ftpsFixture(t, { files: { '/cache/Fixture.gcode.3mf': archive({ 'Metadata/plate_1.gcode': gcode }) } });
  const result = await fetchPlateGcode({ host: '127.0.0.1', port: fixture.port, accessCode: 'fixture-only', subtaskName: 'Fixture', plateIdx: 1, model: 'H2D' });
  assert.deepEqual(result, gcode); assert.ok(fixture.commands.some(c => c.verb === 'PROT' && c.arg === 'P')); assert.ok(!fixture.commands.some(c => c.verb === 'LIST'));
});
test('FTPS and missing-plate failures retain actionable errors', async t => {
  const missing = await ftpsFixture(t);
  const options = { host: '127.0.0.1', accessCode: 'fixture-only', subtaskName: 'Fixture', plateIdx: 1, model: 'H2D' };
  await assert.rejects(fetchPlateGcode({ ...options, port: missing.port }), { code: 'FILE_NOT_FOUND', stage: 'discovery' });
  const wrongPlate = await ftpsFixture(t, { files: { '/cache/Fixture.gcode.3mf': archive({ 'Metadata/plate_2.gcode': 'G90' }) } });
  await assert.rejects(fetchPlateGcode({ ...options, port: wrongPlate.port }), { code: 'PLATE_NOT_FOUND' });
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
        send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify({ print: { mc_percent: 47, gcode_state: 'RUNNING', subtask_name: 'Fixture', gcode_file: '/data/Metadata/plate_1.gcode', task_id: '0', ams: { ams: [{ id: '0', tray: [] }] } } }) });
        send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify({ print: { mc_percent: 48, layer_num: 2, ams: { tray_now: '0' } } }) });
      } else if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    });
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const client = createPrinterClient({ printer: { name: 'Fixture', type: 'X1', url: '127.0.0.1', port: broker.address().port, serialNumber: 'FIXTURE', accessCode: 'fixture-only' }, dataPath: path.join(dir, 'data.json'), log: () => {}, onPrinterDetected: value => { detected = value; } });
  t.after(async () => { client.stop(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => broker.close(resolve)); });
  client.connect(); await until(() => client.status === 'online' && detected?.type === 'H2D');
  await until(async () => { try { return JSON.parse(await fs.readFile(path.join(dir, 'data.json'))).print.mc_percent === 48; } catch (_) { return false; } });
  const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(snapshot.print.subtask_name, 'Fixture');
  assert.equal(snapshot.print.gcode_file, '/data/Metadata/plate_1.gcode');
  assert.equal(snapshot.print.ams.ams[0].id, '0');
  assert.equal(snapshot.print.ams.tray_now, '0');
  assert.ok(snapshot.print._bb_job_id); assert.ok(snapshot._bb_received_at);
  assert.equal(detected.type, 'H2D');
  for (const socket of sockets) socket.destroy();
  await until(() => connections === 2 && client.status === 'online', 8000);
  client.stop(); assert.equal(client.status, 'offline');
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(connections, 2, 'stop must cancel pending reconnects');
});
