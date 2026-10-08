// One managed encoder per app instance. Browser producers use a framed
// control/data protocol; server producers render the local published scene.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StreamEncoder, StreamError, settings, PROFILES, LIMITS } = require('../services/streamEncoder');
const { captureScene, browserPath } = require('../services/streamCapture');
const { checkSetup } = require('../services/streamCheck');

function sameOrigin(req) {
  if (!req.headers.origin) return true; // CLI clients do not send Origin.
  try {
    const origin = new URL(req.headers.origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return /^https?:$/.test(origin.protocol) && origin.host === host;
  } catch (_) { return false; }
}
function buildStreamRouter({ app, paths, allowLocal = false, createEncoder, createCapture = captureScene, preflight = checkSetup, retryDelays = [1000, 3000, 10000] }) {
  let active = null, latest = null, persistQueue = Promise.resolve(), persistedState = '', persistedAt = 0;
  const diagnosticPath = paths?.data ? path.join(paths.data, 'stream-diagnostics.json') : null;
  const capabilities = () => ({ serverCapture: !!browserPath(), browserRelay: typeof app.ws === 'function', profiles: PROFILES, maxBitrate: 25000, retries: retryDelays.length });
  const snapshot = lease => {
    if (!lease) return { state: 'idle' };
    return { ...(lease.encoder?.snapshot() || { profile: lease.options.profile, source: lease.options.source, destination: lease.options.destination, hasAudio: lease.options.hasAudio }),
      id: lease.id, state: lease.state, startedAt: lease.createdAt, elapsedMs: Date.now() - lease.createdAt, attempt: lease.attempt, error: lease.error || lease.encoder?.error || null };
  };
  const diagnostics = () => {
    const lease = active || latest;
    return { schema: 1, capturedAt: new Date().toISOString(), session: snapshot(lease), events: [...(lease?.logs || []), ...(lease?.encoder?.logs || [])].slice(-100) };
  };
  function persist(force = false) {
    if (!diagnosticPath) return;
    const state = (active || latest)?.state;
    if (!force && state === persistedState && Date.now() - persistedAt < 3000) return;
    persistedAt = Date.now(); persistedState = state;
    const data = JSON.stringify(diagnostics());
    persistQueue = persistQueue.then(async () => { await fs.mkdir(paths.data, { recursive: true }); await fs.writeFile(diagnosticPath + '.tmp', data); await fs.rename(diagnosticPath + '.tmp', diagnosticPath); }).catch(() => {});
  }
  const send = (ws, message) => { try { if (ws?.readyState === 1) ws.send(JSON.stringify(message)); } catch (_) {} };
  function publish(lease) { send(lease.ws, { type: 'status', ...snapshot(lease) }); persist(); }
  function claim(options, ws) {
    if (active) throw new StreamError('BUSY', 'A stream is already running or stopping. Stop it before starting another.');
    const lease = { id: randomUUID(), options, ws, createdAt: Date.now(), state: 'starting', attempt: 0, abort: new AbortController(), logs: [], encoder: null, error: null, cancelled: false };
    active = latest = lease; persist(true); return lease;
  }
  async function release(lease) {
    if (lease.released) return; lease.released = true;
    clearTimeout(lease.retryTimer); lease.abort.abort();
    await Promise.allSettled([lease.captureTask, lease.capture?.stop()]);
    lease.options.key = ''; lease.options.url = '';
    if (active === lease) active = null;
    latest = lease; persist(true);
  }
  async function stopLease(lease) {
    if (!lease) return;
    if (lease.stopTask) return lease.stopTask;
    lease.stopTask = finishStop(lease);
    return lease.stopTask;
  }
  async function finishStop(lease) {
    lease.cancelled = true; lease.state = 'stopping'; publish(lease);
    clearTimeout(lease.retryTimer); lease.abort.abort();
    await Promise.allSettled([lease.captureTask, lease.capture?.stop(), lease.encoder?.stop()]);
    lease.state = 'stopped'; lease.error = null; publish(lease);
    await release(lease); send(lease.ws, { type: 'ended', ...snapshot(lease) });
    try { lease.ws?.close(1000, 'Stopped'); } catch (_) {}
  }
  function startCapture(lease) {
    lease.captureTask = createCapture({ origin: lease.origin, profile: lease.options.profile, signal: lease.abort.signal,
      onFrame: frame => { if (active === lease && !lease.cancelled) lease.encoder?.write(frame); },
      onWarning: message => { lease.logs.push({ at: new Date().toISOString(), text: message }); lease.logs = lease.logs.slice(-70); },
      onFailure: error => { if (!lease.cancelled) lease.encoder?.fail(error); },
    }).then(async capture => {
      if (lease.cancelled || lease.released) await capture.stop(); else lease.capture = capture;
    }).catch(error => { if (!lease.cancelled) lease.encoder?.fail(error instanceof StreamError ? error : new StreamError('CAPTURE_BROWSER', 'Server capture could not start.')); });
  }
  function startEncoder(lease) {
    const encoder = createEncoder ? createEncoder(lease.options) : new StreamEncoder(lease.options);
    lease.encoder = encoder; lease.error = null; lease.state = 'starting';
    encoder.on('status', status => {
      if (lease.encoder !== encoder || lease.cancelled || lease.state === 'reconnecting') return;
      lease.state = status.state; lease.error = status.error; publish(lease);
    });
    encoder.on('ready', () => send(lease.ws, { type: 'ready', ...snapshot(lease) }));
    encoder.on('failure', error => {
      lease.error = error;
      send(lease.ws, { type: 'error', ...error });
      // A browser must create a new MediaRecorder/container header for each
      // encoder. JPEG server frames are independent and can resume directly.
      if (lease.options.source === 'browser') return;
      if (!lease.cancelled && error.retryable && lease.attempt < retryDelays.length) lease.state = 'reconnecting';
      else lease.state = 'error';
      publish(lease);
    });
    encoder.once('finished', async () => {
      if (lease.cancelled || lease.encoder !== encoder) return;
      if (lease.options.source === 'server' && lease.state === 'reconnecting') {
        const delay = retryDelays[lease.attempt++];
        const restartCapture = lease.error?.code === 'CAPTURE_BROWSER';
        lease.logs.push(...encoder.logs.slice(-15)); lease.logs = lease.logs.slice(-70); publish(lease);
        lease.retryTimer = setTimeout(async () => {
          if (lease.cancelled || active !== lease) return;
          if (restartCapture) { await lease.captureTask; await lease.capture?.stop().catch(() => {}); lease.capture = null; }
          if (lease.cancelled || active !== lease) return;
          startEncoder(lease); if (restartCapture) startCapture(lease);
        }, delay); lease.retryTimer.unref();
        return;
      }
      lease.state = encoder.error ? 'error' : 'stopped';
      await release(lease);
      send(lease.ws, { type: 'ended', ...snapshot(lease) });
      try { lease.ws?.close(encoder.error?.retryable ? 1013 : 1000, 'Encoder ended'); } catch (_) {}
    });
    encoder.start(); return encoder;
  }
  function reject(res, error) { res.status(error.code === 'BUSY' ? 409 : 400).json({ error: { code: error.code || 'STREAM', message: error.message, retryable: !!error.retryable } }); }
  const mutation = (req, res, next) => { if (!sameOrigin(req)) return res.status(403).json({ error: { code: 'ORIGIN', message: 'Open streaming controls from this BambuBoard installation.' } }); next(); };
  app.get('/api/stream/youtube/status', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ capabilities: capabilities(), session: snapshot(active || latest), active: !!active }); });
  app.get('/api/stream/youtube/diagnostics', async (_req, res) => {
    let report = diagnostics();
    if (!active && !latest && diagnosticPath) try { report = JSON.parse(await fs.readFile(diagnosticPath, 'utf8')); } catch (_) {}
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="bambuboard-stream-diagnostics.json"' }).json(report);
  });
  let checking = false;
  app.post('/api/stream/youtube/check', mutation, async (req, res) => {
    if (checking || active) return res.status(409).json({ error: { code: 'BUSY', message: 'Wait for the current check or stream to finish.' } });
    checking = true;
    try { res.json(await preflight({ source: req.body?.source === 'server' ? 'server' : 'browser', destination: req.body?.destination === 'backup' ? 'backup' : 'primary' })); }
    catch (error) { reject(res, error); }
    finally { checking = false; }
  });
  app.post('/api/stream/youtube/start', mutation, (req, res) => {
    let lease;
    try {
      const options = settings({ ...req.body, source: 'server', hasAudio: false }, allowLocal);
      if (!browserPath() && createCapture === captureScene) throw new StreamError('BROWSER_MISSING', 'Server capture needs Chromium. Use a Docker image containing Chromium or configure BAMBUBOARD_CHROMIUM_BIN.');
      lease = claim(options);
      lease.origin = `http://127.0.0.1:${req.socket.localPort}`;
      startEncoder(lease);
      // Loopback and the actual listening port are fixed here, never supplied
      // by the requester or reverse-proxy headers.
      startCapture(lease);
      res.status(202).json({ session: snapshot(lease) });
    } catch (error) { reject(res, error); }
  });
  app.post('/api/stream/youtube/stop', mutation, async (req, res) => {
    if (active && req.body?.id !== active.id) return res.status(409).json({ error: { code: 'SESSION_CHANGED', message: 'The stream changed. Refresh the controls before stopping it.' } });
    await stopLease(active); res.json({ session: snapshot(latest), active: !!active });
  });
  if (typeof app.ws === 'function') app.ws('/api/stream/youtube', (ws, req) => {
    let lease, lastPong = Date.now();
    const initial = setTimeout(() => { send(ws, { type: 'error', code: 'CONTROL_TIMEOUT', message: 'Stream settings were not received in time.' }); ws.close(1008); }, 10000); initial.unref();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 20000) return ws.terminate();
      try { ws.ping(); } catch (_) {}
    }, 5000); heartbeat.unref();
    if (!sameOrigin(req)) { clearTimeout(initial); clearInterval(heartbeat); send(ws, { type: 'error', code: 'ORIGIN', message: 'Open streaming controls from this BambuBoard installation.' }); ws.close(1008); return; }
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('error', () => { if (lease && !lease.cancelled) void stopLease(lease); });
    ws.on('message', (data, binary) => {
      try {
        // express-ws currently uses ws 7 (string text messages, Buffer video).
        // ws 8 instead supplies the explicit isBinary flag for both types.
        const isBinary = typeof binary === 'boolean' ? binary : typeof data !== 'string';
        if (!lease) {
          if (isBinary || data.length > 4096) throw new StreamError('CONTROL', 'Send stream settings before video data.');
          let input; try { input = JSON.parse(data.toString()); } catch (_) { throw new StreamError('CONTROL', 'Stream settings must be valid JSON.'); }
          lease = claim(settings({ ...input, source: 'browser' }, allowLocal), ws); clearTimeout(initial); startEncoder(lease); return;
        }
        if (!isBinary) {
          if (data.length <= 100 && JSON.parse(data.toString()).type === 'stop') void stopLease(lease);
          else lease.encoder.fail(new StreamError('CONTROL', 'Unexpected control message during streaming.'));
          return;
        }
        lease.encoder.write(data);
      } catch (error) {
        send(ws, { type: 'error', code: error.code || 'CONTROL', message: error.code ? error.message : 'Stream settings could not be read.', retryable: false });
        ws.close(1008);
      }
    });
    ws.on('close', () => {
      clearTimeout(initial); clearInterval(heartbeat);
      if (lease && !lease.cancelled && !lease.encoder.error && !lease.encoder.finished) void stopLease(lease);
    });
  });
  return {
    stop: async () => { await stopLease(active); await persistQueue; },
    forceStop: () => { active?.abort.abort(); try { active?.encoder?.child?.kill('SIGKILL'); } catch (_) {} },
    status: () => snapshot(active || latest),
  };
}
module.exports = { buildStreamRouter, sameOrigin };
