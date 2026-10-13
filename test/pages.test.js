const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const express = require('express');
const { buildPagesRouter } = require('../src/routes/pages');
const { temporary, listen, until } = require('./helpers');

const printer = { url: '127.0.0.1', port: 9, serialNumber: 'QA', accessCode: 'fixture-only', type: 'H2D' };

test('management pages work inside a hidden installation directory without exposing dotfiles', async t => {
  const dir = await temporary(t);
  const views = path.join(dir, '.installation', 'views');
  await fs.mkdir(views, { recursive: true });
  const pages = { '/': 'hub.html', '/setup': 'setup.html', '/scene-editor': 'scene-editor.html', '/live': 'live.html', '/login': 'login.html' };
  for (const file of Object.values(pages)) await fs.writeFile(path.join(views, file), `<main>${file}</main>`);
  await fs.writeFile(path.join(views, '.private'), 'private fixture');
  const app = express();
  app.use(buildPagesRouter({ paths: { views }, getConfig: () => ({ printer }) }));
  app.use((error, _req, res, _next) => res.sendStatus(error.status || 500));
  const base = await listen(t, app);
  for (const [route, file] of Object.entries(pages)) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.equal(await response.text(), `<main>${file}</main>`);
  }
  const legacy = await fetch(base + '/scene-editor.html', { redirect: 'manual' });
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/scene-editor');
  const privateFile = await fetch(base + '/.private');
  assert.equal(privateFile.status, 404);
  assert.ok(!(await privateFile.text()).includes('private fixture'));
});

test('server returns saved telemetry from a hidden data directory and handles a missing telemetry file', async t => {
  const dir = await temporary(t);
  const data = path.join(dir, '.runtime');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ printer, cloudAuth: { enabled: false } }));
  const telemetry = { print: { mc_percent: 47, gcode_state: 'RUNNING' } };
  await fs.writeFile(path.join(data, 'data.json'), JSON.stringify(telemetry));
  const reserved = net.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BAMBUBOARD_')) delete env[key];
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server.js')], {
    env: { ...env, PORT: String(port), BAMBUBOARD_DATA_DIR: data }, stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(base + '/api/status')).ok; } catch (_) { return false; } });
  const response = await fetch(base + '/data.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), telemetry);
  await fs.unlink(path.join(data, 'data.json'));
  const missing = await fetch(base + '/data.json');
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), {});
});
