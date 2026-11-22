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
const { mergePrint, reconnectJob, reuseJobId } = require('../src/lib/printTelemetry');
const { calibrationStatus } = require('../public/js/gcode-job');
const gcode = Buffer.from('G90\nM83\nG1 X10 Y10 Z0.2 E1\nG1 X40 Y10 E1\nG1 X40 Y40 E1\n');
const options = { host: '127.0.0.1', accessCode: 'fixture-only', subtaskName: 'Fixture', plateIdx: 1, model: 'H2D' };
const telemetry = (name = 'Fixture', extra = {}) => ({ gcode_state: 'RUNNING', task_id: '0', subtask_id: '0', subtask_name: name, gcode_file: '/data/Metadata/plate_1.gcode', _bb_job_id: name, mc_percent: 47, ...extra });
const calibrationName = 'auto_cali_for_user_param.gcode';
const calibrationPath = '/usr/etc/print/' + calibrationName;
const systemCalibration = { gcode_state: 'RUNNING', task_id: '0', subtask_id: '0',
  subtask_name: calibrationName, gcode_file: calibrationName, print_type: 'system', stg_cur: 25, mc_percent: 16 };
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
  return { data, config, logs, write, get: (query = '', init) => fetch(base + '/api/gcode/current' + query, init),
    progress: () => fetch(base + '/api/gcode/progress'), diagnostics: () => fetch(base + '/api/gcode/diagnostics').then(r => r.json()),
    post: (body, query = '') => fetch(base + '/api/gcode/current' + query, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }) };
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
test('H3C tries explicit archive paths first and prefers /cache for bare filenames', async t => {
  const basename = 'H3C job.gcode.3mf';
  const old = Buffer.from('G90\nG1 X99 Y99 Z0.2 E1\n');
  const oldArchive = archive({ 'Metadata/plate_2.gcode': old });
  const fixture = await ftpsFixture(t, { files: {
    ['/cache/' + basename]: archive({ 'Metadata/plate_1.gcode': old, 'Metadata/plate_2.gcode': gcode }),
    ['/' + basename]: oldArchive,
  } });
  const h3c = { ...options, model: 'Bambu Lab H3C', port: fixture.port };
  assert.deepEqual(await fetchPlateGcode({ ...h3c, job: describe({ gcode_file: basename, plate_idx: 2 }) }), gcode);
  assert.deepEqual(await fetchPlateGcode({ ...h3c, job: describe({ gcode_file: '/' + basename, plate_idx: 2 }) }), old);
  assert.deepEqual(fixture.commands.filter(c => c.verb === 'RETR').map(c => c.arg), ['/cache/' + basename, '/' + basename]);
});
test('explicit raw paths work without cloud credentials or guessing an unidentified plate', async t => {
  const fixture = await ftpsFixture(t, { files: { '/Exact name.gcode': gcode, '/cache/Fixture_plate_1.gcode': gcode } });
  const job = describe({ gcode_file: 'file:///sdcard/Exact%20name.gcode', task_id: '0', url: 'https://cloud.invalid/job?token=do-not-forward' });
  const limits = { ...LIMITS, archive: gcode.length - 1 };
  assert.deepEqual(await fetchPlateGcode({ ...options, job, port: fixture.port, limits }), gcode);
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
test('FTPS keeps transferring a toolpath that progresses past the lookup deadline', async t => {
  const raw = Buffer.concat([gcode, Buffer.from('; preview progress fixture\n'.repeat(330))]);
  const fixture = await ftpsFixture(t, { files: { '/Slow.gcode': raw }, slowData: { bytes: 512, interval: 60 } });
  const events = [];
  const start = Date.now();
  const result = await fetchPlateGcode({ ...options, job: describe({ gcode_file: '/Slow.gcode' }), port: fixture.port,
    limits: { ...LIMITS, timeout: 400, deadline: 650 }, onEvent: event => events.push(event) });
  assert.ok(Date.now() - start >= 650);
  assert.deepEqual(result, raw);
  const progress = events.filter(event => event.stage === 'download' && event.result === 'progress');
  assert.ok(progress.length > 2);
  assert.equal(progress.at(-1).bytes, raw.length);
  assert.equal(fixture.downloads, 1);
});
test('plate selection honors MQTT filenames, multi-plate order and a sole non-1 plate', async () => {
  assert.equal(describe({ plate_idx: 0, plate_id: 1, param: 'Metadata/plate_2.gcode' }).plate, 2);
  const multi = archive({ 'Metadata/plate_2.gcode': gcode, 'Metadata/plate_1.gcode': 'G90\nG1 X90 E1\n' });
  assert.deepEqual(await extractPlateGcode(multi, { plate: 2 }), gcode);
  await assert.rejects(extractPlateGcode(multi, { plate: 3 }), { code: 'PLATE_NOT_FOUND' });
  await assert.rejects(extractPlateGcode(multi, { plateKnown: false }), { code: 'PLATE_AMBIGUOUS' });
  assert.deepEqual(await extractPlateGcode(archive({ 'Metadata/plate_7.gcode': gcode }), { plateKnown: false }), gcode);
});
test('only the reserved firmware path identifies the built-in calibration', async t => {
  for (const locator of [{ gcode_file: calibrationPath }, { param: 'file://' + calibrationPath }, { url: 'file://' + calibrationPath }]) {
    const active = { ...locator, gcode_state: 'RUNNING' };
    assert.equal(describe(active).calibrating, true);
    assert.equal(describe(active).available, false);
    assert.equal(calibrationStatus(active), 'Calibrating');
    const completed = { ...active, gcode_state: 'FINISH' };
    assert.equal(describe(completed).calibration, true);
    assert.equal(describe(completed).calibrating, false);
    assert.equal(calibrationStatus(completed), 'Calibration complete');
  }
  for (const locator of [{ subtask_name: calibrationName }, { gcode_file: calibrationName },
    { gcode_file: '/cache/' + calibrationName }, { gcode_file: calibrationPath + '.3mf' },
    { subtask_name: calibrationName, gcode_file: 'https://fixture.invalid' + calibrationPath }]) {
    assert.equal(describe({ ...locator, gcode_state: 'RUNNING', stg_cur: 25 }).calibration, false);
    assert.equal(describe(locator).available, true);
  }
  const fixture = await ftpsFixture(t, {});
  await assert.rejects(fetchPlateGcode({ ...options, port: fixture.port, job: describe({ gcode_file: calibrationPath }) }),
    { code: 'CALIBRATING', retryable: false, stage: 'telemetry' });
  assert.equal(fixture.connections, 0);
});
test('bare firmware calibration needs an exact identity and corroborating system report for this job', () => {
  const confirmed = mergePrint({}, systemCalibration);
  assert.equal(describe(confirmed).bareCalibration, true);
  assert.equal(describe(confirmed).available, false);
  assert.equal(calibrationStatus(confirmed), 'Calibrating');
  assert.equal(calibrationStatus(mergePrint(confirmed, { gcode_state: 'FINISH' })), 'Calibration complete');

  const { print_type: _omitted, ...bareJob } = systemCalibration;
  for (const variant of [bareJob, { ...bareJob, print_type: 'local' }, { ...bareJob, print_type: 'cloud' },
    { ...bareJob, print_type: 'SYSTEM' }, { ...bareJob, print_type: '' }, { ...bareJob, print_type: null },
    { ...systemCalibration, subtask_name: 'A different job' }, { ...systemCalibration, subtask_name: ' ' + calibrationName },
    { ...systemCalibration, gcode_file: '/cache/' + calibrationName }, { ...systemCalibration, gcode_file: './' + calibrationName },
    { ...systemCalibration, param: '/cache/' + calibrationName }, { ...systemCalibration, url: 'file:///cache/Bench.3mf' },
    { ...systemCalibration, url: 'https://example.invalid/jobs/Bench.gcode?fixture=placeholder' },
    { ...systemCalibration, gcode_file: '/cache/Bench.gcode', subtask_name: 'Bench' }]) {
    const ordinary = mergePrint({}, variant);
    assert.equal(describe(ordinary).calibration, false, JSON.stringify(variant));
    assert.equal(describe(ordinary).available, true, JSON.stringify(variant));
  }
  assert.equal(describe({ ...systemCalibration, _bb_job_id: 'legacy-snapshot' }).calibration, false);
  assert.equal(describe({ ...confirmed, _bb_job_id: 'different-job' }).calibration, false);
  const spoofed = mergePrint({}, { ...bareJob, _bb_job_id: 'printer-controlled', _bb_system_calibration_job: 'printer-controlled' });
  assert.equal(spoofed._bb_system_calibration_job, undefined);
  assert.equal(describe(spoofed).calibration, false);
  const pathWithOtherLocator = mergePrint({}, { ...systemCalibration, param: calibrationPath, url: 'file:///cache/Bench.3mf' });
  assert.equal(describe(pathWithOtherLocator).calibration, true, 'Reserved absolute path still identifies the built-in job');
});
test('isolated type and names deltas cannot establish calibration and lifecycle changes revoke it', () => {
  const bareNames = { gcode_file: calibrationName, subtask_name: calibrationName };
  const earlierSystemJob = mergePrint({}, telemetry('Maintenance', { gcode_file: '/cache/Maintenance.gcode', print_type: 'system' }));
  const inherited = mergePrint(earlierSystemJob, bareNames);
  assert.equal(inherited.print_type, undefined);
  assert.equal(describe(inherited).calibration, false);

  const typeOnly = mergePrint({}, { gcode_state: 'RUNNING', print_type: 'system' });
  const namesAfterType = mergePrint(typeOnly, bareNames);
  const typeAfterNames = mergePrint(mergePrint({}, { ...bareNames, gcode_state: 'RUNNING' }), { print_type: 'system' });
  const splitNames = mergePrint(mergePrint({}, { gcode_state: 'RUNNING', gcode_file: calibrationName }), { subtask_name: calibrationName, print_type: 'system' });
  for (const partial of [namesAfterType, typeAfterNames, splitNames]) {
    assert.equal(partial.print_type, 'system');
    assert.equal(describe(partial).available, true);
    assert.equal(describe(partial).calibration, false);
    assert.equal(partial._bb_system_calibration_job, undefined);
  }

  const confirmed = mergePrint(typeAfterNames, systemCalibration);
  assert.notEqual(confirmed._bb_job_id, typeAfterNames._bb_job_id);
  const partial = mergePrint(confirmed, { mc_percent: 20, gcode_file: calibrationName });
  assert.equal(partial._bb_job_id, confirmed._bb_job_id);
  assert.equal(describe(partial).bareCalibration, true);
  for (const takeover of [{ ...bareNames, print_type: 'local' }, { print_type: 'local' },
    { gcode_file: '/cache/' + calibrationName }, { param: '/cache/' + calibrationName },
    { url: 'https://example.invalid/jobs/Bench.gcode' }, { gcode_file: '' }]) {
    const switched = mergePrint(partial, takeover);
    assert.equal(switched._bb_system_calibration_job, undefined);
    assert.equal(describe(switched).calibration, false);
    assert.notEqual(switched._bb_job_id, partial._bb_job_id);
  }
  const completed = mergePrint(partial, { gcode_state: 'FINISH', mc_percent: 100 });
  const restart = mergePrint(completed, { ...bareNames, gcode_state: 'PREPARE', mc_percent: 0 });
  assert.equal(describe(restart).calibration, false);
  assert.equal(restart.print_type, undefined);
  assert.notEqual(restart._bb_job_id, completed._bb_job_id);
});
test('reconnection must corroborate calibration again even with identical zero-ID filenames', () => {
  const confirmed = mergePrint({}, systemCalibration);
  const newSession = mergePrint({}, systemCalibration);
  const newLocal = mergePrint({}, { ...systemCalibration, print_type: 'local' });
  const newUnconfirmed = mergePrint(mergePrint({}, { print_type: 'system' }), {
    gcode_file: calibrationName, subtask_name: calibrationName, gcode_state: 'RUNNING', task_id: '0', subtask_id: '0',
  });
  assert.equal(reconnectJob(confirmed, newSession, true), 'same');
  const rebound = reuseJobId(newSession, confirmed._bb_job_id);
  assert.equal(rebound._bb_system_calibration_job, confirmed._bb_job_id);
  assert.equal(describe(rebound).calibration, true);
  for (const ordinary of [newLocal, newUnconfirmed]) {
    assert.equal(reconnectJob(confirmed, ordinary, true), 'different');
    assert.equal(reconnectJob(ordinary, newSession, true), 'different');
    assert.equal(describe(reuseJobId(ordinary, confirmed._bb_job_id)).calibration, false);
  }
});
test('partial calibration telemetry replaces print metadata and resumes an ordinary job', () => {
  const previous = mergePrint({}, telemetry('Previous', { layer_num: 22, total_layer_num: 30, mc_remaining_time: 44, bed_temper: 55, mapping: [8192] }));
  const calibrating = mergePrint(previous, { param: calibrationPath, mc_percent: 15 });
  assert.equal(calibrating.gcode_state, 'RUNNING');
  assert.equal(calibrating.bed_temper, 55);
  assert.equal(describe(calibrating).calibrating, true);
  assert.notEqual(calibrating._bb_job_id, previous._bb_job_id);
  for (const field of ['gcode_file', 'subtask_name', 'layer_num', 'total_layer_num', 'mc_remaining_time', 'mapping']) {
    assert.equal(calibrating[field], undefined, field);
  }
  const delta = mergePrint(calibrating, { mc_percent: 18 });
  assert.equal(describe(delta).calibrating, true);
  assert.equal(delta._bb_job_id, calibrating._bb_job_id);
  assert.equal(reconnectJob(previous, { gcode_state: 'RUNNING', gcode_file: calibrationPath }, true), 'different');
  assert.equal(reconnectJob(calibrating, { gcode_state: 'RUNNING', gcode_file: calibrationPath }, true), 'same');
  const next = mergePrint(delta, { gcode_file: '/cache/' + calibrationName, layer_num: 0, mc_percent: 0 });
  assert.equal(describe(next).calibration, false);
  assert.equal(describe(next).available, true);
  assert.equal(next.param, undefined);
  assert.notEqual(next._bb_job_id, delta._bb_job_id);
});
test('archive validation catches corruption, unsliced projects, checksums and decompression limits', async () => {
  const checksum = createHash('md5').update(gcode).digest('hex').toUpperCase();
  assert.deepEqual(await extractPlateGcode(archive({ 'Metadata/plate_1.gcode': gcode, 'Metadata/plate_1.gcode.md5': checksum })), gcode);
  await assert.rejects(extractPlateGcode(archive({ 'Metadata/plate_1.gcode': gcode, 'Metadata/plate_1.gcode.md5': '0'.repeat(32) })), { code: 'FILE_CORRUPT' });
  const corrupt = archive({ 'Metadata/plate_1.gcode': gcode }); corrupt[30 + Buffer.byteLength('Metadata/plate_1.gcode') + 2] ^= 1;
  await assert.rejects(extractPlateGcode(corrupt), { code: 'FILE_CORRUPT' });
  await assert.rejects(extractPlateGcode(Buffer.from('PKbroken')), { code: 'ARCHIVE_INVALID' });
  await assert.rejects(extractPlateGcode(archive({ '3D/model.model': '<model />' })), { code: 'PLATE_NOT_FOUND' });
  const plate = archive({ 'Metadata/plate_1.gcode': gcode });
  await assert.rejects(extractPlateGcode(plate, { limits: { ...LIMITS, gcode: 10 } }), { code: 'FILE_TOO_LARGE', stage: 'extract', status: 413, retryable: false });
  await assert.rejects(extractPlateGcode(gcode, { limits: { ...LIMITS, gcode: 10 } }), { code: 'FILE_TOO_LARGE', stage: 'validate', status: 413 });
  assert.deepEqual(await extractPlateGcode(gcode, { limits: { ...LIMITS, archive: 10 } }), gcode);
  await assert.rejects(extractPlateGcode(plate, { limits: { ...LIMITS, archive: 10 } }), { code: 'ARCHIVE_TOO_LARGE', stage: 'validate', status: 413 });
  await assert.rejects(extractPlateGcode(archive({ 'Metadata/plate_1.gcode': gcode, 'Metadata/plate_1.gcode.md5': 'a'.repeat(129) })), { code: 'ARCHIVE_INVALID' });
  // A stored ZIP entry with traditional encryption includes a 12-byte header.
  const encrypted = archive({ 'Metadata/plate_1.gcode': Buffer.concat([Buffer.alloc(12), gcode]) });
  const centralEntry = encrypted.indexOf(Buffer.from('504b0102', 'hex'));
  encrypted.writeUInt16LE(1, 6);
  encrypted.writeUInt32LE(gcode.length, 22);
  encrypted.writeUInt16LE(1, centralEntry + 8);
  encrypted.writeUInt32LE(gcode.length, centralEntry + 24);
  await assert.rejects(extractPlateGcode(encrypted), { code: 'ARCHIVE_ENCRYPTED', stage: 'extract', retryable: false });
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
test('H3C filament mapping survives sparse reports and clears for a new print', () => {
  const mapping = [65535, 65535, 65535, 65535, 65535, 8192];
  const original = mergePrint({}, telemetry('First', { mapping }));
  const partial = mergePrint(original, { mc_percent: 80 });
  assert.deepEqual(partial.mapping, mapping);
  const finished = mergePrint(partial, { gcode_state: 'FINISH', mc_percent: 100 });
  const next = mergePrint(finished, { gcode_state: 'PREPARE', subtask_name: 'Second' });
  assert.equal(next.mapping, undefined);
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
test('progress describes a shared download and the last disconnected viewer cancels it', async t => {
  let transfer, downloads = 0;
  const fixture = await routeFixture(t, opts => {
    downloads++;
    if (downloads > 1) return Promise.resolve(gcode);
    transfer = opts;
    opts.onEvent({ stage: 'download', result: 'progress', bytes: 50, expectedBytes: 100 });
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new GcodeError('JOB_CHANGED', 'Canceled.')), { once: true }));
  });
  const first = new AbortController(), second = new AbortController();
  const firstResponse = assert.rejects(fixture.get('', { signal: first.signal }), { name: 'AbortError' });
  const secondResponse = assert.rejects(fixture.get('', { signal: second.signal }), { name: 'AbortError' });
  await until(() => transfer);
  const progress = await (await fixture.progress()).json();
  assert.deepEqual(progress, { phase: 'download', bytes: 50, total: 100, activity: 1 });
  transfer.onEvent({ stage: 'download', result: 'progress', bytes: 65, expectedBytes: 100 });
  assert.deepEqual(await (await fixture.progress()).json(), { phase: 'download', bytes: 65, total: 100, activity: 2 });
  first.abort();
  await firstResponse;
  assert.equal(transfer.signal.aborted, false);
  second.abort();
  await secondResponse;
  await until(() => transfer.signal.aborted);
  assert.equal((await fixture.progress()).status, 204);
  assert.equal(downloads, 1);
  assert.deepEqual(Buffer.from(await (await fixture.get()).arrayBuffer()), gcode);
  assert.equal(downloads, 2);
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
test('unconfirmed reconnect telemetry pauses downloads and keeps manual recovery and diagnostics intact', async t => {
  let count = 0, finishDownload;
  const fixture = await routeFixture(t, async () => {
    count++;
    return new Promise(resolve => { finishDownload = resolve; });
  });
  assert.equal((await fixture.post(gcode)).status, 200);
  const manual = await fixture.diagnostics();
  const pendingDownload = fixture.get('?nocache=1');
  await until(() => finishDownload);
  const provisional = { gcode_state: 'RUNNING', gcode_file: '/data/Metadata/plate_1.gcode', _bb_job_pending: true };
  assert.equal(describe(provisional).available, true, 'The partial locator alone looks loadable');
  await fixture.write(provisional);
  const assertWaiting = async response => {
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'JOB_PENDING');
    assert.equal(body.retryable, true);
    assert.match(body.detail, /confirm the current print/);
  };
  try {
    await assertWaiting(await fixture.get());
    await assertWaiting(await fixture.post(gcode));
  } finally {
    finishDownload(gcode);
  }
  await assertWaiting(await pendingDownload);
  assert.equal(count, 1);
  assert.deepEqual(await fixture.diagnostics(), manual);
  await fixture.write(telemetry());
  const resolved = await fixture.get();
  assert.equal(resolved.status, 200);
  assert.deepEqual(Buffer.from(await resolved.arrayBuffer()), gcode);
  assert.equal(count, 1, 'The confirmed print reuses the cached manual file');
});
test('direct G-code requests during calibration cancel an obsolete download without writing diagnostics', async t => {
  let calls = 0, download;
  const fixture = await routeFixture(t, opts => {
    calls++;
    if (calls > 1) return Promise.resolve(gcode);
    download = opts;
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(
      new GcodeError('JOB_CHANGED', 'Canceled.', { status: 409, retryable: true })), { once: true }));
  });
  assert.equal((await fixture.post(gcode)).status, 200);
  const manual = await fixture.diagnostics();
  const older = fixture.get('?nocache=1');
  await until(() => download);
  const calibrating = telemetry(calibrationName, { gcode_file: calibrationPath, stg_cur: 25 });
  await fixture.write(calibrating);
  assert.equal((await fixture.progress()).status, 204);
  assert.equal(download.signal.aborted, true);
  assert.equal((await older).status, 409);
  const attempts = await Promise.all([
    fixture.get(), fixture.get('?retry=1'), fixture.get('?nocache=1'),
    fixture.post(gcode, '?job=' + encodeURIComponent(describe(calibrating).key)),
  ]);
  for (const response of attempts) {
    assert.equal(response.status, 409);
    const error = await response.json();
    assert.equal(error.code, 'CALIBRATING');
    assert.equal(error.retryable, false);
  }
  assert.equal(calls, 1);
  assert.deepEqual(await fixture.diagnostics(), manual);
  assert.deepEqual(fixture.logs, []);
  assert.equal((await fs.readdir(path.join(fixture.data, 'gcode-cache'))).length, 1);

  await fixture.write(telemetry(calibrationName, { gcode_file: '/cache/' + calibrationName }));
  const next = await fixture.get();
  assert.equal(next.status, 200);
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), gcode);
  assert.equal(calls, 2);
});
test('direct G-code routes block a corroborated bare system job and resume a same-name local job', async t => {
  const downloads = [];
  const fixture = await routeFixture(t, async options => { downloads.push(options.job); return gcode; });
  await fixture.write({ ...systemCalibration, _bb_job_id: 'unverified-old-snapshot' });
  assert.equal((await fixture.get()).status, 200);
  const ordinaryDiagnostic = await fixture.diagnostics();
  const confirmed = mergePrint({}, systemCalibration);
  await fixture.write(confirmed);
  for (const reply of [await fixture.get('?nocache=1&retry=1'), await fixture.post(gcode)]) {
    assert.equal(reply.status, 409);
    const error = await reply.json();
    assert.equal(error.code, 'CALIBRATING');
    assert.equal(error.retryable, false);
  }
  assert.equal((await fixture.progress()).status, 204);
  assert.deepEqual(await fixture.diagnostics(), ordinaryDiagnostic);
  assert.equal(downloads.length, 1);
  const sameNameLocal = mergePrint(confirmed, { ...systemCalibration, print_type: 'local' });
  await fixture.write(sameNameLocal);
  assert.deepEqual(Buffer.from(await (await fixture.get()).arrayBuffer()), gcode);
  assert.equal(downloads.length, 2);
  assert.equal(downloads.at(-1).file, calibrationName);
  assert.equal(downloads.at(-1).calibration, false);
});
test('missing telemetry/configuration produce explicit errors, not generic waiting responses', async t => {
  const fixture = await routeFixture(t, async () => gcode);
  await fs.writeFile(path.join(fixture.data, 'data.json'), '{partial');
  let response = await fixture.get(); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'TELEMETRY_UNAVAILABLE');
  await fixture.write(telemetry()); fixture.config.printer.accessCode = '';
  response = await fixture.get(); assert.equal(response.status, 422); assert.equal((await response.json()).code, 'PRINTER_NOT_CONFIGURED');
  await fixture.write({ gcode_state: 'IDLE' }); response = await fixture.get(); assert.equal(response.status, 404);
});
