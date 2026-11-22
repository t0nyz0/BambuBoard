const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildApiRouter } = require('../src/routes/api');
const { listen } = require('./helpers');

test('LAN connection checks keep the saved code on its saved destination and honor entered replacements', async t => {
  const config = { printer: { url: 'Printer.local', port: 8883, serialNumber: 'FIXTURE', accessCode: 'saved-fixture' } };
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter({
    getConfig: () => config,
    checkPrinterConnection: async details => { calls.push(details); return { ok: true }; },
  }));
  const base = await listen(t, app);
  const check = details => fetch(base + '/api/test-connection', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details),
  });
  const destination = { url: 'printer.LOCAL', serialNumber: 'FIXTURE' };

  const credentialStatus = await fetch(base + '/api/printer-credentials');
  assert.equal(credentialStatus.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await credentialStatus.json(), { accessCode: '', accessCodeSet: true });

  assert.deepEqual(await (await check(destination)).json(), { ok: true });
  assert.deepEqual(calls, [config.printer]);

  for (const patch of [{ url: 'second-printer.test' }, { port: 28883 }, { serialNumber: 'SECOND' }, { accessCode: 1234 }]) {
    const response = await check({ ...destination, ...patch });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'ACCESS_CODE_REQUIRED');
  }
  assert.equal(calls.length, 1, 'A blank or invalid code never opened a different connection');

  const explicit = { url: 'second-printer.test', port: 28883, serialNumber: 'SECOND', accessCode: 'typed-fixture' };
  assert.deepEqual(await (await check({ ...explicit, accessCode: ' typed-fixture ' })).json(), { ok: true });
  assert.deepEqual(calls[1], explicit);

  config.printer.accessCode = 'FILL_THIS_OUT';
  assert.equal((await check(destination)).status, 400);
  assert.equal(calls.length, 2, 'The setup placeholder is never used as an access code');
});
