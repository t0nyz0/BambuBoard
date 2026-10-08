const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildAuthRouter } = require('../src/routes/auth');
const { temporary, listen } = require('./helpers');
const TOKEN_A = 'fixture-only-cloud-token-account-a';
const TOKEN_B = 'fixture-only-cloud-token-account-b';

async function fixture(t, upstream, options = {}) {
  const data = await temporary(t), requests = [];
  let config = { printer: { accessCode: 'fixture-lan-code', serialNumber: 'fixture-serial' }, cloudAuth: { enabled: false } };
  const app = express(); app.use(express.json());
  app.use(buildAuthRouter({
    getConfig: () => config, paths: { data },
    saveConfig: async next => { if (options.failSave) throw new Error('fixture private details'); config = next; },
    fetchCloud: async (url, opts) => { requests.push({ url, opts }); return upstream(url, opts); },
    requestTimeoutMs: options.requestTimeoutMs || 15_000,
  }));
  const base = await listen(t, app);
  return {
    data, requests, config: () => config,
    token: () => fs.readFile(path.join(data, 'accessToken.json'), 'utf8').then(JSON.parse),
    call: async (route, body) => {
      const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

test('native fetch validates a token before enabling cloud and provides model images', async t => {
  const f = await fixture(t, url => url.endsWith('/my/tasks') ? Response.json({ hits: [{ cover: '/assets/plate.png', title: 'Fixture print' }], total: 1 }) : Response.json({ uid: 'fixture' }));
  assert.equal((await f.call('/auth/manual-token', { token: 'Bearer "' + TOKEN_A + '"', email: 'demo@example.test' })).body.ok, true);
  assert.equal(f.config().cloudAuth.enabled, true);
  assert.equal(f.config().printer.accessCode, 'fixture-lan-code');
  assert.equal((await f.token()).accessToken, TOKEN_A);
  assert.equal((await fs.stat(path.join(f.data, 'accessToken.json'))).mode & 0o777, 0o600);
  assert.equal((await f.call('/auth/status')).body.signedIn, true);
  assert.equal((await f.call('/login-and-fetch-image')).body.modelTitle, 'Fixture print');
  assert.ok(f.requests.every(request => request.opts.headers.Authorization === 'Bearer ' + TOKEN_A));
  assert.equal((await f.call('/auth/token')).headers.get('cache-control'), 'no-store');
});

test('email sign-in works from LAN-only mode through the API host and preserves leading zeroes', async t => {
  const f = await fixture(t, url => url.endsWith('/sendemail/code') ? Response.json({ code: null, error: null }) : Response.json({ accessToken: TOKEN_A, refreshToken: 'fixture-refresh' }));
  assert.equal((await f.call('/sendVerificationCode', { username: 'demo@example.test' })).body.ok, true);
  assert.equal(f.config().cloudAuth.enabled, false, 'requesting a code must not enable cloud features');
  assert.equal((await f.call('/verify', { username: 'demo@example.test', code: '012345' })).body.ok, true);
  assert.equal(f.requests[1].url, 'https://api.bambulab.com/v1/user-service/user/login');
  assert.deepEqual(JSON.parse(f.requests[1].opts.body), { account: 'demo@example.test', code: '012345' });
  assert.equal((await f.token()).email, 'demo@example.test');
  assert.equal(f.config().cloudAuth.enabled, true);
});

test('MFA sends the security cookie and matching header and reads native Set-Cookie tokens', async t => {
  const f = await fixture(t, url => {
    if (url.endsWith('/user/login')) return Response.json({ loginType: 'tfa', tfaKey: 'fixture-mfa-key' });
    if (url.endsWith('/api/csrf')) return new Response(null, { status: 204, headers: { 'Set-Cookie': 'bbl_csrf_token=fixture-csrf; Path=/; HttpOnly' } });
    const headers = new Headers();
    headers.append('Set-Cookie', 'unrelated=fixture; Path=/');
    headers.append('Set-Cookie', 'token=' + TOKEN_A + '; Expires=Wed, 14 Oct 2026 10:00:00 GMT; Path=/; Secure; HttpOnly');
    return new Response('{}', { headers });
  });
  const challenge = await f.call('/verify', { username: 'demo@example.test', code: '012345' });
  assert.equal(challenge.body.mfa, true);
  assert.equal(f.config().cloudAuth.enabled, false);
  const result = await f.call('/mfa', { username: 'demo@example.test', tfaKey: challenge.body.tfaKey, tfaCode: '001234' });
  assert.equal(result.body.ok, true);
  const sent = f.requests.find(request => request.url.endsWith('/sign-in/tfa')).opts;
  assert.equal(sent.headers.Cookie, 'bbl_csrf_token=fixture-csrf');
  assert.equal(sent.headers['x-bbl-csrf-token'], 'fixture-csrf');
  assert.deepEqual(JSON.parse(sent.body), { tfaKey: 'fixture-mfa-key', tfaCode: '001234' });
  assert.equal((await f.token()).accessToken, TOKEN_A);
  assert.equal((await f.token()).email, 'demo@example.test');
});

test('MFA accepts a JSON token and reports missing security cookies without submitting the code', async t => {
  let csrf = true;
  const f = await fixture(t, url => url.endsWith('/api/csrf') ? new Response(null, { status: 204, headers: csrf ? { 'Set-Cookie': 'bbl_csrf_token=fixture-csrf; Path=/' } : {} }) : Response.json({ accessToken: TOKEN_A }));
  const body = { tfaKey: 'fixture-key', tfaCode: '123456' };
  assert.equal((await f.call('/mfa', body)).body.ok, true);
  csrf = false;
  const before = f.requests.length, result = await f.call('/mfa', body);
  assert.equal(result.body.code, 'SECURITY_TOKEN');
  assert.equal(result.body.tryManual, true);
  assert.equal(f.requests.length, before + 1);
  assert.equal((await f.token()).accessToken, TOKEN_A);
});

test('invalid inputs never call Bambu or enable cloud features', async t => {
  const f = await fixture(t, () => { throw new Error('unexpected upstream call'); });
  for (const [route, body] of [
    ['/sendVerificationCode', { username: 'invalid' }],
    ['/verify', { username: 'demo@example.test', code: '12345' }],
    ['/mfa', { tfaKey: 'fixture-key', tfaCode: '12345x' }],
    ['/auth/manual-token', { token: 'Bearer short' }],
    ['/auth/manual-token', { token: TOKEN_A, email: 'invalid' }],
  ]) assert.equal((await f.call(route, body)).status, 400);
  assert.equal(f.requests.length, 0);
  assert.equal(f.config().cloudAuth.enabled, false);
  await assert.rejects(f.token(), { code: 'ENOENT' });
});

test('token server errors, challenges, throttling and incomplete responses never replace a saved sign-in', async t => {
  let upstream = () => Response.json({ uid: 'fixture' });
  const f = await fixture(t, (...args) => upstream(...args));
  await f.call('/auth/manual-token', { token: TOKEN_A });
  for (const [response, expected] of [
    [() => Response.json({ error: 'fixture secret ' + TOKEN_B }, { status: 503 }), 'CLOUD_UNAVAILABLE'],
    [() => new Response('<html>fixture secret ' + TOKEN_B + '</html>', { status: 403 }), 'CLOUD_CHALLENGE'],
    [() => Response.json({ error: 'throttled' }, { status: 429, headers: { 'Retry-After': '120' } }), 'RATE_LIMITED'],
    [() => Response.json({}), 'INVALID_RESPONSE'],
    [() => Response.json({ code: 4, error: 'Please login.' }, { status: 401 }), 'TOKEN_REJECTED'],
  ]) {
    upstream = response;
    const result = await f.call('/auth/manual-token', { token: TOKEN_B });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.code, expected);
    assert.ok(!JSON.stringify(result.body).includes(TOKEN_B), 'do not echo credentials from upstream bodies');
    if (expected === 'RATE_LIMITED') assert.equal(result.body.retryAfter, 120);
    assert.equal((await f.token()).accessToken, TOKEN_A);
    assert.equal((await f.call('/auth/status')).body.signedIn, true);
  }
});

test('email code failures distinguish expired and incorrect codes and do not claim that a code was sent', async t => {
  let upstream = () => Response.json({ code: 1, error: 'Code expired' }, { status: 400 });
  const f = await fixture(t, (...args) => upstream(...args));
  const body = { username: 'demo@example.test', code: '123456' };
  assert.equal((await f.call('/verify', body)).body.code, 'CODE_EXPIRED');
  upstream = () => Response.json({ code: 2, error: 'Incorrect code' }, { status: 400 });
  assert.equal((await f.call('/verify', body)).body.code, 'CODE_INCORRECT');
  upstream = () => Response.json({ code: 3, error: 'Code request denied' });
  assert.equal((await f.call('/sendVerificationCode', body)).body.ok, false);
  upstream = () => new Response('<html>challenge</html>');
  assert.equal((await f.call('/sendVerificationCode', body)).body.code, 'CLOUD_CHALLENGE');
  assert.equal(f.config().cloudAuth.enabled, false);
});

test('timeouts and DNS errors return actionable messages without leaking transport details', async t => {
  let hang = true;
  const f = await fixture(t, (_url, opts) => hang ? new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
  }) : Promise.reject(Object.assign(new Error('fixture secret ' + TOKEN_A), { cause: { code: 'ENOTFOUND' } })), { requestTimeoutMs: 25 });
  assert.equal((await f.call('/auth/manual-token', { token: TOKEN_A })).body.code, 'CLOUD_TIMEOUT');
  hang = false;
  const result = await f.call('/auth/manual-token', { token: TOKEN_A });
  assert.equal(result.body.code, 'CLOUD_DNS');
  assert.ok(!result.body.error.includes(TOKEN_A));
  assert.equal(f.config().cloudAuth.enabled, false);
});

