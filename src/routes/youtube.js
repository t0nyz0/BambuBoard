// YouTube broadcast-management routes — the "Connect account" path.
//
//   GET  /api/youtube/status          → { clientConfigured, connected, channel? }
//   GET  /api/youtube/oauth/start      → 302 to Google consent
//   GET  /api/youtube/oauth/callback   → exchanges code, stores token, 302 back to /
//   POST /api/youtube/disconnect       → forget the stored token
//   POST /api/youtube/broadcast        → create broadcast+stream+bind; returns ingest + watch URL
//   POST /api/youtube/end              → best-effort transition the broadcast to "complete"
//
// The browser still does the actual streaming over WS /api/stream/youtube using
// the rtmpBase + streamKey this route hands back. Title/description/privacy/
// made-for-kids/latency are set here via the API.

const crypto = require('crypto');
const express = require('express');
const yt = require('../lib/youtube');

function buildYouTubeRouter({ getConfig, dataDir }) {
  const router = express.Router();

  // Short-lived CSRF state values for the OAuth round-trip.
  const pendingStates = new Map(); // state → expiry ms
  const STATE_TTL = 10 * 60 * 1000;
  function newState() {
    const s = crypto.randomBytes(16).toString('hex');
    pendingStates.set(s, Date.now() + STATE_TTL);
    return s;
  }
  function consumeState(s) {
    const exp = pendingStates.get(s);
    pendingStates.delete(s);
    // prune
    const now = Date.now();
    for (const [k, v] of pendingStates) if (v < now) pendingStates.delete(k);
    return !!exp && exp >= now;
  }

  const creds = () => {
    const y = getConfig().youtube || {};
    return { clientId: y.clientId || '', clientSecret: y.clientSecret || '' };
  };
  const clientConfigured = () => {
    const c = creds();
    return !!c.clientId && !!c.clientSecret;
  };

  // The redirect URI must EXACTLY match one registered on the Google OAuth
  // client. Derive it from the request origin (so localhost works out of the
  // box); allow an explicit override for reverse-proxy / custom-domain setups.
  function redirectUri(req) {
    if (process.env.BAMBUBOARD_YT_REDIRECT) return process.env.BAMBUBOARD_YT_REDIRECT;
    const proto = req.protocol;
    const host = req.get('host');
    return `${proto}://${host}/api/youtube/oauth/callback`;
  }

  router.get('/status', async (req, res) => {
    const out = {
      clientConfigured: clientConfigured(),
      connected: yt.isConnected(dataDir),
      redirectUri: redirectUri(req),
      channel: null,
    };
    if (out.connected && out.clientConfigured) {
      try { out.channel = await yt.getChannel(dataDir, creds()); }
      catch (e) { out.channelError = e.message; }
    }
    res.json(out);
  });

  router.get('/oauth/start', (req, res) => {
    if (!clientConfigured()) return res.redirect('/?yt=notconfigured');
    const url = yt.buildAuthUrl({
      clientId: creds().clientId,
      redirectUri: redirectUri(req),
      state: newState(),
    });
    res.redirect(url);
  });

  router.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query || {};
    if (error) return res.redirect('/?yt=error&msg=' + encodeURIComponent(String(error)));
    if (!code) return res.redirect('/?yt=error&msg=' + encodeURIComponent('No authorization code returned'));
    if (!state || !consumeState(String(state))) {
      return res.redirect('/?yt=error&msg=' + encodeURIComponent('Invalid or expired state — try connecting again'));
    }
    try {
      await yt.exchangeCode(dataDir, {
        ...creds(),
        redirectUri: redirectUri(req),
        code: String(code),
      });
      res.redirect('/?yt=connected');
    } catch (e) {
      res.redirect('/?yt=error&msg=' + encodeURIComponent(e.message));
    }
  });

  router.post('/disconnect', (req, res) => {
    yt.clearToken(dataDir);
    res.json({ ok: true });
  });

  router.post('/broadcast', async (req, res) => {
    if (!clientConfigured()) return res.status(400).json({ ok: false, error: 'YouTube OAuth client not configured (see Setup)' });
    if (!yt.isConnected(dataDir)) return res.status(400).json({ ok: false, error: 'YouTube account not connected' });
    try {
      const b = await yt.createBroadcast(dataDir, creds(), {
        title: req.body && req.body.title,
        description: req.body && req.body.description,
        privacy: req.body && req.body.privacy,
        madeForKids: req.body && req.body.madeForKids,
        latency: req.body && req.body.latency,
      });
      if (!b.rtmpBase || !b.streamKey) {
        return res.status(502).json({ ok: false, error: 'YouTube did not return an ingest address' });
      }
      res.json({ ok: true, ...b });
    } catch (e) {
      res.status(e.status === 401 ? 401 : 500).json({ ok: false, error: e.message });
    }
  });

  router.post('/end', async (req, res) => {
    try {
      await yt.endBroadcast(dataDir, creds(), req.body && req.body.broadcastId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

module.exports = { buildYouTubeRouter };
