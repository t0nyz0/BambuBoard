const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const tls = require('node:tls');
const { once } = require('node:events');
const { runInNewContext } = require('node:vm');
const express = require('express');
const packets = require('mqtt-packet');
const { capsFor, printerTypeFromMqtt } = require('../src/lib/caps');
const { createPrinterClient } = require('../src/mqtt');
const { buildApiRouter } = require('../src/routes/api');
const { temporary, listen, certificate, until } = require('./helpers');

// Reduced module shape from ha-bambulab's anonymized H3C_AMS3H fixture.
const sharedBoard = { name: 'ap2', hw_ver: 'AP05', product_name: '' };
const h3cModules = [
  sharedBoard,
  { name: 'n10a', hw_ver: 'N10A05', product_name: 'AMS 3H' },
  { name: 'ota', product_name: 'Bambu Lab H3C' },
];

test('H3C detection prefers the product name and its capabilities match in the browser', async () => {
  const h3c = { type: 'H3C', model: 'Bambu Lab H3C', rawType: 'H3C' };
  assert.deepEqual(printerTypeFromMqtt(h3cModules, 'X1C'), h3c);
  assert.deepEqual(printerTypeFromMqtt(h3cModules.toReversed(), 'X1C'), h3c);
  assert.equal(printerTypeFromMqtt([sharedBoard], 'H3C'), null);
  assert.equal(printerTypeFromMqtt([sharedBoard]).type, 'X1C');
  assert.equal(printerTypeFromMqtt([h3cModules[1]]), null);
  assert.equal(printerTypeFromMqtt([{ product_name: 'Bambu Lab H2C' }, sharedBoard], 'H3C').type, 'H2D');

  const caps = capsFor('H3C');
  assert.ok(caps.hasCameraRtsp);
  assert.ok(caps.hasChamberTemp);
  assert.equal(caps.hasDualNozzle, false);
  assert.equal(caps.hasDualAMS, false);
  assert.deepEqual(caps.bedSize, { x: 330, y: 320, z: 325 });
  const browser = { window: {} };
  runInNewContext(await fs.readFile(path.join(__dirname, '../public/js/caps.js'), 'utf8'), browser);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.window.PRINTER_CAPS.H3C)), caps);
});

test('H3C identity survives partial version reports and MQTT reconnect; explicit product can replace it', async t => {
  const dir = await temporary(t);
  const dataPath = path.join(dir, 'data.json');
  const peers = new Set();
  const detections = [];
  let connections = 0;
  let report;
  const broker = tls.createServer(await certificate(dir), socket => {
    const connection = ++connections;
    peers.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => peers.delete(socket));
    const parser = packets.parser();
    socket.on('data', chunk => parser.parse(chunk));
    const send = packet => socket.write(packets.generate(packet));
    report = payload => send({ cmd: 'publish', topic: 'device/FIXTURE/report', payload: JSON.stringify(payload) });
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      else if (packet.cmd === 'subscribe') {
        send({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
        report({ info: { command: 'get_version', module: connection === 1 ? h3cModules : [sharedBoard] } });
        report({ print: connection === 1
          ? { gcode_state: 'IDLE', layer_num: connection, ipcam: { rtsp_url: 'rtsps://192.0.2.20/streaming/live/1' } }
          : { gcode_state: 'IDLE', layer_num: connection } });
      }
    });
  });
  broker.listen(0, '127.0.0.1');
  await once(broker, 'listening');
  const client = createPrinterClient({
    printer: { serialNumber: 'FIXTURE', type: 'X1', url: '127.0.0.1', port: broker.address().port, accessCode: 'fixture-only' },
    dataPath,
    log: () => {},
    onPrinterDetected: async value => {
      detections.push(value.type);
      if (value.type === 'H3C') throw Object.assign(new Error('fixture write failed'), { code: 'EIO' });
    },
  });
  t.after(async () => {
    client.stop();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => broker.close(resolve));
  });
  async function waitForLayer(layer) {
    await until(async () => {
      try { return JSON.parse(await fs.readFile(dataPath, 'utf8')).print.layer_num === layer; }
      catch (_) { return false; }
    }, 8000);
  }
  client.connect();
  await waitForLayer(1);
  assert.equal(client.detectedModel, 'Bambu Lab H3C');
  report({ info: { command: 'get_version', module: [sharedBoard] } });
  report({ print: { layer_num: 3 } });
  await waitForLayer(3);
  assert.equal(client.detectedType, 'H3C');
  for (const peer of peers) peer.destroy();
  await waitForLayer(2);
  assert.equal(client.status, 'online');
  assert.equal(client.detectedType, 'H3C');
  assert.equal(client.cameraTelemetry.rtsp_url, 'rtsps://192.0.2.20/streaming/live/1');
  assert.deepEqual(detections, ['H3C']);
  report({ info: { command: 'get_version', module: [{ product_name: 'Bambu Lab X1C' }, sharedBoard] } });
  await until(() => client.detectedType === 'X1C');
  assert.deepEqual(detections, ['H3C', 'X1C']);
});

test('printer setup preserves H3C across address changes and clears old detection for a new serial', async t => {
  const data = await temporary(t);
  let config = { cloudAuth: { enabled: false }, printer: {
    name: 'Fixture', type: 'H3C', model: 'Bambu Lab H3C', detectedFrom: 'mqtt',
    url: '192.0.2.1', serialNumber: 'FIXTURE', accessCode: 'fixture-only',
  } };
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter({
    getConfig: () => config,
    saveConfig: update => { config = update(config); },
    reloadPrinter: () => {},
    getStatus: () => ({ connection: 'offline' }),
    paths: { data },
  }));
  const base = await listen(t, app);
  const save = async (printer, expectedStatus = 200) => {
    const response = await fetch(base + '/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer }),
    });
    assert.equal(response.status, expectedStatus);
    return (await fetch(base + '/api/status')).json();
  };
  const types = await (await fetch(base + '/api/printer-types')).json();
  assert.deepEqual(types.find(entry => entry.value === 'H3C').caps, capsFor('H3C'));
  await save({ serialNumber: 'FIXTURE', url: '192.0.2.2' }, 400);
  await save({ serialNumber: 'FIXTURE', port: 8884 }, 400);
  assert.equal(config.printer.url, '192.0.2.1');
  assert.equal(config.printer.accessCode, 'fixture-only');
  let result = await save({ serialNumber: 'FIXTURE', url: '192.0.2.2', accessCode: 'fixture-replacement' });
  assert.equal(result.printer.detectedFrom, 'mqtt');
  assert.equal(result.printer.model, 'Bambu Lab H3C');
  assert.equal(result.printer.type, 'H3C');
  assert.equal(result.printer.url, '192.0.2.2');
  assert.equal(result.printer.accessCode, undefined);
  await save({ serialNumber: 'FIXTURE', url: '192.0.2.2', accessCode: '' });
  assert.equal(config.printer.accessCode, 'fixture-replacement');
  await save({ serialNumber: 'REPLACEMENT', url: '192.0.2.3' }, 400);
  result = await save({ serialNumber: 'REPLACEMENT', url: '192.0.2.3', accessCode: 'new-fixture-code' });
  assert.equal(result.printer.detectedFrom, 'config');
  assert.equal(result.printer.model, null);
  assert.equal(result.printer.type, 'X1');
  result = await save({ serialNumber: 'MANUAL', type: 'H3C', accessCode: 'manual-fixture-code' });
  assert.equal(result.printer.type, 'H3C');
  assert.equal(result.printer.detectedFrom, 'config');
  assert.equal(result.printer.model, null);
});