test('connection checks distinguish service outages from rejected credentials and sign-out clears saved secrets', async t => {
  let upstream = () => Response.json({ uid: 'fixture' });
  const f = await fixture(t, (...args) => upstream(...args));
  assert.equal((await f.call('/auth/check', {})).body.code, 'NOT_SIGNED_IN');
  await f.call('/auth/manual-token', { token: TOKEN_A });
  assert.equal((await f.call('/auth/check', {})).body.ok, true);
  upstream = () => Response.json({}, { status: 503 });
  assert.equal((await f.call('/auth/check', {})).body.code, 'CLOUD_UNAVAILABLE');
  assert.equal((await f.call('/auth/status')).body.signedIn, true, 'an outage is not a rejected credential');
  upstream = () => Response.json({ error: 'fixture permission failure' }, { status: 403 });
  assert.equal((await f.call('/auth/check', {})).body.code, 'CLOUD_ACCESS_DENIED');
  assert.equal((await f.call('/auth/status')).body.signedIn, true, 'a permission failure does not prove that the saved token has expired');
  upstream = () => Response.json({ code: 4, error: 'Please login.' }, { status: 401 });
  assert.equal((await f.call('/auth/check', {})).body.code, 'TOKEN_REJECTED');
  assert.equal((await f.call('/auth/status')).body.signedIn, false);
  upstream = () => Response.json({}, { status: 503 });
  await f.call('/auth/check', {});
  assert.equal((await f.call('/auth/status')).body.signedIn, false, 'an outage does not undo a confirmed rejected credential');
  assert.equal((await f.token()).accessToken, TOKEN_A, 'rejected tokens stay available for deliberate replacement');
  await f.call('/auth/signout', { disable: true });
  assert.equal(f.config().cloudAuth.enabled, false);
  assert.equal(f.config().printer.accessCode, 'fixture-lan-code');
  assert.equal((await f.call('/auth/token')).body.token, '');
  await assert.rejects(f.token(), { code: 'ENOENT' });
});

