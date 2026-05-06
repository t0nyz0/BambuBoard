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

function buildVideoRouter({ app, getConfig, dataPath }) {
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

    // WS /api/printer/video — WebSocket MPEG-TS stream
    const proxy = createProxy({
      url: () => {
        const config = getConfig();
        const p = config.printer || {};
        return `rtsps://bblp:${p.accessCode}@${p.url}:322/streaming/live/1`;
      },
      transport: 'tcp',
      additionalFlags: [
        '-rtsp_transport', 'tcp',
        '-allowed_media_types', 'video',
        // Don't buffer too much — keep latency low
        '-fflags', 'nobuffer',
        '-analyzeduration', '1000000',
        '-probesize', '500000',
      ],
    });

    app.ws('/api/printer/video', proxy);

    console.log('[bambuboard] RTSP video relay ready at ws://*/api/printer/video');
  } catch (err) {
    console.warn('[bambuboard] RTSP video relay unavailable:', err.message);
    // Fallback endpoints when rtsp-relay isn't installed or fails
    app.get('/api/printer/video/status', (req, res) => {
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
