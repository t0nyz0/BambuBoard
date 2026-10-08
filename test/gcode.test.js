const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { archive, ftpsFixture } = require('./ftps-fixture');
const { temporary, listen, until } = require('./helpers');
const { fetchPlateGcode, extractPlateGcode, GcodeError, LIMITS, describe } = require('../src/services/printerFiles');
const { buildGcodeRouter } = require('../src/routes/gcode');
const { mergePrint } = require('../src/lib/printTelemetry');
const gcode = Buffer.from('G90\nM83\nG1 X10 Y10 Z0.2 E1\nG1 X40 Y10 E1\nG1 X40 Y40 E1\n');
const options = { host: '127.0.0.1', accessCode: 'fixture-only', subtaskName: 'Fixture', plateIdx: 1, model: 'H2D' };
const telemetry = (name = 'Fixture', extra = {}) => ({ gcode_state: 'RUNNING', task_id: '0', subtask_id: '0', subtask_name: name, gcode_file: '/data/Metadata/plate_1.gcode', _bb_job_id: name, mc_percent: 47, ...extra });
async function routeFixture(t, fetchGcode, extra = {}) {
  let routes;
  t.after(() => routes?.flushDiagnostics());
  const data = await temporary(t), config = { printer: { url: '127.0.0.1', type: 'H2D', accessCode: 'fixture-only', serialNumber: 'FIXTURE' } }, logs = [];
  const write = print => fs.writeFile(path.join(data, 'data.json'), JSON.stringify({ print }));
  await write(telemetry());
  const app = express();
  routes = buildGcodeRouter({ paths: { data }, getConfig: () => config, fetchGcode, log: line => logs.push(line), ...extra });
  app.use('/api/gcode', routes.router);
  const base = await listen(t, app);
  return { data, config, logs, write, get: query => fetch(base + '/api/gcode/current' + (query || '')), diagnostics: () => fetch(base + '/api/gcode/diagnostics').then(r => r.json()), post: (body, query = '') => fetch(base + '/api/gcode/current' + query, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }) };
}

