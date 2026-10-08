// Browser -> real app API -> simulated Bambu -> real saved state -> browser.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const engines = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const root = path.resolve(__dirname, '..');
const TOKEN = 'fixture-manual-cloud-token-value';

async function runEngine(name, artifacts) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-cloud-'));
  const scenarioFile = path.join(data, 'cloud-fixture.json');
  const scenario = mode => fs.writeFile(scenarioFile, JSON.stringify(typeof mode === 'string' ? { mode } : mode));
  await scenario('normal');
  await fs.writeFile(scenarioFile + '.requests', '');
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ printer: { name: 'Cloud QA printer', type: 'H2D', url: '127.0.0.1', port: 9, serialNumber: 'FIXTURE', accessCode: 'fixture-lan-code' }, cloudAuth: { enabled: false } }));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const server = spawn(process.execPath, ['--require', './test/fixtures/cloud-fetch.js', 'src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), BAMBUBOARD_DATA_DIR: data, BB_CLOUD_FIXTURE_FILE: scenarioFile, BAMBUBOARD_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser;
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  const passed = [], audits = [], errors = [], external = new Set();
  const config = () => fs.readFile(path.join(data, 'config.json'), 'utf8').then(JSON.parse);
  const savedToken = () => fs.readFile(path.join(data, 'accessToken.json'), 'utf8').then(JSON.parse);
  const requests = async () => (await fs.readFile(scenarioFile + '.requests', 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(base + '/api/status')).ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Temporary cloud QA server failed to start: ' + logs);
    browser = await engines[name].launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.add(request.url()); });
    const page = await context.newPage();
    await page.clock.install();
    const load = async () => { await page.goto(base + '/setup'); await page.waitForFunction(() => document.getElementById('cloud-status-pill').textContent !== 'Checking…'); };
    const waitText = (id, text) => page.waitForFunction(({ id, text }) => document.getElementById(id).textContent.includes(text), { id, text });
    const audit = async label => {
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      audits.push({ label, violations: result.violations.map(v => ({ id: v.id, targets: v.nodes.map(node => node.target) })) });
    };
    const send = async () => { await page.locator('#cloud-email').fill('demo@example.test'); await page.locator('#cloud-email').press('Enter'); await waitText('cloud-send-status', 'Code sent.'); };
    const verify = async code => { await page.locator('#cloud-code').fill(code); await page.locator('#cloud-code').press('Enter'); };
    const signout = async () => { await page.locator('#cloud-signout-link').click(); await waitText('cloud-account-status', 'Signed out.'); };

    await load();
    assert.equal(await page.locator('#cloud-email').isVisible(), true);
    assert.equal(await page.locator('#cloud-code-step').isVisible(), false);
    assert.equal(await page.locator('#cloud-mfa').isVisible(), false);
    assert.equal((await config()).cloudAuth.enabled, false);
    await page.locator('#cloud-email').fill('invalid'); await page.locator('#cloud-email').press('Enter');
    assert.equal((await requests()).length, 0, 'Invalid email must not send a code');
    await audit('Email sign-in');
    passed.push('New sign-in starts with email; invalid input does not contact Bambu');

    await scenario({ mode: 'normal', delay: 350 });
    await page.locator('#cloud-email').fill('demo@example.test'); await page.locator('#cloud-send-code').click();
    assert.equal(await page.locator('#cloud-send-code').isDisabled(), true);
    assert.equal(await page.locator('#cloud-tab-token').isDisabled(), true);
    await page.locator('#cloud-email-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await waitText('cloud-send-status', 'Code sent.');
    assert.equal((await requests()).filter(r => r.url.endsWith('/sendemail/code')).length, 1, 'Duplicate submits must not send duplicate emails');
    assert.equal(await page.locator('#cloud-code').evaluate(input => input === document.activeElement), true);
    assert.match(await page.locator('#cloud-send-code').innerText(), /Resend in/);
    assert.equal((await config()).cloudAuth.enabled, false);
    await audit('Code sent and cooldown');
    await page.clock.fastForward(61_000);
    assert.equal(await page.locator('#cloud-send-code').isEnabled(), true);
    await scenario('normal'); await verify('012345'); await waitText('cloud-send-status', 'Signed in.');
    assert.equal((await savedToken()).accessToken, 'fixture-email-cloud-token-value');
    assert.equal((await config()).cloudAuth.enabled, true);
    assert.equal((await requests()).find(r => r.url.endsWith('/user/login')).body.code, '012345');
    assert.equal(await page.locator('#cloud-code-step').isVisible(), false);
    passed.push('Pending submissions, resend cooldown, keyboard code entry and persisted email sign-in');

    await load();
    await page.locator('#cloud-token').focus();
    assert.equal(await page.locator('#cloud-token').getAttribute('type'), 'password', 'Focus must not reveal a saved credential');
    await page.locator('#cloud-token-show').click(); assert.equal(await page.locator('#cloud-token').getAttribute('type'), 'text');
    await page.locator('#cloud-token-show').click(); assert.equal(await page.locator('#cloud-token').getAttribute('type'), 'password');
    await signout();
    assert.equal((await config()).cloudAuth.enabled, false);
    assert.equal(await page.locator('#cloud-send-status').innerText(), '');
    assert.equal((await config()).printer.accessCode, 'fixture-lan-code');
    await assert.rejects(savedToken(), { code: 'ENOENT' });
    await page.locator('#cloud-tab-token').click(); assert.equal(await page.locator('#cloud-token').inputValue(), '');
    passed.push('Saved tokens stay masked; sign-out clears credentials and preserves printer settings');

    await page.locator('#cloud-tab-email').click(); await send(); await verify('111111');
    await waitText('cloud-verify-status', 'not accepted');
    assert.equal((await config()).cloudAuth.enabled, false);
    await verify('222222'); await waitText('cloud-verify-status', 'expired');
    assert.equal(await page.locator('#cloud-send-code').isEnabled(), true);
    await page.locator('#cloud-email').fill('other@example.test');
    assert.equal(await page.locator('#cloud-code-step').isVisible(), false);
    await send();
    passed.push('Incorrect and expired codes are recoverable; changing email resets stale code steps');

    await scenario('mfa'); await verify('012345');
    await page.waitForFunction(() => !document.getElementById('cloud-mfa').hidden && !document.getElementById('cloud-mfa-code').disabled);
    assert.equal(await page.locator('#cloud-mfa-code').evaluate(input => input === document.activeElement), true);
    await audit('Authenticator step');
    await page.locator('#cloud-mfa-code').fill('111111'); await page.locator('#cloud-mfa-code').press('Enter'); await waitText('cloud-mfa-status', 'not accept');
    await page.locator('#cloud-mfa-code').fill('001234'); await page.locator('#cloud-mfa-code').press('Enter'); await waitText('cloud-send-status', 'Signed in.');
    assert.equal((await savedToken()).accessToken, 'fixture-mfa-cloud-token-value');
    assert.equal((await savedToken()).email, 'demo@example.test');
    await signout();
    passed.push('Real MFA API handler obtains the security cookie, retries bad codes and saves the account');

    await scenario('challenge'); await page.locator('#cloud-send-code').click();
    await waitText('cloud-send-status', 'browser challenge');
    assert.equal((await config()).cloudAuth.enabled, false);
    await audit('Blocked email and token fallback');
    await page.locator('#cloud-use-token').click();
    assert.equal(await page.locator('#cloud-method-token').isVisible(), true);
    assert.equal(await page.locator('#cloud-token-instructions').getAttribute('open'), '');
    assert.equal(await page.locator('#cloud-email').inputValue(), 'demo@example.test');
    await scenario('normal'); await page.locator('#cloud-token').fill('token=' + TOKEN + '; Path=/'); await page.locator('#cloud-token').press('Enter');
    await waitText('cloud-token-status', 'Signed in.');
    assert.equal((await savedToken()).accessToken, TOKEN);
    assert.equal(await page.locator('#cloud-token').inputValue(), TOKEN);
    await audit('Token instructions and saved sign-in');
    passed.push('Provider challenges lead to a guided token fallback through the real verification endpoint');

    await scenario('limited'); await page.locator('#cloud-token-save').click();
    await waitText('cloud-token-status', 'too many');
    assert.equal(await page.locator('#cloud-token-save').isDisabled(), true);
    assert.match(await page.locator('#cloud-token-save').innerText(), /Retry in/);
    assert.equal(await page.locator('#cloud-signout-link').isEnabled(), true);
    await page.clock.fastForward(121_000);
    assert.equal(await page.locator('#cloud-token-save').isEnabled(), true);
    await scenario('unavailable'); await page.locator('#cloud-token').fill('fixture-replacement-cloud-token-value'); await page.locator('#cloud-token-save').click();
    await waitText('cloud-token-status', 'temporarily unavailable');
    assert.equal((await savedToken()).accessToken, TOKEN);
    await page.locator('#cloud-check').click(); await waitText('cloud-account-status', 'temporarily unavailable');
    assert.match(await page.locator('#cloud-status-pill').innerText(), /Signed in/);
    await scenario('rejected'); await page.locator('#cloud-check').click(); await waitText('cloud-account-status', 'did not accept');
    assert.equal(await page.locator('#cloud-status-pill').innerText(), 'Sign in again');
    await page.waitForFunction(() => document.querySelector('.cloud-pill').textContent === 'Cloud sign-in needed');
    assert.equal(await page.locator('.cloud-pill').getAttribute('href'), '/setup#cloud-section');
    assert.equal((await savedToken()).accessToken, TOKEN);
    await audit('Expired sign-in');
    await scenario('normal'); await page.locator('#cloud-check').click(); await waitText('cloud-account-status', 'successfully');
    assert.match(await page.locator('#cloud-status-pill').innerText(), /Signed in/);
    passed.push('Outages preserve saved sessions; connection checks distinguish rejection and recovery');

    await page.locator('#cloud-token').fill('fixture-replacement-cloud-token-value'); await page.locator('#cloud-token-save').click(); await waitText('cloud-token-status', 'Signed in.');
    assert.equal((await savedToken()).accessToken, 'fixture-replacement-cloud-token-value');
    assert.equal(await page.locator('#cloud-token').inputValue(), 'fixture-replacement-cloud-token-value');
    await page.locator('#cloud-token-clear').click();
    assert.equal(await page.locator('#cloud-token').inputValue(), '');
    assert.equal((await savedToken()).accessToken, 'fixture-replacement-cloud-token-value');
    await signout();
    passed.push('Token replacement does not restore stale values; clearing a field keeps the saved account');

    await page.route('**/auth/status', route => route.fulfill({ status: 503, json: { error: 'Fixture app outage' } }));
    await load(); assert.equal(await page.locator('#cloud-status-pill').innerText(), 'Status unavailable');
    await page.unroute('**/auth/status'); await page.locator('#cloud-check').click(); await waitText('cloud-account-status', 'status loaded');
    assert.equal(await page.locator('#cloud-status-pill').innerText(), 'Not signed in');
    await scenario('normal'); await send(); await scenario('missing-csrf'); await verify('012345');
    await page.waitForFunction(() => !document.getElementById('cloud-mfa').hidden && !document.getElementById('cloud-mfa-code').disabled);
    await page.locator('#cloud-mfa-code').fill('001234'); await page.locator('#cloud-mfa-code').press('Enter'); await waitText('cloud-mfa-status', 'security token');
    assert.equal(await page.locator('#cloud-use-token').isVisible(), true);
    await audit('MFA security-cookie failure');
    passed.push('Local status failures and missing MFA security cookies offer a working retry or fallback');

    await fs.mkdir(artifacts, { recursive: true });
    await page.locator('#cloud-section').screenshot({ path: path.join(artifacts, 'cloud-mfa-recovery-' + name + '.png') });
    await fs.writeFile(path.join(artifacts, 'cloud-' + name + '.json'), JSON.stringify({ passed, audits, errors, external: [...external] }, null, 2));
    assert.deepEqual(audits.flatMap(a => a.violations), [], 'Cloud accessibility violations');
    assert.deepEqual(errors, [], 'Cloud JavaScript errors');
    assert.deepEqual([...external], [], 'Sign-in UI must not load remote assets');
    assert.ok(!logs.includes(TOKEN) && !logs.includes('fixture-csrf') && !logs.includes('fixture-mfa-key') && !logs.includes('demo@example.test'), 'Runtime diagnostics must not include credentials');
    console.log(name + ': ' + passed.length + ' cloud sign-in groups, ' + audits.length + ' accessibility states, real local APIs and persistence, no errors or secret logging');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
    await fs.rm(data, { recursive: true, force: true });
  }
}
(async () => {
  const artifacts = process.env.BB_SCREENSHOTS || await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-cloud-evidence-'));
  for (const name of (process.env.BB_BROWSERS || 'chromium').split(',')) await runEngine(name.trim(), artifacts);
  console.log('Cloud evidence: ' + artifacts);
})().catch(error => { console.error(error); process.exitCode = 1; });
