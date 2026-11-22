const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const express = require('express');
const { buildApiRouter } = require('../src/routes/api');
const { sameOrigin } = require('../src/lib/requestOrigin');
const { GcodeError, probePrinterFiles } = require('../src/services/printerFiles');
const { ftpsFixture } = require('./ftps-fixture');
const { listen, until } = require('./helpers');

function checkFixturePrinter(fixture, extra = {}) {
  return probePrinterFiles({ host: '127.0.0.1', port: fixture.port, accessCode: 'saved-fixture-code', model: 'H2D', ...extra });
}

test('G-code check uses authenticated TLS and a read-only listing without asking for a plate', async t => {
  const fixture = await ftpsFixture(t, {
    files: { '/unused.gcode.3mf': 'fixture' },
    listReplies: { '/cache': '550 Directory unavailable' },
  });
  await checkFixturePrinter(fixture);
  assert.deepEqual(fixture.protocols, ['TLSv1.2']);
  assert.ok(fixture.commands.some(command => command.verb === 'PASS'));
  assert.ok(fixture.commands.some(command => command.verb === 'PROT' && command.arg === 'P'));
  const listings = fixture.commands.filter(command => command.verb === 'LIST').map(command => command.arg.replace(/^-a\s*/, ''));
  assert.equal(listings[0], '/cache');
  assert.equal(listings.at(-1), '/');
  assert.ok(!fixture.commands.some(command => ['SIZE', 'RETR', 'STOR', 'DELE', 'SITE'].includes(command.verb)));
  assert.equal(fixture.downloads, 0);
});

test('G-code check distinguishes authentication, TLS, and an unreachable printer', async t => {
  const wrongCode = await ftpsFixture(t, { authFailure: true });
  await assert.rejects(checkFixturePrinter(wrongCode), { code: 'FTPS_AUTH', stage: 'connect' });
  assert.ok(!wrongCode.commands.some(command => command.verb === 'LIST'));

  const newerTls = await ftpsFixture(t, { tlsVersion: 'TLSv1.3' });
  await assert.rejects(checkFixturePrinter(newerTls), { code: 'FTPS_TLS', stage: 'connect' });

  const closed = net.createServer().listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(checkFixturePrinter({ port }), { code: 'FTPS_REFUSED', stage: 'connect' });
});

test('G-code check distinguishes listing failure from an explicit busy reply', async t => {
  const unsupported = await ftpsFixture(t, { listReplies: { '/cache': '502 Listing is unsupported' } });
  await assert.rejects(checkFixturePrinter(unsupported), { code: 'FTPS_LIST_UNAVAILABLE', stage: 'list' });
  const unavailable = await ftpsFixture(t, { listReplies: { '/cache': '450 Printer is not busy, file access unavailable' } });
  await assert.rejects(checkFixturePrinter(unavailable), { code: 'FTPS_LIST_UNAVAILABLE', stage: 'list' });
  const busy = await ftpsFixture(t, { listReplies: { '/cache': '450 Printer file access is busy' } });
  await assert.rejects(checkFixturePrinter(busy), { code: 'FTPS_BUSY', stage: 'list' });
});

test('G-code check closes a stalled listing at its deadline', async t => {
  const fixture = await ftpsFixture(t, { stallListing: true });
  await assert.rejects(checkFixturePrinter(fixture, { timeout: 3000, deadline: 500 }), { code: 'FTPS_TIMEOUT', stage: 'list', status: 504 });
  assert.ok(fixture.commands.some(command => command.verb === 'LIST'));
  assert.equal(fixture.downloads, 0);
  await until(() => fixture.openSockets === 0);
});

async function apiFixture(t, checkGcodeConnection) {
  const config = { printer: { url: 'Printer.local', port: 28883, serialNumber: 'FIXTURE', accessCode: 'saved-fixture-code', model: 'Bambu Lab H2D' } };
  const app = express();
  app.use((req, res, next) => { if (sameOrigin(req)) next(); else res.sendStatus(403); });
  app.use(express.json());
  app.use('/api', buildApiRouter({ getConfig: () => config, checkGcodeConnection }));
  const base = await listen(t, app);
  const url = base + '/api/test-gcode-connection';
  const post = (body = {}, query = '', headers = {}) => fetch(url + query, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
  });
  return { config, post, url };
}

test('G-code endpoint rejects request overrides and tests only the saved printer', async t => {
  const calls = [];
  const { config, post, url } = await apiFixture(t, async details => { calls.push(details); });
  for (const request of [
    () => post({ host: 'other.invalid' }), () => post({ port: 21 }), () => post({ accessCode: 'unsaved-code' }),
    () => post({}, '?host=other.invalid'),
    () => post({}, '', { Origin: 'https://other.invalid' }),
  ]) {
    const response = await request();
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal((await fetch(url)).status, 404);
  assert.deepEqual(calls, []);
  const result = await post();
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { ok: true, message: 'Secure G-code file access is available.' });
  assert.deepEqual(calls, [{ host: 'Printer.local', accessCode: 'saved-fixture-code', model: 'Bambu Lab H2D' }]);
  config.printer.accessCode = '';
  const missing = await post();
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).code, 'PRINTER_NOT_CONFIGURED');
  assert.equal(calls.length, 1);
});

test('G-code endpoint rejects overlapping checks and superseded printer results', async t => {
  const pending = Promise.withResolvers();
  let called = false;
  const { config, post } = await apiFixture(t, () => { called = true; return pending.promise; });
  const first = post();
  await until(() => called);
  const overlapping = await post();
  assert.equal(overlapping.status, 409);
  assert.equal((await overlapping.json()).code, 'GCODE_CHECK_ACTIVE');
  config.printer = { ...config.printer, serialNumber: 'REPLACEMENT' };
  pending.resolve();
  const superseded = await first;
  assert.equal(superseded.status, 409);
  assert.equal((await superseded.json()).code, 'PRINTER_CHANGED');
  assert.equal((await post()).status, 200);
});

test('G-code endpoint returns its actionable status and suppresses unexpected upstream error details', async t => {
  let error = new GcodeError('FTPS_AUTH', 'Check the saved LAN access code.');
  const { post } = await apiFixture(t, () => { throw error; });
  const denied = await post();
  assert.equal(denied.status, 502);
  assert.deepEqual(await denied.json(), { ok: false, code: 'FTPS_AUTH', error: 'Check the saved LAN access code.' });
  error = new Error('Upstream sent saved-fixture-code on Printer.local');
  const failed = await post();
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { ok: false, code: 'GCODE_CHECK_FAILED', error: 'Could not check printer file access. Try again.' });
});
