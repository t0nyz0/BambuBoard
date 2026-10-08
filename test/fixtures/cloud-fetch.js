// Only loaded by cloud-browser.js in its temporary app process. No real Bambu
// requests or credentials are used. Local app routes and disk writes stay real.
const fs = require('node:fs');
const fixtureFile = process.env.BB_CLOUD_FIXTURE_FILE;
if (!fixtureFile) throw new Error('Cloud fixture requires its isolated scenario file.');
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.bambulab.com/') && !String(url).startsWith('https://bambulab.com/')) return originalFetch(url, options);
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const body = options.body ? JSON.parse(options.body) : {};
  fs.appendFileSync(fixtureFile + '.requests', JSON.stringify({ url, body }) + '\n');
  if (fixture.delay) await new Promise(resolve => setTimeout(resolve, fixture.delay));
  if (fixture.mode === 'challenge') return new Response('<html>Fixture browser challenge</html>', { status: 403 });
  if (fixture.mode === 'unavailable') return Response.json({ error: 'Fixture outage' }, { status: 503 });
  if (fixture.mode === 'limited') return Response.json({ error: 'Fixture rate limit' }, { status: 429, headers: { 'Retry-After': '120' } });
  if (fixture.mode === 'rejected') return Response.json({ code: 4, error: 'Please login.' }, { status: 401 });
  if (String(url).endsWith('/sendemail/code')) return Response.json({ code: null, error: null });
  if (String(url).endsWith('/user/login')) {
    if (body.code === '111111') return Response.json({ code: 2, error: 'Incorrect code' }, { status: 400 });
    if (body.code === '222222') return Response.json({ code: 1, error: 'Expired code' }, { status: 400 });
    if (fixture.mode === 'mfa' || fixture.mode === 'missing-csrf') return Response.json({ loginType: 'tfa', tfaKey: 'fixture-mfa-key' });
    return Response.json({ accessToken: 'fixture-email-cloud-token-value', refreshToken: 'fixture-refresh' });
  }
  if (String(url).endsWith('/api/csrf')) return new Response(null, { status: 204, headers: fixture.mode === 'missing-csrf' ? {} : { 'Set-Cookie': 'bbl_csrf_token=fixture-csrf; Path=/' } });
  if (String(url).endsWith('/sign-in/tfa')) {
    if (options.headers.Cookie !== 'bbl_csrf_token=fixture-csrf' || options.headers['x-bbl-csrf-token'] !== 'fixture-csrf') return Response.json({ reason: 'missing_cookie' }, { status: 403 });
    if (body.tfaCode === '111111') return Response.json({ message: 'Invalid code' }, { status: 400 });
    return new Response('{}', { headers: { 'Set-Cookie': 'token=fixture-mfa-cloud-token-value; Path=/; HttpOnly' } });
  }
  if (String(url).endsWith('/my/preference')) return Response.json({ uid: 'fixture-account' });
  throw new Error('Unexpected fixture cloud endpoint: ' + url);
};
