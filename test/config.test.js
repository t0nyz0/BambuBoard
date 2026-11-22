const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { temporary, until } = require('./helpers');
async function installation(t) {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, 'src', 'lib'), { recursive: true });
  await fs.copyFile(path.join(__dirname, '../src/config.js'), path.join(dir, 'src/config.js'));
  await fs.copyFile(path.join(__dirname, '../src/lib/printerConnection.js'), path.join(dir, 'src/lib/printerConnection.js'));
  return dir;
}
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BAMBUBOARD_')) delete env[key];
  return { ...env, ...overrides };
}
function load(dir, overrides = {}, transform = '') {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const config = require('./src/config');
    (async () => {
      const loaded = config.load();
      ${transform}
      console.log(JSON.stringify({ loaded, firstRun: config.isFirstRun(loaded), public: config.publicSnapshot(loaded), recovery: config.needsRecovery(), data: config.DATA_DIR }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: dir, env: cleanEnv(overrides), encoding: 'utf8' }).trim().split('\n').at(-1));
}
test('legacy root config and runtime files migrate with recoverable H2D credentials', async t => {
  const dir = await installation(t);
  const legacy = { BambuBoard_printerURL: '127.0.0.1', BambuBoard_printerSN: 'FIXTURE', BambuBoard_printerAccessCode: 'fixture-only', BambuBoard_printerType: 'H2D', BambuBoard_tempSetting: 'C' };
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy));
  await fs.writeFile(path.join(dir, 'note.json'), '{"content":"Fixture note"}');
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public', 'data.json'), '{"print":{"mc_percent":47}}');
  const result = load(dir);
  assert.equal(result.firstRun, false); assert.equal(result.loaded.printer.type, 'H2D');
  assert.equal(result.loaded.printer.accessCode, 'fixture-only'); assert.equal(result.public.printer.accessCode, '');
  assert.equal(result.public.printer.accessCodeSet, true);
  assert.equal(result.public.BambuBoard_tempSetting, 'Celsius');
  const backups = (await fs.readdir(path.join(dir, 'data'))).filter(file => file.endsWith('.bak'));
  assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'data', backups[0]))), legacy);
  assert.equal((await fs.stat(path.join(dir, 'data', backups[0]))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dir, 'data', 'config.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'data', 'note.json'))).content, 'Fixture note');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'data', 'data.json'))).print.mc_percent, 47);
  await assert.rejects(fs.stat(path.join(dir, 'config.json')), { code: 'ENOENT' });
  assert.equal(load(dir).firstRun, false, 'A second startup preserves the migrated installation');
});
test('explicit runtime directory excludes root migrations and applies only explicit environment overrides', async t => {
  const dir = await installation(t), data = path.join(dir, 'isolated');
  await fs.mkdir(data);
  const legacy = '{"BambuBoard_printerURL":"root-fixture.invalid"}';
  await fs.writeFile(path.join(dir, 'config.json'), legacy);
  await fs.writeFile(path.join(dir, 'note.json'), '{"content":"Root fixture"}');
  const saved = { printer: { name: 'Saved H2D', type: 'H2D', url: '127.0.0.1', port: '8883', serialNumber: 'FIXTURE', accessCode: 'fixture-only' }, cloudAuth: { enabled: true, legacyToken: 'fixture-only' }, BambuBoard_printerAccessCode: 'fixture-only' };
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(saved));
  const result = load(dir, { BAMBUBOARD_DATA_DIR: data, BAMBUBOARD_HTTP_PORT: '8099', BAMBUBOARD_FAN_PERCENTAGES: 'true' });
  assert.equal(result.data, data); assert.equal(result.loaded.BambuBoard_httpPort, 8099);
  assert.equal(result.loaded.BambuBoard_displayFanPercentages, true); assert.deepEqual(result.loaded.printer, saved.printer);
  assert.equal(result.loaded.cloudAuth.enabled, true); assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), legacy);
  assert.deepEqual(result.public.cloudAuth, { enabled: true });
  assert.equal(Object.hasOwn(result.public, 'BambuBoard_printerAccessCode'), false);
  await assert.rejects(fs.stat(path.join(data, 'note.json')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'config.json'))), saved, 'Environment overrides do not rewrite the saved config');
});
test('new and damaged installations return usable first-run defaults', async t => {
  const dir = await installation(t);
  assert.equal(load(dir).firstRun, true);
  await fs.writeFile(path.join(dir, 'data', 'config.json'), '{damaged');
  const result = load(dir);
  assert.equal(result.firstRun, true); assert.equal(result.loaded.printer.url, '');
  assert.equal(result.public.printer.accessCodeSet, false);
  assert.equal(result.recovery, true);
  assert.equal(await fs.readFile(path.join(dir, 'data', 'config.json'), 'utf8'), '{damaged', 'Startup must not silently overwrite damaged config');
});

