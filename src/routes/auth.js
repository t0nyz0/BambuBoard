// Cloud sign-in is explicit; only a successful sign-in enables cloud features.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('node:crypto');
const { version } = require('../../package.json');

function buildAuthRouter({ getConfig, saveConfig, paths, fetchCloud = (...args) => fetch(...args), requestTimeoutMs = 15_000 }) {
  const router = express.Router();
  const TOKEN_PATH = path.join(paths.data, 'accessToken.json');
  const API = 'https://api.bambulab.com';
  const WEB = 'https://bambulab.com';
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `BambuBoard/${version}` };
  let imageCache = { time: 0, data: null };
  let profileCache = { time: 0, data: null };
  let connectionCheck = null;
  let accountRevision = 0;
  let credentialRejected = false;
  const log = (msg) => {
    if (process.env.BAMBUBOARD_LOGGING || getConfig().BambuBoard_logging) {
      console.log(`[bambuboard:auth] ${msg}`);
    }
  };

  function cloudEnabled() {
    return !!getConfig().cloudAuth?.enabled;
  }

  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  function failure(code, message, status = 502, extra = {}) {
    return Object.assign(new Error(message), { code, status, ...extra });
  }
  function report(res, error, action) {
    // Never include upstream bodies, tokens, cookies, email addresses or codes.
    const e = error.code && error.status ? error : failure('SAVE_FAILED', 'Could not update the cloud sign-in. Check access to BambuBoard’s data folder.', 500);
    log(`${action}: ${e.code} (HTTP ${e.status})`);
    return res.status(e.status).json({ ok: false, error: e.message, code: e.code, tryManual: !!e.tryManual, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) });
  }
  function emailValue(value) {
    return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim() : null;
  }
  function codeValue(value) { return typeof value === 'string' && /^\d{6}$/.test(value.trim()) ? value.trim() : null; }
  function cookieValue(responseHeaders, name) {
    const cookie = responseHeaders.getSetCookie().find(value => value.startsWith(`${name}=`));
    return cookie ? cookie.split(';')[0].slice(name.length + 1) : null;
  }
  async function requestCloud(url, opts = {}, allowEmpty = false) {
    try {
      const r = await fetchCloud(url, { ...opts, headers: { ...headers, ...opts.headers }, signal: AbortSignal.timeout(requestTimeoutMs), redirect: 'error' });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { /* classify below */ }
      if (r.status === 429) {
        const retry = r.headers.get('retry-after');
        const seconds = /^\d+$/.test(retry || '') ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
        throw failure('RATE_LIMITED', 'Bambu Cloud is receiving too many sign-in requests. Wait before trying again.', 429, { retryAfter: Math.max(60, Math.min(3600, seconds || 60)) });
      }
      if (r.status >= 500) throw failure('CLOUD_UNAVAILABLE', 'Bambu Cloud is temporarily unavailable. Try again shortly; your saved sign-in has been kept.');
      if ((!data && text) || (data && typeof data !== 'object') || Array.isArray(data)) {
        throw failure('CLOUD_CHALLENGE', 'Bambu returned a browser challenge or an unexpected response. Sign in on MakerWorld and use the token method instead.', 502, { tryManual: true });
      }
      if (data?.reason === 'missing_cookie' || data?.reason === 'missing_header' || /csrf/i.test(typeof data?.error === 'string' ? data.error : '')) {
        throw failure('SECURITY_TOKEN', 'Bambu could not accept the sign-in security token. Try again, or use a MakerWorld token.', 502, { tryManual: true });
      }
      if (url.endsWith('/user/login') && data?.code === 1) throw failure('CODE_EXPIRED', 'That email code has expired. Request a new code and try again.', 400);
      if (url.endsWith('/user/login') && data?.code === 2) throw failure('CODE_INCORRECT', 'That email code was not accepted. Check all six digits and try again.', 400);
      if (url.endsWith('/sign-in/tfa') && r.status === 400) {
        if (/expired/i.test(String(data?.message || data?.error || ''))) throw failure('MFA_EXPIRED', 'This verification attempt has expired. Request a fresh email code to start again.', 400);
        throw failure('CODE_INCORRECT', 'Bambu did not accept the authenticator code. Try the current six-digit code from your app.', 400);
      }
      if (r.status === 401 && data?.code === 4 && /login/i.test(String(data?.error || ''))) throw failure('TOKEN_REJECTED', 'Bambu did not accept this sign-in. Sign in again, or copy a fresh token from MakerWorld.', 401, { tryManual: true });
      if (r.status === 401 || r.status === 403) throw failure('CLOUD_ACCESS_DENIED', 'Bambu did not allow this connection check. Try again, or use a fresh MakerWorld token.', 401, { tryManual: true });
      if (!r.ok || data?.error || data?.success === false || (data?.code != null && data.code !== 0 && data.code !== '0')) {
        throw failure('CLOUD_REJECTED', 'Bambu did not accept the request. Check your account and code, or use a MakerWorld token.', 400, { tryManual: true });
      }
      if (!data && !allowEmpty) throw failure('INVALID_RESPONSE', 'Bambu returned an incomplete response. Try again, or use a MakerWorld token.', 502, { tryManual: true });
      return { data, headers: r.headers };
    } catch (e) {
      if (e.code && e.status) throw e;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw failure('CLOUD_TIMEOUT', 'Bambu Cloud took too long to respond. Check this server’s internet access and try again.');
      const reason = e.cause?.code;
      if (reason === 'ENOTFOUND' || reason === 'EAI_AGAIN') throw failure('CLOUD_DNS', 'This server could not resolve Bambu Cloud. Check its DNS and internet connection.');
      if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(reason)) throw failure('CLOUD_TLS', 'This server could not verify Bambu’s secure connection. Check its clock and trusted certificates.');
      throw failure('CLOUD_NETWORK', 'This server could not reach Bambu Cloud. Check its internet connection and try again.');
    }
  }

  async function readToken() {
    try { return JSON.parse(await fsp.readFile(TOKEN_PATH, 'utf-8')); }
    catch (_) { return null; }
  }
  async function writeToken(t) {
    const temp = `${TOKEN_PATH}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temp, JSON.stringify(t, null, 2), { mode: 0o600, flag: 'wx' });
      await fsp.rename(temp, TOKEN_PATH);
    } finally { await fsp.rm(temp, { force: true }); }
    resetCaches();
  }
  async function clearToken() {
    await fsp.rm(TOKEN_PATH, { force: true });
    resetCaches();
  }
  function resetCaches() {
    accountRevision++;
    imageCache = { time: 0, data: null };
    profileCache = { time: 0, data: null };
    connectionCheck = null;
    credentialRejected = false;
  }
  async function saveSignIn(token) {
    const previous = await readToken();
    try {
      await writeToken(token);
      const cfg = getConfig();
      if (!cfg.cloudAuth?.enabled) await saveConfig({ ...cfg, cloudAuth: { ...cfg.cloudAuth, enabled: true } });
      connectionCheck = { ok: true, checkedAt: new Date().toISOString() };
    } catch (e) {
      if (previous) await writeToken(previous); else await clearToken();
      throw e;
    }
  }
  async function probeToken(token) {
    const { data } = await requestCloud(`${API}/v1/design-user-service/my/preference`, { headers: { Authorization: `Bearer ${token}` } });
    if (!data?.uid) throw failure('INVALID_RESPONSE', 'Bambu did not return an account for this token. Copy the full token from a fresh MakerWorld sign-in.', 502);
  }

  // Status: signed-in or not
  router.get('/auth/status', async (req, res) => {
    const t = await readToken();
    res.json({ enabled: cloudEnabled(), signedIn: cloudEnabled() && !!t?.accessToken && !credentialRejected, tokenSaved: !!t?.accessToken, needsSignIn: credentialRejected, email: t?.email || null, connection: connectionCheck });
  });

  // Return the actual access token so the setup page can pre-fill the
  // editable token field (lets the user manipulate / replace it without
  // signing out first). Same-origin only — this is a self-hosted local
  // server, the token is in data/accessToken.json on the same machine.
  router.get('/auth/token', async (req, res) => {
    const t = await readToken();
    res.json({
      token: t?.accessToken || '',
      email: t?.email || '',
    });
  });

  // Email sign-in uses the API host, not the website's sign-in endpoint.
  // Request shape: greghesp/ha-bambulab pybambu/bambu_cloud.py.
  router.post('/sendVerificationCode', async (req, res) => {
    const username = emailValue(req.body?.username);
    if (!username) return res.status(400).json({ ok: false, code: 'INVALID_EMAIL', error: 'Enter a valid Bambu account email.' });
    try {
      await requestCloud(`${API}/v1/user-service/user/sendemail/code`, {
        method: 'POST',
        body: JSON.stringify({ email: username, type: 'codeLogin' }),
      }, true);
      res.json({ ok: true, retryAfter: 60 });
    } catch (e) { report(res, e, 'send-code'); }
  });

  // Verify (email + code) — returns token info
  router.post('/verify', async (req, res) => {
    const username = emailValue(req.body?.username), code = codeValue(req.body?.code);
    if (!username || !code) return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: 'Enter your email and the six-digit code from Bambu.' });
    try {
      const { data } = await requestCloud(`${API}/v1/user-service/user/login`, {
        method: 'POST',
        body: JSON.stringify({ account: username, code }),
      });
      if (typeof data?.accessToken === 'string' && data.accessToken) {
        await saveSignIn({ accessToken: data.accessToken, refreshToken: data.refreshToken, email: username });
        return res.json({ ok: true });
      }
      if (data?.loginType === 'tfa' && typeof data.tfaKey === 'string' && data.tfaKey) {
        return res.json({ ok: false, mfa: true, tfaKey: data.tfaKey });
      }
      throw failure('INVALID_RESPONSE', 'Bambu did not complete the sign-in. Request a fresh email code, or use a MakerWorld token.', 502, { tryManual: true });
    } catch (e) { report(res, e, 'verify-code'); }
  });

  // Manual token entry — fallback when the email/code flow is blocked by
  // Cloudflare. The user pastes the `token` cookie value from a logged-in
  // makerworld.com session. Auto-enables cloudAuth so the user doesn't have
  // to flip a separate toggle first.
  router.post('/auth/manual-token', async (req, res) => {
    const { token, email } = req.body || {};
    const cleaned = typeof token === 'string' ? token.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').replace(/^token=/i, '').split(';')[0].trim().replace(/^["']|["']$/g, '') : '';
    if (cleaned.length < 20 || cleaned.length > 8192 || /\s/.test(cleaned)) return res.status(400).json({ ok: false, code: 'INVALID_TOKEN', error: 'Paste the complete token cookie value from MakerWorld.' });
    if (email && !emailValue(email)) return res.status(400).json({ ok: false, code: 'INVALID_EMAIL', error: 'Enter a valid email, or leave the optional email blank.' });
    try {
      await probeToken(cleaned);
      await saveSignIn({ accessToken: cleaned, email: emailValue(email) });
      res.json({ ok: true });
    } catch (e) { report(res, e, 'save-token'); }
  });

  router.post('/auth/check', async (_req, res) => {
    const revision = accountRevision;
    const t = await readToken();
    if (!cloudEnabled() || !t?.accessToken) return res.status(401).json({ ok: false, code: 'NOT_SIGNED_IN', error: 'Sign in to Bambu Cloud first.' });
    try {
      await probeToken(t.accessToken);
      if (revision !== accountRevision) throw failure('SESSION_CHANGED', 'The saved account changed while checking. Check the new sign-in again.', 409);
      credentialRejected = false;
      connectionCheck = { ok: true, checkedAt: new Date().toISOString() };
      res.json({ ok: true, ...connectionCheck });
    } catch (e) {
      if (revision !== accountRevision) return report(res, failure('SESSION_CHANGED', 'The saved account changed while checking. Check the new sign-in again.', 409), 'check-connection');
      if (e.code === 'TOKEN_REJECTED') credentialRejected = true;
      connectionCheck = { ok: false, code: e.code, error: e.message, checkedAt: new Date().toISOString() };
      report(res, e, 'check-connection');
    }
  });

  // MFA
  router.post('/mfa', async (req, res) => {
    const { tfaKey, tfaCode } = req.body || {};
    if (typeof tfaKey !== 'string' || !tfaKey || tfaKey.length > 4096 || !codeValue(tfaCode)) return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: 'Enter the six-digit code from your authenticator app.' });
    try {
      // The web host requires double-submit CSRF: GET /api/csrf, then send
      // bbl_csrf_token in both Cookie and x-bbl-csrf-token on the MFA POST.
      // See maziggy/bambuddy services/bambu_cloud.py and ha-bambulab.
      const csrf = await requestCloud(`${WEB}/api/csrf`, {}, true);
      const csrfToken = cookieValue(csrf.headers, 'bbl_csrf_token');
      if (!csrfToken) throw failure('SECURITY_TOKEN', 'Bambu did not provide a sign-in security token. Try again, or use a MakerWorld token.', 502, { tryManual: true });
      const r = await requestCloud(`${WEB}/api/sign-in/tfa`, {
        method: 'POST',
        headers: { Cookie: `bbl_csrf_token=${csrfToken}`, 'x-bbl-csrf-token': csrfToken },
        body: JSON.stringify({ tfaKey, tfaCode: codeValue(tfaCode) }),
      }, true);
      const accessToken = r.data?.accessToken || r.data?.token || cookieValue(r.headers, 'token');
      if (typeof accessToken !== 'string' || !accessToken) throw failure('CODE_INCORRECT', 'Bambu did not accept the authenticator code. Try the current code from your app.', 400);
      await saveSignIn({ accessToken, refreshToken: r.data?.refreshToken, email: emailValue(req.body?.username) });
      res.json({ ok: true });
    } catch (e) { report(res, e, 'verify-mfa'); }
  });

  router.post('/auth/signout', async (req, res) => {
    try {
      if (req.body?.disable === true) {
        const cfg = getConfig();
        await saveConfig({ ...cfg, cloudAuth: { ...cfg.cloudAuth, enabled: false } });
      }
      await clearToken();
      res.json({ ok: true });
    } catch (e) { report(res, e, 'signout'); }
  });

  // LAN-only stubs that the existing widgets call
  router.post('/login', (req, res) => {
    if (!cloudEnabled()) return res.json({ ok: true, lan: true });
    // Cloud-mode login goes through verify/MFA above
    res.json({ ok: true });
  });

  // Model image — fetches the latest print task's cover image from Bambu Cloud.
  // Returns { imageUrl, modelTitle, modelWeight, ... } when signed in, or
  // a placeholder when cloud auth is off / token missing.
  const IMAGE_CACHE_MS = 30_000; // 30s — the widget polls every 5s, no need to hit the API that often

  router.get('/login-and-fetch-image', async (req, res) => {
    if (!cloudEnabled()) return res.json({ imageUrl: '/assets/plate.png' });
    const revision = accountRevision;
    const t = await readToken();
    if (!t?.accessToken) return res.json({ imageUrl: 'NOTENROLLED' });
    const now = Date.now();
    if (imageCache.data && (now - imageCache.time) < IMAGE_CACHE_MS) return res.json(imageCache.data);
    try {
      const { data } = await requestCloud('https://api.bambulab.com/v1/user-service/my/tasks', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${t.accessToken}` },
      });
      const hit = (data.hits || [])[0] || {};
      const out = {
        imageUrl: hit.cover || '/assets/plate.png',
        modelTitle: hit.title || '',
        modelWeight: hit.weight || null,
        modelCostTime: hit.costTime || null,
        totalPrints: data.total || 0,
        deviceName: hit.deviceName || '',
        deviceModel: hit.deviceModel || '',
        bedType: hit.bedType || '',
      };
      if (revision !== accountRevision) return res.json({ imageUrl: '/assets/plate.png' });
      imageCache = { time: now, data: out };
      res.json(out);
    } catch (e) {
      log(`login-and-fetch-image error: ${e.message}`);
      res.json({ imageUrl: '/assets/plate.png' });
    }
  });

  // Profile info — fetches MakerWorld profile (avatar, followers, likes, etc.).
  // Two-step: first get UID from /my/preference, then full profile from /user/profile/:uid.
  const PROFILE_CACHE_MS = 10 * 60_000; // 10 min — profile stats don't change fast

  router.get('/profile-info', async (req, res) => {
    if (!cloudEnabled()) return res.json({ enabled: false });
    const revision = accountRevision;
    const t = await readToken();
    if (!t?.accessToken) return res.json({ enabled: true, signedIn: false });
    const now = Date.now();
    if (profileCache.data && (now - profileCache.time) < PROFILE_CACHE_MS) return res.json(profileCache.data);
    try {
      // Step 1: get UID
      const { data: pref } = await requestCloud('https://api.bambulab.com/v1/design-user-service/my/preference', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${t.accessToken}` },
      });
      if (!pref.uid) throw new Error('No UID in preference response');

      // Step 2: get full profile
      const { data: p } = await requestCloud(`https://api.bambulab.com/v1/design-user-service/user/profile/${pref.uid}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${t.accessToken}` },
      });
      const out = {
        handle: p.handle || '',
        avatar: p.avatar || '',
        fanCount: p.fanCount || 0,
        followCount: p.followCount || 0,
        likeCount: p.likeCount || 0,
        collectionCount: p.collectionCount || 0,
        downloadCount: p.downloadCount || 0,
        boostGained: p.boostGained || 0,
      };
      if (revision !== accountRevision) return res.json({ enabled: cloudEnabled(), signedIn: false });
      profileCache = { time: now, data: out };
      res.json(out);
    } catch (e) {
      log(`profile-info error: ${e.message}`);
      res.json({ enabled: true, error: e.message });
    }
  });

  return router;
}

module.exports = { buildAuthRouter };
