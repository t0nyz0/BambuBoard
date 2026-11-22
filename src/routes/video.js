// Server-side RTSP video relay.
//
// Proxies the printer's RTSP camera feed through the Express server so that
// browser clients (scene editor, dashboard) can view it without needing
// ffmpeg or VLC locally. FFmpeg transcodes RTSP to MPEG-TS over WebSocket,
// decoded client-side by JSMpeg.
//
// Endpoint: WS /api/printer/video (WebSocket, used by JSMpeg client)
// Endpoint: GET /api/printer/video/status (configuration and relay state)
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

const fs = require('fs');
const { capsFor } = require('../lib/caps');
const { sameOrigin } = require('../lib/requestOrigin');
const { createRtspCamera, rtspReady } = require('../lib/rtspCamera');

function buildVideoRouter({ app, getConfig, dataPath, getCameraTelemetry, relayOptions }) {
  // Grace window: keep a stream (ffmpeg / chamber socket) alive this long after
  // the last viewer leaves, so brief client gaps (reloads, OBS restarts) reuse
  // it instead of churning the printer's limited camera connection.
  const GRACE_MS = 20000;

  // Camera status, capability-aware. X1 / X1C / H2D / H3C / P2S expose RTSP (relayed
  // via ffmpeg + WebSocket/JSMpeg); P1 / A1-class expose the port-6000 JPEG
  // stream (served as MJPEG). `cameraType` tells the widget which to use.
  function buildCameraStatus(printer) {
    const caps = capsFor(printer.type);
    const hasCredentials = !!(printer.url && printer.accessCode);
    if (!caps.hasCameraRtsp) {
      return {
        available: hasCredentials,
        cameraType: 'image',
        relayReady: true, // MJPEG path is independent of FFmpeg
        mjpegUrl: '/api/printer/camera.mjpeg',
        hint: hasCredentials ? null : 'Printer credentials not set — finish Setup first.',
      };
    }
    const rtsp = getRtspStatus(printer.type);
    const isH3c = printer.type === 'H3C';
    const endpoint = printerCameraEndpoint(printer.url, isH3c ? rtsp.rtspField : undefined);
    const enabled = isH3c ? !!endpoint : rtsp.enabled;
    const state = relay.state();
    const available = hasCredentials && enabled && !!endpoint && rtspReady;
    let hint = null;
    if (!hasCredentials) hint = 'Printer credentials not set. Finish Setup first.';
    else if (!rtspReady) hint = 'The video relay (FFmpeg) failed to initialize on the server.';
    else if (!enabled) hint = isH3c
      ? 'On the H3C touchscreen, turn on Settings → Network → LAN Only Liveview.'
      : 'Camera reports RTSP disabled. On the printer touchscreen: Settings → Network → LAN Only Liveview → ON, then reboot. Some firmware versions may require an update.';
    else if (state === 'reconnecting') hint = 'Waiting for new camera video. Reconnecting automatically.';
    else if (state === 'unavailable') hint = 'The printer is not sending video. Check its network connection and LAN Only Liveview setting.';
    return {
      available,
      state,
      cameraType: 'rtsp',
      relayReady: rtspReady,
      rtspEnabled: enabled,
      resolution: rtsp.resolution,
      url: hasCredentials && !isH3c ? endpoint?.href || null : null,
      hint,
    };
  }

  // H3C publishes a Liveview path and port in MQTT. Keep the configured host
  // and TLS when using that path, so the LAN access code only goes there.
  function printerCameraEndpoint(host, reportedUrl) {
    if (!host) return null;
    try {
      const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      const configured = new URL(`http://${address}`);
      if (!configured.hostname || configured.username || configured.password || configured.port || configured.pathname !== '/' || configured.search || configured.hash) return null;
      if (reportedUrl === undefined) return new URL(`rtsps://${configured.hostname}:322/streaming/live/1`);
      const reported = new URL(reportedUrl);
      if (reported.protocol !== 'rtsps:' || !reported.hostname) return null;
      const endpoint = new URL(`rtsps://${configured.hostname}:${reported.port || '322'}`);
      endpoint.pathname = reported.pathname;
      endpoint.search = reported.search;
      return endpoint;
    } catch (_) {
      return null;
    }
  }

  // Read current MQTT data to check ipcam.rtsp_url status.
  function getRtspStatus(type) {
    try {
      // H3C needs the endpoint supplied by its own MQTT session. A saved
      // data.json may still belong to a different printer after Setup.
      let ipcam = getCameraTelemetry?.();
      if (type !== 'H3C' && (ipcam === undefined || (ipcam && !Object.hasOwn(ipcam, 'rtsp_url')))) {
        // Preserve startup behavior before the first live camera report. Once
        // received, that report survives partial print snapshots on reconnect.
        const savedCamera = JSON.parse(fs.readFileSync(dataPath, 'utf-8')).print?.ipcam;
        ipcam = { ...savedCamera, ...ipcam };
      }
      const rtspField = ipcam?.rtsp_url || '';
      // rtsp_url is either "disable" or an actual URL like "rtsps://ip/streaming/live/1"
      const enabled = rtspField !== 'disable' && rtspField !== '';
      return { enabled, rtspField, resolution: ipcam?.resolution || null };
    } catch (_) {
      return { enabled: false, rtspField: null, resolution: null };
    }
  }

  // ── Chamber-image (P1 / A1) MJPEG endpoint ──
  // One shared TLS stream per printer, fanned out to all viewers as
  // multipart/x-mixed-replace JPEG (which <img> renders natively). Same grace
  // period as the RTSP relay so brief client gaps don't churn the port-6000
  // connection. Independent of the FFmpeg relay.
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
      'Cross-Origin-Resource-Policy': 'same-origin',
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

  function buildStreamUrl() {
    const printer = getConfig().printer || {};
    if (!capsFor(printer.type).hasCameraRtsp || !printer.accessCode || !printer.url) return null;
    const rtsp = getRtspStatus(printer.type);
    if (!rtsp.enabled) return null;
    const endpoint = printerCameraEndpoint(printer.url, printer.type === 'H3C' ? rtsp.rtspField : undefined);
    if (!endpoint) return null;
    endpoint.username = 'bblp';
    endpoint.password = encodeURIComponent(printer.accessCode);
    return endpoint.href;
  }

  require('express-ws')(app);
  const relay = createRtspCamera({ ...relayOptions, resolveUrl: buildStreamUrl });
  app.get('/api/printer/video/status', (_req, res) => {
    relay.refresh();
    res.set('Cache-Control', 'no-store').json(buildCameraStatus(getConfig().printer || {}));
  });
  app.ws('/api/printer/video', (ws, req) => {
    if (!sameOrigin(req)) { ws.close(1008); return; }
    const printer = getConfig().printer || {};
    if (!capsFor(printer.type).hasCameraRtsp || !rtspReady) {
      ws.close(1013, 'Printer Liveview is unavailable');
      return;
    }
    relay.subscribe(ws);
  });

  console.log('[bambuboard] RTSP video relay ready at ws://*/api/printer/video');
  return {
    stop() {
      clearTimeout(chamber.grace);
      chamber.stream?.stop();
      return relay.stop();
    },
    forceStop: relay.forceStop,
  };
}

module.exports = { buildVideoRouter };
