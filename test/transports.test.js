const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const packets = require('mqtt-packet');
const { fetchPlateGcode } = require('../src/services/printerFiles');
const { createPrinterClient } = require('../src/mqtt');
const { describe: describeGcodeJob } = require('../public/js/gcode-job');
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

test('Cancelling a pending MQTT client preserves cleanup and leaves its replacement active', async t => {
  const dir = await temporary(t);
  const dataPath = path.join(dir, 'data.json');
  const pending = new EventEmitter();
  const replacement = new EventEmitter();
  const onLibraryClose = t.mock.fn();
  const onLibraryError = t.mock.fn();
  pending.on('close', onLibraryClose);
  pending.on('error', onLibraryError);
  pending.end = t.mock.fn(() => pending.emit('close'));
  pending.subscribe = t.mock.fn();
  replacement.subscribe = t.mock.fn();
  replacement.publish = t.mock.fn();
  replacement.end = t.mock.fn();
  const connections = [pending, replacement];
  const log = t.mock.fn();
  const client = createPrinterClient({
    printer: { type: 'H2D', url: 'printer.fixture', serialNumber: 'FIXTURE', accessCode: 'fixture-only' },
    dataPath,
    log,
    connectMqtt: () => connections.shift(),
  });
  t.after(() => client.stop());

  client.connect();
  client.stop();
  assert.deepEqual(pending.end.mock.calls[0].arguments, [true]);
  assert.equal(onLibraryClose.mock.callCount(), 1);
  assert.equal(client.status, 'offline');

  client.connect();
  pending.emit('connect');
  assert.equal(pending.subscribe.mock.callCount(), 0);
  assert.equal(client.status, 'offline');
  replacement.emit('connect');
  assert.equal(replacement.subscribe.mock.callCount(), 1);
  pending.emit('error', new Error('Retired connection closed'));
  assert.equal(onLibraryError.mock.callCount(), 1);
  assert.equal(client.status, 'online');
  assert.equal(log.mock.calls.some(call => call.arguments[0].includes('Reconnecting')), false);

  replacement.emit('message', 'device/FIXTURE/report', JSON.stringify({ print: { gcode_state: 'IDLE', bed_temper: 27 } }));
  await until(() => client.telemetryConnection === 'online');
  const reading = JSON.parse(await fs.readFile(dataPath, 'utf8'));
  assert.equal(reading.print.bed_temper, 27);
});

test('MQTT connects, detects a printer, persists telemetry and reconnects', async t => {
  const dir = await temporary(t), cert = await certificate(dir), sockets = new Set();
  let connections = 0, detected = null, sendReconnectedSnapshot;
  const broker = tls.createServer(cert, socket => {
    connections++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const parser = packets.parser(); socket.on('data', data => parser.parse(data));
    const send = object => socket.write(packets.generate(object));
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      else if (packet.cmd === 'subscribe') {
        send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
        send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify({ info: { command: 'get_version', module: [{ name: 'ota', product_name: 'Bambu Lab H2D' }] } }) });
        if (connections > 1) {
          sendReconnectedSnapshot = print => send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify({ print }) });
          return;
        }
        send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify({ print: { mc_percent: 47, gcode_state: 'RUNNING', subtask_name: 'Fixture', gcode_file: '/data/Metadata/plate_1.gcode', task_id: '0', ams: { ams: [{ id: '0', tray: [] }] }, ipcam: { rtsp_url: 'rtsps://printer.lan/streaming/live/1' } } }) });
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
  assert.equal(snapshot.print.ipcam.rtsp_url, 'enable');
  assert.equal(client.cameraTelemetry.rtsp_url, 'rtsps://printer.lan/streaming/live/1');
  assert.ok(snapshot.print._bb_job_id); assert.ok(snapshot._bb_received_at);
  assert.equal(detected.type, 'H2D');
  assert.equal(client.telemetryConnection, 'online');
  for (const socket of sockets) socket.destroy();
  await until(() => client.telemetryConnection === 'offline');
  await until(() => connections === 2 && client.status === 'online' && sendReconnectedSnapshot, 8000);
  assert.equal(client.telemetryConnection, 'waiting', 'A reconnect must not make the previous on-disk reading live');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')), snapshot);
  sendReconnectedSnapshot({ bed_temper: 60, ipcam: { resolution: '1080p' } });
  await until(() => client.cameraTelemetry?.resolution === '1080p');
  assert.equal(client.telemetryConnection, 'waiting', 'A partial temperature report must not make an old job current');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')), snapshot);
  sendReconnectedSnapshot({ gcode_state: 'RUNNING' });
  await until(() => client.telemetryConnection === 'online');
  const reconnected = JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).print;
  assert.equal(reconnected.bed_temper, 60);
  assert.equal(reconnected.mc_percent, undefined);
  assert.equal(reconnected.gcode_file, undefined);
  assert.equal(reconnected.ams, undefined);
  assert.equal(reconnected._bb_job_pending, true);
  assert.notEqual(reconnected._bb_job_id, snapshot.print._bb_job_id);
  assert.equal(client.cameraTelemetry.rtsp_url, 'rtsps://printer.lan/streaming/live/1');
  sendReconnectedSnapshot({ gcode_file: '/data/Metadata/plate_1.gcode', mc_percent: 52, layer_num: 3 });
  await until(async () => JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).print.mc_percent === 52);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).print._bb_job_pending, true);
  sendReconnectedSnapshot({ subtask_name: 'Fixture' });
  await until(async () => JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).print._bb_job_id === snapshot.print._bb_job_id);
  const resumed = JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).print;
  assert.equal(describeGcodeJob(resumed).key, describeGcodeJob(snapshot.print).key);
  assert.equal(resumed._bb_job_pending, undefined);
  assert.equal(resumed.ams, undefined, 'Old AMS data must not hitch a ride with a restored job identity');
  assert.equal(resumed.mc_percent, 52);
  sendReconnectedSnapshot({ subtask_name: 'Another job', gcode_file: '/data/Metadata/plate_2.gcode' });
  await until(async () => JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).print.subtask_name === 'Another job');
  assert.notEqual(JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).print._bb_job_id, resumed._bb_job_id);
  client.stop(); assert.equal(client.status, 'offline');
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(connections, 2, 'stop must cancel pending reconnects');
});

test('A quiet H2D receives periodic full-state requests while connected', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = await temporary(t), cert = await certificate(dir);
  let requests = 0;
  const broker = tls.createServer(cert, socket => {
    socket.on('error', () => {});
    const parser = packets.parser();
    socket.on('data', data => parser.parse(data));
    const send = packet => socket.write(packets.generate(packet));
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
      if (packet.cmd === 'publish' && JSON.parse(packet.payload.toString()).pushing?.command === 'pushall') {
        requests++;
        const payload = JSON.stringify({ print: { gcode_state: 'IDLE', bed_temper: 27 } });
        send({ cmd: 'publish', topic: 'device/QUIET/report', payload });
      }
    });
  });
  broker.listen(0, '127.0.0.1');
  await once(broker, 'listening');
  const client = createPrinterClient({
    printer: { type: 'H2D', url: '127.0.0.1', port: broker.address().port, serialNumber: 'QUIET', accessCode: 'fixture-only' },
    dataPath: path.join(dir, 'data.json'),
    log: () => {},
  });
  t.after(async () => {
    client.stop();
    await new Promise(resolve => broker.close(resolve));
  });
  client.connect();
  await until(() => requests === 1 && client.telemetryConnection === 'online');
  t.mock.timers.tick(5 * 60 * 1000);
  await until(() => requests === 2);
  assert.equal(client.status, 'online');
  client.stop();
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
});
