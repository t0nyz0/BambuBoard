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
  // Printers without an RTSP camera (P1 / A1-class use a different port-6000
  // protocol BambuBoard doesn't relay). Returns an accurate status so the
  // camera widget shows a model-appropriate message instead of telling the
  // user to enable LAN Liveview (which does nothing on those printers).
  function unsupportedCameraStatus(printer) {
    const caps = capsFor(printer.type);
    if (caps.hasCameraRtsp) return null;
    return {
      available: false,
      relayReady: true,
      rtspEnabled: false,
      cameraSupported: false,
      resolution: null,
      url: null,
      hint: `Live camera isn't supported on this printer model (${printer.type || 'unknown'}) yet — BambuBoard relays the RTSP stream that X1 / X1C / H2D expose. P1 / A1-class printers use a different camera protocol.`,
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

  try {
    const rtspRelay = require('rtsp-relay');
    const { proxy: createProxy } = rtspRelay(app);

    // GET /api/printer/video/status — health check
    app.get('/api/printer/video/status', (req, res) => {
      const config = getConfig();
      const printer = config.printer || {};
      const unsupported = unsupportedCameraStatus(printer);
      if (unsupported) return res.json(unsupported);
      const hasCredentials = !!(printer.url && printer.accessCode);
      const rtsp = getRtspStatus();

      res.json({
        available: hasCredentials && rtsp.enabled,
        relayReady: true,
        rtspEnabled: rtsp.enabled,
        resolution: rtsp.resolution,
        url: hasCredentials
          ? `rtsps://${printer.url}:322/streaming/live/1`
          : null,
        hint: !rtsp.enabled
          ? 'Camera reports RTSP disabled. On the printer touchscreen: Settings → Network → LAN Only Liveview → ON, then reboot. Some firmware versions may require an update.'
          : null,
      });
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

    app.ws('/api/printer/video', (ws, req) => {
      const url = buildStreamUrl();
      return getProxyFor(url)(ws, req);
    });

    console.log('[bambuboard] RTSP video relay ready at ws://*/api/printer/video');
  } catch (err) {
    console.warn('[bambuboard] RTSP video relay unavailable:', err.message);
    // Fallback endpoints when rtsp-relay isn't installed or fails
    app.get('/api/printer/video/status', (req, res) => {
      const unsupported = unsupportedCameraStatus((getConfig().printer) || {});
      if (unsupported) return res.json(unsupported);
      const rtsp = getRtspStatus();
      res.json({
        available: false,
        relayReady: false,
        rtspEnabled: rtsp.enabled,
        error: 'rtsp-relay not available: ' + err.message,
        hint: !rtsp.enabled
          ? 'Camera reports RTSP disabled. On the printer touchscreen: Settings → Network → LAN Only Liveview → ON, then reboot.'
          : 'The rtsp-relay package failed to initialize.',
      });
    });
  }
}

module.exports = { buildVideoRouter };
