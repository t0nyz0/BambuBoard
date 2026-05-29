// Server-side RTSP video relay.
//
// Proxies the printer's RTSP camera feed through the Express server so that
// browser clients (scene editor, dashboard) can view it without needing
// ffmpeg or VLC locally. Uses rtsp-relay which spawns an ffmpeg process to
// transcode RTSP → MPEG-TS over WebSocket, decoded client-side by JSMpeg.
//
// Endpoint: WS /api/printer/video (WebSocket, used by JSMpeg client)
// Endpoint: GET /api/printer/video/status (JSON health check — reads MQTT
//           data to see if rtsp_url is enabled on the printer)
//
// The RTSP URL for Bambu printers is:
//   rtsps://bblp:{accessCode}@{ip}:322/streaming/live/1
//
// The printer must have LAN Mode Liveview enabled (on touchscreen:
// Settings → Network → LAN Mode Liveview → ON). When disabled, the MQTT
// telemetry reports ipcam.rtsp_url = "disable" and port 322 is closed.
//
// ffmpeg handles RTSPS (RTSP over TLS) natively and doesn't verify self-signed
// certs by default, so Bambu's self-signed TLS works out of the box.

const path = require('path');
const fs = require('fs');
const { capsFor } = require('../lib/caps');

function buildVideoRouter({ app, getConfig, dataPath }) {
  // Grace window: keep a stream (ffmpeg / chamber socket) alive this long after
  // the last viewer leaves, so brief client gaps (reloads, OBS restarts) reuse
  // it instead of churning the printer's limited camera connection.
  const GRACE_MS = 20000;

  // Camera status, capability-aware. X1 / X1C / H2D / P2S expose RTSP (relayed
  // via ffmpeg + WebSocket/JSMpeg); P1 / A1-class expose the port-6000 JPEG
  // stream (served as MJPEG). `cameraType` tells the widget which to use.
  function buildCameraStatus(printer, rtspRelayOk) {
    const caps = capsFor(printer.type);
    const hasCredentials = !!(printer.url && printer.accessCode);
    if (!caps.hasCameraRtsp) {
      return {
        available: hasCredentials,
        cameraType: 'image',
        relayReady: true, // MJPEG path is independent of rtsp-relay
        mjpegUrl: '/api/printer/camera.mjpeg',
        hint: hasCredentials ? null : 'Printer credentials not set — finish Setup first.',
      };
    }
    const rtsp = getRtspStatus();
    return {
      available: hasCredentials && rtsp.enabled && rtspRelayOk,
      cameraType: 'rtsp',
      relayReady: rtspRelayOk,
      rtspEnabled: rtsp.enabled,
      resolution: rtsp.resolution,
      url: hasCredentials ? `rtsps://${printer.url}:322/streaming/live/1` : null,
      hint: !rtspRelayOk
        ? 'The video relay (ffmpeg) failed to initialize on the server.'
        : (!rtsp.enabled
          ? 'Camera reports RTSP disabled. On the printer touchscreen: Settings → Network → LAN Only Liveview → ON, then reboot. Some firmware versions may require an update.'
          : null),
    };
  }

  // Read current MQTT data to check ipcam.rtsp_url status.
  function getRtspStatus() {
    try {
      const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      const ipcam = (raw.print || {}).ipcam || {};
      const rtspField = ipcam.rtsp_url || '';
      // rtsp_url is either "disable" or an actual URL like "rtsps://ip/streaming/live/1"
      const enabled = rtspField !== 'disable' && rtspField !== '';
      return { enabled, rtspField, resolution: ipcam.resolution || null };
    } catch (_) {
      return { enabled: false, rtspField: null, resolution: null };
    }
  }

  // ── Chamber-image (P1 / A1) MJPEG endpoint ──
  // One shared TLS stream per printer, fanned out to all viewers as
  // multipart/x-mixed-replace JPEG (which <img> renders natively). Same grace
  // period as the RTSP relay so brief client gaps don't churn the port-6000
  // connection. Independent of rtsp-relay, so it works even if that failed.
  const { ChamberImageStream } = require('../lib/chamberImage');
  const chamber = { stream: null, clients: 0, grace: null, key: '' };

  function ensureChamberStream(printer) {
    const key = `${printer.url}|${printer.accessCode}`;
    if (chamber.stream && chamber.key !== key) { chamber.stream.stop(); chamber.stream = null; }
    if (!chamber.stream) {
      chamber.key = key;
      chamber.stream = new ChamberImageStream({ host: printer.url, accessCode: printer.accessCode });
      chamber.stream.on('error', () => {}); // reconnects internally; don't crash
      chamber.stream.start();
    }
    return chamber.stream;
  }

  app.get('/api/printer/camera.mjpeg', (req, res) => {
    const printer = getConfig().printer || {};
    if (capsFor(printer.type).hasCameraRtsp) {
      return res.status(404).json({ error: 'This printer uses RTSP; connect to the WebSocket relay instead.' });
    }
    if (!printer.url || !printer.accessCode) {
      return res.status(503).json({ error: 'Printer credentials not set.' });
    }
    const BOUNDARY = 'bambuframe';
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });

    if (chamber.grace) { clearTimeout(chamber.grace); chamber.grace = null; }
    const stream = ensureChamberStream(printer);
    chamber.clients += 1;

    const onFrame = (jpeg) => {
      if (res.writableEnded) return;
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n');
    };
    if (stream.lastFrame) onFrame(stream.lastFrame); // paint immediately
    stream.on('frame', onFrame);

    req.on('close', () => {
      stream.removeListener('frame', onFrame);
      chamber.clients -= 1;
      if (chamber.clients <= 0 && !chamber.grace) {
        chamber.grace = setTimeout(() => {
          chamber.grace = null;
          if (chamber.clients <= 0 && chamber.stream) { chamber.stream.stop(); chamber.stream = null; }
        }, GRACE_MS);
      }
    });
  });

  try {
    const rtspRelay = require('rtsp-relay');
    const { proxy: createProxy } = rtspRelay(app);

    // GET /api/printer/video/status — health check
    app.get('/api/printer/video/status', (req, res) => {
      res.json(buildCameraStatus(getConfig().printer || {}, true));
    });

    // WS /api/printer/video — WebSocket MPEG-TS stream.
    //
    // IMPORTANT: rtsp-relay's `url` option must be a STRING. Earlier this was
    // a function (`url: () => …`), but rtsp-relay (1.9.0) never invokes it —
    // it uses `url` verbatim as both the Inbound map key and the ffmpeg `-i`
    // argument. A function coerced to a string yields garbage, so ffmpeg
    // failed to open the input instantly and the relay produced no video
    // (clients only ever received rtsp-relay's 8-byte `jsmp` header). We now
    // build the URL string from the current config per WebSocket connection
    // and cache one proxy per resolved URL, so rtsp-relay still shares a
    // single ffmpeg across viewers AND a printer IP/access-code change is
    // picked up on the next connection (a new URL → a new cached proxy).
    function buildStreamUrl() {
      const p = getConfig().printer || {};
      return `rtsps://bblp:${p.accessCode}@${p.url}:322/streaming/live/1`;
    }

    const proxyByUrl = {};
    function getProxyFor(url) {
      if (!proxyByUrl[url]) {
        proxyByUrl[url] = createProxy({
          url,
          // `transport: 'tcp'` makes rtsp-relay place `-rtsp_transport tcp`
          // BEFORE `-i` (where it belongs). Do NOT also put it in
          // additionalFlags — those are appended AFTER `-i` and rtsp-relay
          // warns about it.
          transport: 'tcp',
          additionalFlags: [
            '-allowed_media_types', 'video',
            // Keep latency low.
            '-fflags', 'nobuffer',
          ],
        });
      }
      return proxyByUrl[url];
    }

    // ── Reconnect hardening ──
    // rtsp-relay kills ffmpeg the instant the client count hits 0 and respawns
    // on the next connect. Rapid churn (page reloads, OBS source restarts, tab
    // open/close) therefore rapidly tears down + re-pulls the printer's RTSP
    // stream — and Bambu's RTSP server allows only a couple of concurrent
    // connections, so a respawn can race the previous teardown and stall the
    // feed (the "white/black camera" we hit during dev).
    //
    // Fix: hold a server-side keepalive subscriber per stream so ffmpeg stays
    // alive through brief gaps. When the last real viewer leaves we wait
    // GRACE_MS (shared with the chamber-image path) before releasing the
    // holder; a reconnect within the window reuses the still-running ffmpeg.
    const keepalive = {}; // url -> { count, timer, holder }

    // A minimal ws-like object rtsp-relay's handler accepts: it counts as a
    // client (keeping ffmpeg up) and discards the frames it's sent.
    function makeHolder() {
      const h = new (require('events').EventEmitter)();
      h.OPEN = 1;
      h.readyState = 1;
      h.send = () => {};
      h.close = () => { h.readyState = 3; h.emit('close'); };
      return h;
    }

    app.ws('/api/printer/video', (ws, req) => {
      const url = buildStreamUrl();
      const proxy = getProxyFor(url);
      const ka = keepalive[url] || (keepalive[url] = { count: 0, timer: null, holder: null });
      if (ka.timer) { clearTimeout(ka.timer); ka.timer = null; } // cancel pending release
      if (!ka.holder) { ka.holder = makeHolder(); proxy(ka.holder, req); } // pin ffmpeg up
      ka.count += 1;
      ws.on('close', () => {
        ka.count -= 1;
        if (ka.count <= 0 && !ka.timer) {
          ka.timer = setTimeout(() => {
            ka.timer = null;
            if (ka.count <= 0 && ka.holder) { ka.holder.close(); ka.holder = null; }
          }, GRACE_MS);
        }
      });
      return proxy(ws, req);
    });

    console.log('[bambuboard] RTSP video relay ready at ws://*/api/printer/video');
  } catch (err) {
    console.warn('[bambuboard] RTSP video relay unavailable:', err.message);
    // Fallback status when rtsp-relay isn't available. Image-camera printers
    // (P1/A1) still work via the MJPEG path, which doesn't use rtsp-relay.
    app.get('/api/printer/video/status', (req, res) => {
      res.json(buildCameraStatus(getConfig().printer || {}, false));
    });
  }
}

module.exports = { buildVideoRouter };
