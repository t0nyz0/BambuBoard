const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { buildVideoRouter } = require('../src/routes/video');
const { temporary, listen } = require('./helpers');

test('H2D relay stays available while a reconnect supplies partial print telemetry', async t => {
  const dir = await temporary(t);
  const dataPath = path.join(dir, 'data.json');
  const app = express();
  const printer = { type: 'H2D', url: '192.0.2.20', accessCode: 'fixture-only' };
  const camera = { rtsp_url: 'rtsps://192.0.2.20:322/streaming/live/1', resolution: '1080p' };
  let cameraTelemetry;
  buildVideoRouter({ app, getConfig: () => ({ printer }), dataPath, getCameraTelemetry: () => cameraTelemetry });
  const base = await listen(t, app);
  const status = async () => (await fetch(base + '/api/printer/video/status')).json();

  const unknown = await status();
  assert.equal(unknown.available, false);
  assert.equal(unknown.waitingForReport, true);
  assert.match(unknown.hint, /Waiting.*camera status/);
  await fs.writeFile(dataPath, JSON.stringify({ print: { ipcam: { rtsp_url: 'disable' } } }));
  assert.match((await status()).hint, /Waiting.*camera status/, 'A saved disable flag may belong to another printer');
  await fs.writeFile(dataPath, JSON.stringify({ print: { ipcam: { ...camera, rtsp_url: 'enable' } } }));
  assert.equal((await status()).available, true, 'previous reports still support startup');
  cameraTelemetry = { resolution: '720p' };
  const startup = await status();
  assert.equal(startup.available, true, 'a partial startup report can keep the saved availability');
  assert.equal(startup.resolution, '720p');
  cameraTelemetry = camera;
  await fs.writeFile(dataPath, JSON.stringify({ print: { gcode_state: 'RUNNING' } }));
  assert.equal((await status()).available, true, 'a print-only snapshot leaves the camera ready');
  assert.equal((await status()).resolution, '1080p');

  await fs.writeFile(dataPath, JSON.stringify({ print: { ipcam: { ...camera, rtsp_url: 'enable' } } }));
  cameraTelemetry = { ...camera, rtsp_url: 'disable' };
  const disabled = await status();
  assert.equal(disabled.available, false, 'a new camera status supersedes the previous report');
  assert.equal(disabled.waitingForReport, false);
  assert.match(disabled.hint, /reports LAN Only Liveview is off/);
});