test('saving recovered settings keeps the original private file and replaces the live config atomically', async t => {
  const dir = await installation(t), data = path.join(dir, 'data');
  await fs.mkdir(data);
  const original = '{"printer":null,"fixture":"private damaged config"}';
  await fs.writeFile(path.join(data, 'config.json'), original);
  const result = load(dir, {}, "if (!config.needsRecovery()) throw Error('recovery not reported'); await config.save({ ...loaded, BambuBoard_tempSetting: 'Fahrenheit' });");
  assert.equal(result.recovery, false);
  const files = await fs.readdir(data);
  const backups = files.filter(file => file.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(data, backups[0]), 'utf8'), original);
  assert.equal((await fs.stat(path.join(data, backups[0]))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(data, 'config.json'))).mode & 0o777, 0o600);
  assert.ok(files.every(file => !file.endsWith('.tmp')));
  assert.equal(load(dir).loaded.BambuBoard_tempSetting, 'Fahrenheit');
});

test('settings validation and failed writes leave the running and saved config stable', async t => {
  const data = await temporary(t);
  const configPath = path.join(data, 'config.json');
  const original = { printer: { name: 'Current', type: 'H2D' }, cloudAuth: { enabled: false } };
  await fs.writeFile(configPath, JSON.stringify(original));
  const marker = path.join(data, 'fail-next-write');
  const preload = path.join(data, 'fixture-failure.js');
  await fs.writeFile(preload, `
    const fs = require('node:fs');
    const rename = fs.promises.rename;
    fs.promises.rename = function (from, to) {
      if (to === ${JSON.stringify(configPath)} && fs.existsSync(${JSON.stringify(marker)})) {
        return Promise.reject(Object.assign(new Error('fixture private disk details'), { code: 'EIO' }));
      }
      return rename.call(this, from, to);
    };`);
  const reserved = net.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const child = spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../src/server.js')], {
    env: cleanEnv({ PORT: String(port), BAMBUBOARD_DATA_DIR: data }), stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  });
  const url = `http://127.0.0.1:${port}/api/settings`;
  await until(async () => { try { return (await fetch(url)).ok; } catch (_) { return false; } });
  const write = body => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  for (const bad of [[], { printer: null }, { printer: { port: -1 } }, { printer: { type: 'unknown' } },
    { BambuBoard_logging: 'true' }, { cloudAuth: { enabled: 1 } }]) assert.equal((await write(bad)).status, 400);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), original);
  await fs.writeFile(marker, 'fail');
  const failedSave = await write({ printer: { name: 'Would fail' } });
  assert.equal(failedSave.status, 500);
  assert.doesNotMatch(await failedSave.text(), /fixture private disk details/);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), original);
  assert.equal((await fetch(url).then(r => r.json())).printer.name, original.printer.name);
  assert.ok((await fs.readdir(data)).every(file => !file.endsWith('.tmp')));
  await fs.unlink(marker);

  const writes = await Promise.all([write({ BambuBoard_tempSetting: 'Celsius' }), write({ BambuBoard_displayFanIcons: false })]);
  assert.ok(writes.every(response => response.ok));
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.BambuBoard_tempSetting, 'Celsius');
  assert.equal(saved.BambuBoard_displayFanIcons, false);
  assert.equal(saved.printer.name, original.printer.name);
  assert.equal(saved.printer.type, original.printer.type);
});