test('account replacement invalidates cloud widget caches and a failed settings save restores the previous token', async t => {
  const f = await fixture(t, (_url, opts) => {
    const account = opts.headers.Authorization === 'Bearer ' + TOKEN_B ? 'B' : 'A';
    return Response.json({ uid: account, hits: [{ title: 'Print ' + account }], handle: 'Maker ' + account });
  });
  await f.call('/auth/manual-token', { token: TOKEN_A });
  assert.equal((await f.call('/login-and-fetch-image')).body.modelTitle, 'Print A');
  assert.equal((await f.call('/profile-info')).body.handle, 'Maker A');
  await f.call('/auth/manual-token', { token: TOKEN_B });
  assert.equal((await f.call('/login-and-fetch-image')).body.modelTitle, 'Print B');
  assert.equal((await f.call('/profile-info')).body.handle, 'Maker B');
  const failed = await fixture(t, () => Response.json({ uid: 'fixture' }), { failSave: true });
  await fs.writeFile(path.join(failed.data, 'accessToken.json'), JSON.stringify({ accessToken: TOKEN_A }));
  const result = await failed.call('/auth/manual-token', { token: TOKEN_B });
  assert.equal(result.body.code, 'SAVE_FAILED');
  assert.equal((await failed.token()).accessToken, TOKEN_A);
  assert.ok(!result.body.error.includes('private details'));
  assert.equal((await failed.call('/auth/signout', { disable: true })).body.ok, false);
  assert.equal((await failed.token()).accessToken, TOKEN_A, 'a failed cloud settings update must not remove the saved account');

  let release, started;
  const inFlight = new Promise(resolve => { started = resolve; });
  let delay = false;
  const concurrent = await fixture(t, (_url, opts) => {
    if (delay && opts.headers.Authorization === 'Bearer ' + TOKEN_A) {
      delay = false; started();
      return new Promise(resolve => { release = resolve; });
    }
    return Response.json({ uid: 'fixture' });
  });
  await concurrent.call('/auth/manual-token', { token: TOKEN_A });
  delay = true;
  const oldCheck = concurrent.call('/auth/check', {});
  await inFlight;
  await concurrent.call('/auth/manual-token', { token: TOKEN_B });
  release(Response.json({ code: 4, error: 'Please login.' }, { status: 401 }));
  assert.equal((await oldCheck).body.code, 'SESSION_CHANGED');
  assert.equal((await concurrent.call('/auth/status')).body.signedIn, true, 'an old account check cannot reject a newly saved sign-in');
});
