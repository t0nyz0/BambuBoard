const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildAuthRouter } = require('../src/routes/auth');
const { temporary, listen } = require('./helpers');
test('native Node fetch supports cloud verification, saved status and model-image responses', async t => {
  const data = await temporary(t);
  let config = { cloudAuth: { enabled: false } };
  const app = express(); app.use(express.json());
  app.use(buildAuthRouter({ getConfig: () => config, saveConfig: async next => { config = next; }, paths: { data } }));
  const base = await listen(t, app), nativeFetch = global.fetch, requests = [];
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.bambulab.com/')) {
      requests.push({ url, authorization: options.headers.Authorization });
      if (String(url).endsWith('/my/tasks')) return Response.json({ hits: [{ cover: '/assets/plate.png', title: 'Fixture print' }], total: 1 });
      return Response.json({ uid: 'fixture' });
    }
    return nativeFetch(url, options);
  };
  t.after(() => { global.fetch = nativeFetch; });
  const token = 'fixture-only-cloud-token-value';
  const result = await fetch(base + '/auth/manual-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).then(r => r.json());
  assert.equal(result.ok, true); assert.equal(config.cloudAuth.enabled, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(data, 'accessToken.json'))).accessToken, token);
  assert.equal((await fetch(base + '/auth/status').then(r => r.json())).signedIn, true);
  const image = await fetch(base + '/login-and-fetch-image').then(r => r.json());
  assert.equal(image.modelTitle, 'Fixture print');
  assert.ok(requests.every(request => request.authorization === `Bearer ${token}`));
});
