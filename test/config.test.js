const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { temporary } = require('./helpers');
async function installation(t) {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, 'src'));
  await fs.copyFile(path.join(__dirname, '../src/config.js'), path.join(dir, 'src/config.js'));
  return dir;
}
function load(dir, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BAMBUBOARD_')) delete env[key];
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const config = require('./src/config');
    const loaded = config.load();
    console.log(JSON.stringify({ loaded, firstRun: config.isFirstRun(loaded), public: config.publicSnapshot(loaded), data: config.DATA_DIR }));
  `], { cwd: dir, env: { ...env, ...overrides }, encoding: 'utf8' }).trim().split('\n').at(-1));
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
  const backups = (await fs.readdir(path.join(dir, 'data'))).filter(file => file.endsWith('.bak'));
  assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'data', backups[0]))), legacy);
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
  const saved = { printer: { name: 'Saved H2D', type: 'H2D', url: '127.0.0.1', port: '8883', serialNumber: 'FIXTURE', accessCode: 'fixture-only' }, cloudAuth: { enabled: true } };
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(saved));
  const result = load(dir, { BAMBUBOARD_DATA_DIR: data, BAMBUBOARD_HTTP_PORT: '8099', BAMBUBOARD_FAN_PERCENTAGES: 'true' });
  assert.equal(result.data, data); assert.equal(result.loaded.BambuBoard_httpPort, 8099);
  assert.equal(result.loaded.BambuBoard_displayFanPercentages, true); assert.deepEqual(result.loaded.printer, saved.printer);
  assert.equal(result.loaded.cloudAuth.enabled, true); assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), legacy);
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
  assert.equal(await fs.readFile(path.join(dir, 'data', 'config.json'), 'utf8'), '{damaged', 'Startup must not silently overwrite damaged config');
});
