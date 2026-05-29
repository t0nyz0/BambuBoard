// YouTube Live Streaming integration — OAuth 2.0 + Data API v3.
//
// This is the "Connect account" path (what OBS calls Manage Broadcast): instead
// of pushing blindly to a stream key, BambuBoard signs into the user's Google
// account and uses the YouTube Data API to create a broadcast with real metadata
// (title, description, privacy, made-for-kids, latency), create + bind an ingest
// stream, and let YouTube auto-start/stop the broadcast when our ffmpeg push
// begins/ends. Completed broadcasts auto-archive as VODs on the channel.
//
// Deliberately dependency-light: plain REST over node-fetch (already a dep), no
// googleapis SDK. Tokens persist in data/youtube-token.json so a one-time
// browser consent (done from localhost — see routes/youtube.js) keeps working
// for headless/remote streaming afterward.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';

// ---- token storage -------------------------------------------------------

function tokenPath(dataDir) {
  return path.join(dataDir, 'youtube-token.json');
}

function loadToken(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(dataDir), 'utf-8'));
  } catch (_) {
    return null;
  }
}

function saveToken(dataDir, tok) {
  fs.writeFileSync(tokenPath(dataDir), JSON.stringify(tok, null, 2));
}

function clearToken(dataDir) {
  try { fs.unlinkSync(tokenPath(dataDir)); } catch (_) {}
}

function isConnected(dataDir) {
  const t = loadToken(dataDir);
  return !!(t && t.refresh_token);
}

// ---- OAuth flow ----------------------------------------------------------

// Build the Google consent URL. `state` is opaque (we round-trip the redirect
// URI through it so the callback can reuse the exact same value Google saw).
function buildAuthUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',     // we want a refresh_token
    include_granted_scopes: 'true',
    prompt: 'consent',          // force refresh_token even on re-consent
    state: state || '',
  });
  return `${AUTH_URL}?${q.toString()}`;
}

// Exchange an authorization code for tokens and persist them.
async function exchangeCode(dataDir, { clientId, clientSecret, redirectUri, code }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || `token exchange failed (${r.status})`);
  const tok = {
    access_token: j.access_token,
    refresh_token: j.refresh_token, // present because access_type=offline + prompt=consent
    expiry_date: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope,
    token_type: j.token_type,
  };
  // Preserve an existing refresh_token if Google omits it on re-consent.
  if (!tok.refresh_token) {
    const prev = loadToken(dataDir);
    if (prev && prev.refresh_token) tok.refresh_token = prev.refresh_token;
  }
  saveToken(dataDir, tok);
  return tok;
}

// Return a valid access token, refreshing if it's expired/near-expiry.
async function getAccessToken(dataDir, { clientId, clientSecret }) {
  let tok = loadToken(dataDir);
  if (!tok || !tok.refresh_token) throw new Error('YouTube account not connected');
  if (tok.access_token && tok.expiry_date && Date.now() < tok.expiry_date - 60000) {
    return tok.access_token;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tok.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok) {
    // refresh_token revoked/expired → force a reconnect.
    if (j.error === 'invalid_grant') clearToken(dataDir);
    throw new Error(j.error_description || j.error || `token refresh failed (${r.status})`);
  }
  tok = {
    ...tok,
    access_token: j.access_token,
    expiry_date: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope || tok.scope,
  };
  saveToken(dataDir, tok);
  return tok.access_token;
}

// ---- API helper ----------------------------------------------------------

async function apiCall(accessToken, method, pathAndQuery, body) {
  const r = await fetch(`${API}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && (j.error.message || (j.error.errors && j.error.errors[0] && j.error.errors[0].reason)))
      || `YouTube API ${method} ${pathAndQuery} failed (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.detail = j.error;
    throw err;
  }
  return j;
}

// Return the connected channel (for showing "Streaming as <name>").
async function getChannel(dataDir, creds) {
  const at = await getAccessToken(dataDir, creds);
  const j = await apiCall(at, 'GET', '/channels?part=snippet&mine=true');
  const ch = (j.items && j.items[0]) || null;
  return ch ? { id: ch.id, title: ch.snippet && ch.snippet.title } : null;
}

// Create a broadcast + ingest stream, bind them, and return what the relay
// needs to push. enableAutoStart/Stop means YouTube flips the broadcast live
// when our ffmpeg data arrives and ends it when the stream stops — no manual
// state transitions required.
async function createBroadcast(dataDir, creds, opts) {
  const {
    title, description = '', privacy = 'unlisted',
    madeForKids = false, latency = 'normal',
  } = opts || {};
  if (!title || !title.trim()) throw new Error('A broadcast title is required');

  const at = await getAccessToken(dataDir, creds);
  const startISO = new Date(Date.now() + 5000).toISOString(); // required; ~now

  // 1) Broadcast (the metadata + lifecycle).
  const broadcast = await apiCall(at, 'POST',
    '/liveBroadcasts?part=snippet,status,contentDetails',
    {
      snippet: { title: title.slice(0, 100), description: String(description).slice(0, 5000), scheduledStartTime: startISO },
      status: {
        privacyStatus: ['public', 'unlisted', 'private'].includes(privacy) ? privacy : 'unlisted',
        selfDeclaredMadeForKids: !!madeForKids,
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        latencyPreference: ['normal', 'low', 'ultraLow'].includes(latency) ? latency : 'normal',
      },
    });

  // 2) Ingest stream (the RTMP endpoint we push to).
  const stream = await apiCall(at, 'POST',
    '/liveStreams?part=snippet,cdn,contentDetails',
    {
      snippet: { title: `${title.slice(0, 90)} — ingest` },
      cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
      contentDetails: { isReusable: false },
    });

  // 3) Bind broadcast ↔ stream.
  await apiCall(at, 'POST',
    `/liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}&part=id,contentDetails`);

  const ingestion = (stream.cdn && stream.cdn.ingestionInfo) || {};
  return {
    broadcastId: broadcast.id,
    streamId: stream.id,
    rtmpBase: ingestion.ingestionAddress,   // e.g. rtmp://a.rtmp.youtube.com/live2
    streamKey: ingestion.streamName,
    watchUrl: `https://www.youtube.com/watch?v=${broadcast.id}`,
    studioUrl: `https://studio.youtube.com/video/${broadcast.id}/livestreaming`,
    title: broadcast.snippet && broadcast.snippet.title,
    privacy: broadcast.status && broadcast.status.privacyStatus,
  };
}

// Best-effort manual end (autoStop usually handles this when the push stops).
async function endBroadcast(dataDir, creds, broadcastId) {
  if (!broadcastId) return;
  const at = await getAccessToken(dataDir, creds);
  try {
    await apiCall(at, 'POST',
      `/liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(broadcastId)}&part=status`);
  } catch (e) {
    // Already complete / not yet live → ignore; autoStop covers the common case.
    if (e.status && e.status !== 403 && e.status !== 400) throw e;
  }
}

module.exports = {
  SCOPE,
  isConnected,
  loadToken,
  clearToken,
  buildAuthUrl,
  exchangeCode,
  getAccessToken,
  getChannel,
  createBroadcast,
  endBroadcast,
};
