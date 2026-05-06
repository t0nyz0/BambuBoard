// Bambu Cloud auth routes — gated by config.cloudAuth.enabled.
// When disabled, the routes return LAN-only stubs (always succeed).
// Ported from BamubBoard-H2D/bambuConnection.js, simplified.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const fetch = require('node-fetch');

function buildAuthRouter({ getConfig, paths }) {
  const router = express.Router();
  const TOKEN_PATH = path.join(paths.data, 'accessToken.json');
  const log = (msg) => {
    if (process.env.BAMBUBOARD_LOGGING || getConfig().BambuBoard_logging) {
      console.log(`[bambuboard:auth] ${msg}`);
    }
  };

  function cloudEnabled() {
    return !!getConfig().cloudAuth?.enabled;
  }

  async function readToken() {
    try { return JSON.parse(await fsp.readFile(TOKEN_PATH, 'utf-8')); }
    catch (_) { return null; }
  }
  async function writeToken(t) {
    await fsp.writeFile(TOKEN_PATH, JSON.stringify(t, null, 2));
  }
  async function clearToken() {
    try { await fsp.unlink(TOKEN_PATH); } catch (_) {}
  }

  // Status: signed-in or not
  router.get('/auth/status', async (req, res) => {
    if (!cloudEnabled()) return res.json({ enabled: false, signedIn: false });
    const t = await readToken();
    res.json({ enabled: true, signedIn: !!(t && t.accessToken), email: t?.email || null });
  });

  // Send verification code (cloud-mode only)
  router.post('/sendVerificationCode', async (req, res) => {
    if (!cloudEnabled()) return res.json({ ok: true, lan: true });
    const { username } = req.body || {};
    try {
      const r = await fetch('https://api.bambulab.com/v1/user-service/user/sendemail/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: username, type: 'codeLogin' }),
      });
      if (!r.ok) throw new Error(`Bambu API: ${r.status}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Verify (email + code) — returns token info
  router.post('/verify', async (req, res) => {
    if (!cloudEnabled()) return res.json({ ok: true, lan: true });
    const { username, code } = req.body || {};
    try {
      const r = await fetch('https://bambulab.com/api/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: username, code }),
      });
      const data = await r.json();
      if (data.accessToken) {
        await writeToken({ accessToken: data.accessToken, refreshToken: data.refreshToken, email: username });
        return res.json({ ok: true });
      }
      if (data.loginType === 'tfa' || data.tfaKey) {
        return res.json({ ok: false, mfa: true, tfaKey: data.tfaKey });
      }
      res.json({ ok: false, error: data.message || 'Verification failed' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // MFA
  router.post('/mfa', async (req, res) => {
    if (!cloudEnabled()) return res.json({ ok: true, lan: true });
    const { tfaKey, tfaCode } = req.body || {};
    try {
      const r = await fetch('https://bambulab.com/api/sign-in/tfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tfaKey, tfaCode }),
      });
      const cookies = r.headers.raw()['set-cookie'] || [];
      const token = cookies.map(c => c.split(';')[0]).find(c => c.startsWith('token='));
      if (!token) return res.json({ ok: false, error: 'No token in MFA response' });
      const accessToken = token.replace(/^token=/, '');
      await writeToken({ accessToken, email: null });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/auth/signout', async (req, res) => {
    await clearToken();
    res.json({ ok: true });
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
  let imageCache = { time: 0, data: null };
  const IMAGE_CACHE_MS = 30_000; // 30s — the widget polls every 5s, no need to hit the API that often

  router.get('/login-and-fetch-image', async (req, res) => {
    if (!cloudEnabled()) return res.json({ imageUrl: '/assets/plate.png' });
    const t = await readToken();
    if (!t?.accessToken) return res.json({ imageUrl: 'NOTENROLLED' });
    const now = Date.now();
    if (imageCache.data && (now - imageCache.time) < IMAGE_CACHE_MS) return res.json(imageCache.data);
    try {
      const r = await fetch('https://api.bambulab.com/v1/user-service/my/tasks', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${t.accessToken}` },
      });
      if (!r.ok) throw new Error(`Bambu API: ${r.status}`);
      const data = await r.json();
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
      imageCache = { time: now, data: out };
      res.json(out);
    } catch (e) {
      log(`login-and-fetch-image error: ${e.message}`);
      res.json({ imageUrl: '/assets/plate.png' });
    }
  });

  // Profile info — fetches MakerWorld profile (avatar, followers, likes, etc.).
  // Two-step: first get UID from /my/preference, then full profile from /user/profile/:uid.
  let profileCache = { time: 0, data: null };
  const PROFILE_CACHE_MS = 10 * 60_000; // 10 min — profile stats don't change fast

  router.get('/profile-info', async (req, res) => {
    if (!cloudEnabled()) return res.json({ enabled: false });
    const t = await readToken();
    if (!t?.accessToken) return res.json({ enabled: true, signedIn: false });
    const now = Date.now();
    if (profileCache.data && (now - profileCache.time) < PROFILE_CACHE_MS) return res.json(profileCache.data);
    try {
      // Step 1: get UID
      const r1 = await fetch('https://api.bambulab.com/v1/design-user-service/my/preference', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${t.accessToken}` },
      });
      if (!r1.ok) throw new Error(`preference API: ${r1.status}`);
      const pref = await r1.json();
      if (!pref.uid) throw new Error('No UID in preference response');

      // Step 2: get full profile
      const r2 = await fetch(`https://api.bambulab.com/v1/design-user-service/user/profile/${pref.uid}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${t.accessToken}` },
      });
      if (!r2.ok) throw new Error(`profile API: ${r2.status}`);
      const p = await r2.json();
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