test('printer FTPS uses TLS 1.2, session reuse and protected PASV fallback at the storage root', async t => {
  const fixture = await ftpsFixture(t, { epsvUnsupported: true, files: { '/Fixture.gcode.3mf': archive({ 'Metadata/plate_1.gcode': gcode }) } });
  const events = [];
  assert.deepEqual(await fetchPlateGcode({ ...options, port: fixture.port, onEvent: e => events.push(e) }), gcode);
  assert.deepEqual(fixture.protocols, ['TLSv1.2']);
  assert.ok(fixture.reused.every(Boolean), 'Data channel resumes the control TLS session');
  assert.ok(fixture.commands.some(c => c.verb === 'PASV'));
  assert.ok(fixture.commands.some(c => c.verb === 'PROT' && c.arg === 'P'));
  assert.ok(!fixture.commands.some(c => ['STOR', 'DELE', 'PROT C'].includes(c.verb)));
  assert.ok(events.some(e => e.path === '/Fixture.gcode.3mf' && e.result === 'ok'));
});
test('FTP discovery matches the current filename, handles Unicode/case, and never chooses a newer unrelated file', async t => {
  const fixture = await ftpsFixture(t, { files: { '/model/fiXTure＿Name.gcode.3mf': archive({ 'Metadata/plate_1.gcode': gcode }), '/model/Unrelated.gcode.3mf': archive({ 'Metadata/plate_1.gcode': 'G90\n' }) } });
  const result = await fetchPlateGcode({ ...options, subtaskName: 'Fixture Name', port: fixture.port });
  assert.deepEqual(result, gcode);
  assert.equal(fixture.downloads, 1);
  assert.ok(fixture.commands.some(c => c.verb === 'LIST'));
  assert.ok(!fixture.commands.some(c => c.arg.includes('Unrelated')));
});
test('explicit raw paths work without cloud credentials or guessing an unidentified plate', async t => {
  const fixture = await ftpsFixture(t, { files: { '/Exact name.gcode': gcode, '/cache/Fixture_plate_1.gcode': gcode } });
  const job = describe({ gcode_file: 'file:///sdcard/Exact%20name.gcode', task_id: '0', url: 'https://cloud.invalid/job?token=do-not-forward' });
  assert.deepEqual(await fetchPlateGcode({ ...options, job, port: fixture.port }), gcode);
  assert.ok(!fixture.commands.some(c => c.arg.includes('token=') || c.arg.includes('cloud.invalid')));
  await assert.rejects(fetchPlateGcode({ ...options, job: describe({ subtask_name: 'Fixture' }), port: fixture.port }), { code: 'FILE_NOT_FOUND' });
  assert.ok(!fixture.commands.some(c => c.verb === 'RETR' && c.arg.includes('Fixture_plate_1')), 'An unknown plate cannot silently become plate 1');
});
test('login errors fail promptly with a useful code, without a folder sweep', async t => {
  const fixture = await ftpsFixture(t, { authFailure: true });
  await assert.rejects(fetchPlateGcode({ ...options, port: fixture.port }), { code: 'FTPS_AUTH', retryable: false, stage: 'connect' });
  assert.equal(fixture.connections, 1);
  assert.ok(!fixture.commands.some(c => c.verb === 'SIZE' || c.verb === 'LIST'));
});
test('refused FTPS connections have a network-specific reason and stop before trying filenames', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const events = [];
  await assert.rejects(fetchPlateGcode({ ...options, port, onEvent: event => events.push(event) }), { code: 'FTPS_REFUSED', stage: 'connect', retryable: true });
  assert.equal(events.filter(event => event.result === 'start').length, 1);
  assert.ok(!events.some(event => event.path));
});
test('the packaged read-only FTP self-test reports incomplete configuration without writing secrets or state', async t => {
  const data = await temporary(t);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/ftp-test.js')], { encoding: 'utf8', env: { ...process.env, BAMBUBOARD_DATA_DIR: data, BAMBUBOARD_PRINTER_URL: '', BAMBUBOARD_PRINTER_ACCESS_CODE: 'fixture-only' } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'PRINTER_NOT_CONFIGURED');
  assert.ok(!result.stdout.includes('fixture-only'));
  assert.deepEqual(await fs.readdir(data), []);
});
test('short transfers and missing completion replies retry once then stop', async t => {
  for (const [behavior, code] of [['truncate', 'FILE_TRUNCATED'], ['stallCompletion', 'FTPS_TIMEOUT']]) {
    const fixture = await ftpsFixture(t, { [behavior]: true, files: { '/cache/Fixture.gcode.3mf': archive({ 'Metadata/plate_1.gcode': gcode }) } });
    await assert.rejects(fetchPlateGcode({ ...options, port: fixture.port, limits: { ...LIMITS, timeout: 180, deadline: 2000 } }), { code, retryable: true });
    assert.equal(fixture.connections, 2); assert.equal(fixture.downloads, 2);
  }
});
test('plate selection honors MQTT filenames, multi-plate order and a sole non-1 plate', async () => {
  assert.equal(describe({ plate_idx: 0, plate_id: 1, param: 'Metadata/plate_2.gcode' }).plate, 2);
  const multi = archive({ 'Metadata/plate_2.gcode': gcode, 'Metadata/plate_1.gcode': 'G90\nG1 X90 E1\n' });
  assert.deepEqual(await extractPlateGcode(multi, { plate: 2 }), gcode);
  await assert.rejects(extractPlateGcode(multi, { plate: 3 }), { code: 'PLATE_NOT_FOUND' });
  await assert.rejects(extractPlateGcode(multi, { plateKnown: false }), { code: 'PLATE_AMBIGUOUS' });
  assert.deepEqual(await extractPlateGcode(archive({ 'Metadata/plate_7.gcode': gcode }), { plateKnown: false }), gcode);
});
test('archive validation catches corruption, unsliced projects, checksums and decompression limits', async () => {
  const checksum = createHash('md5').update(gcode).digest('hex').toUpperCase();
  assert.deepEqual(await extractPlateGcode(archive({ 'Metadata/plate_1.gcode': gcode, 'Metadata/plate_1.gcode.md5': checksum })), gcode);
  await assert.rejects(extractPlateGcode(archive({ 'Metadata/plate_1.gcode': gcode, 'Metadata/plate_1.gcode.md5': '0'.repeat(32) })), { code: 'FILE_CORRUPT' });
  const corrupt = archive({ 'Metadata/plate_1.gcode': gcode }); corrupt[30 + Buffer.byteLength('Metadata/plate_1.gcode') + 2] ^= 1;
  await assert.rejects(extractPlateGcode(corrupt), { code: 'FILE_CORRUPT' });
  await assert.rejects(extractPlateGcode(Buffer.from('PKbroken')), { code: 'ARCHIVE_INVALID' });
  await assert.rejects(extractPlateGcode(archive({ '3D/model.model': '<model />' })), { code: 'PLATE_NOT_FOUND' });
  await assert.rejects(extractPlateGcode(archive({ 'Metadata/plate_1.gcode': gcode }), { limits: { ...LIMITS, gcode: 10 } }), { code: 'ARCHIVE_LIMIT' });
  await assert.rejects(extractPlateGcode(archive({ 'Metadata/plate_1.gcode': gcode }), { limits: { ...LIMITS, entries: 0 } }), { code: 'ARCHIVE_LIMIT' });
});
test('MQTT deltas preserve file/AMS metadata and assign a fresh lifecycle to reprints', () => {
  const initial = mergePrint({}, telemetry('First', { ams: { ams: [{ id: '0', tray: [{ id: '0', tray_color: 'FF00AAFF' }] }] } }));
  const delta = mergePrint(initial, { layer_num: 2, bed_temper: 60, ams: { tray_now: '0' } });
  assert.equal(delta.subtask_name, 'First'); assert.equal(delta.gcode_file, initial.gcode_file);
  assert.deepEqual(delta.ams.ams, initial.ams.ams); assert.equal(delta._bb_job_id, initial._bb_job_id);
  const partialAms = mergePrint(delta, { ams: { ams: [{ id: '0', humidity: 2, tray: [{ id: '0', remain: 50 }] }] } });
  assert.equal(partialAms.ams.ams[0].tray[0].tray_color, 'FF00AAFF');
  assert.equal(partialAms.ams.ams[0].tray[0].remain, 50);
  const finished = mergePrint(delta, { gcode_state: 'FINISH', mc_percent: 100 });
  const reprint = mergePrint(finished, { gcode_state: 'PREPARE', mc_percent: 0 });
  assert.notEqual(reprint._bb_job_id, finished._bb_job_id); assert.equal(reprint.subtask_name, undefined); assert.equal(reprint.layer_num, undefined);
  const next = mergePrint(delta, { subtask_id: 'new-job', subtask_name: 'Second' });
  assert.notEqual(next._bb_job_id, delta._bb_job_id); assert.equal(next.gcode_file, undefined);
});
test('concurrent widget requests share one download and the API caches a safe hashed filename', async t => {
  let count = 0;
  const fixture = await routeFixture(t, async () => { count++; await new Promise(r => setTimeout(r, 60)); return gcode; });
  const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => fixture.get(i % 2 ? '?nocache=1' : '')));
  for (const res of replies) { assert.equal(res.status, 200); assert.deepEqual(Buffer.from(await res.arrayBuffer()), gcode); }
  assert.equal(count, 1);
  assert.equal((await fixture.get()).status, 200); assert.equal(count, 1);
  assert.ok((await fs.readdir(path.join(fixture.data, 'gcode-cache'))).every(name => /^[a-f\d]{64}\.gcode$/.test(name)));
  await fixture.write(telemetry('../Second')); assert.equal((await fixture.get()).status, 200); assert.equal(count, 2);
});
test('API error cooldown, manual retry and redacted persistent diagnostics survive a refused connection', async t => {
  let count = 0, clock = Date.now();
  const fixture = await routeFixture(t, async opts => {
    count++; opts.onEvent({ stage: 'connect', result: 'failed', path: '/fixture-only.gcode.3mf' });
    throw new GcodeError('FTPS_REFUSED', 'FTPS refused; fixture-only must never appear in a shared log.', { retryable: true, stage: 'connect' });
  }, { now: () => clock });
  const first = await fixture.get(); assert.equal(first.status, 502);
  const body = await first.json(); assert.equal(body.code, 'FTPS_REFUSED'); assert.ok(body.retryAfterMs >= 15000); assert.ok(!JSON.stringify(body).includes('fixture-only'));
  await Promise.all(Array.from({ length: 10 }, () => fixture.get())); assert.equal(count, 1);
  const report = await fixture.diagnostics(); assert.equal(report.error.stage, 'connect'); assert.equal(report.events[0].stage, 'connect');
  assert.ok(!JSON.stringify(report).includes('fixture-only')); assert.ok(!fixture.logs.join('').includes('fixture-only'));
  await until(async () => { try { return !(await fs.readFile(path.join(fixture.data, 'gcode-diagnostics.json'), 'utf8')).includes('fixture-only'); } catch (_) { return false; } });
  clock += 15001; await fixture.get(); assert.equal(count, 2);
  await fixture.get('?retry=1'); assert.equal(count, 3);
  fixture.config.printer.accessCode = 'corrected-fixture'; await fixture.get(); assert.equal(count, 4, 'Credential correction invalidates negative cache');
});
test('a new print cancels stale transfers and cannot reuse a zero task ID cache', async t => {
  const pending = [];
  const fixture = await routeFixture(t, opts => new Promise(resolve => pending.push({ opts, resolve })));
  const old = fixture.get(); await until(() => pending.length === 1);
  await fixture.write(telemetry('Second'));
  const next = fixture.get(); await until(() => pending.length === 2);
  assert.equal(pending[0].opts.signal.aborted, true);
  pending[0].resolve(gcode); pending[1].resolve(gcode);
  assert.equal((await old).status, 409); assert.equal((await next).status, 200);
  assert.equal((await fs.readdir(path.join(fixture.data, 'gcode-cache'))).length, 1);
  const mismatch = await fixture.get('?job=' + encodeURIComponent(describe(telemetry()).key));
  assert.equal(mismatch.status, 409); assert.equal(pending.length, 2);
});
test('manual sliced-file recovery feeds all widget clients while preserving a valid cache on bad uploads', async t => {
  let count = 0;
  const fixture = await routeFixture(t, async () => { count++; throw new GcodeError('FILE_NOT_FOUND', 'Internal storage cannot be downloaded.', { retryable: true }); });
  assert.equal((await fixture.get()).status, 502);
  const uploaded = await fixture.post(archive({ 'Metadata/plate_1.gcode': gcode }));
  assert.equal(uploaded.status, 200); assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), gcode);
  assert.equal((await fixture.get()).status, 200); assert.equal(count, 1);
  assert.equal((await fixture.diagnostics()).source, 'manual');
  assert.equal((await fixture.post(archive({ 'Metadata/plate_2.gcode': gcode }))).status, 502);
  assert.deepEqual(Buffer.from(await fixture.get().then(r => r.arrayBuffer())), gcode);
  await fixture.write(telemetry('Different'));
  assert.equal((await fixture.post(gcode, '?job=' + encodeURIComponent(describe(telemetry()).key))).status, 409, 'An upload started for an older print is rejected');
  assert.equal((await fixture.get()).status, 502); assert.equal(count, 2);
});
test('missing telemetry/configuration produce explicit errors, not generic waiting responses', async t => {
  const fixture = await routeFixture(t, async () => gcode);
  await fs.writeFile(path.join(fixture.data, 'data.json'), '{partial');
  let response = await fixture.get(); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'TELEMETRY_UNAVAILABLE');
  await fixture.write(telemetry()); fixture.config.printer.accessCode = '';
  response = await fixture.get(); assert.equal(response.status, 422); assert.equal((await response.json()).code, 'PRINTER_NOT_CONFIGURED');
  await fixture.write({ gcode_state: 'IDLE' }); response = await fixture.get(); assert.equal(response.status, 404);
});
