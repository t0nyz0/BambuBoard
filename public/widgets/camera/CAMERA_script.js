// Live chamber-camera widget.
//
// Renders the printer's camera feed directly in the browser via the
// server-side RTSP relay (src/routes/video.js):
//   GET  /api/printer/video/status  — configuration and relay frame state
//   WS   /api/printer/video         — MPEG-TS over WebSocket, decoded by JSMpeg
//
// This removes the need for OBS *and* Bambu Studio "Go Live": the relay
// connects straight to the printer's RTSPS stream on port 322 (X1 / X1C /
// H2D), the same way Home Assistant's bambulab integration does. The printer
// must have LAN Mode Liveview enabled on its touchscreen.
//
// Two camera transports, chosen by the server's `cameraType`:
//   - 'rtsp'  (X1 / X1C / H2D / P2S): MPEG-TS over WebSocket, decoded by JSMpeg.
//   - 'image' (P1 / A1-class): the port-6000 chamber-image protocol, served as
//     multipart MJPEG at /api/printer/camera.mjpeg and rendered in an <img>.

(function () {
  const canvas  = document.getElementById('camCanvas');
  const overlay = document.getElementById('camOverlay');
  const msgEl   = document.getElementById('camMsg');
  const hintEl  = document.getElementById('camHint');
  const stage   = canvas.parentElement;

  // Poll cadence for the status endpoint. Fast enough to pick up the camera
  // being toggled on/off within a few seconds, slow enough to be cheap.
  const STATUS_POLL_MS = 5000;

  let player = null;       // active JSMpeg.Player instance, or null
  let decodedFrame = false;
  let relayState = 'idle';
  let lastHint = null;
  let img = null;          // <img> element for MJPEG (image-camera printers)
  let mjpegActive = false;

  function setOverlay(show, msg, kind = 'loading', hint = '') {
    if (show) {
      msgEl.textContent = msg || '';
      hintEl.textContent = hint || '';
      overlay.classList.toggle('error', kind === 'error');
      overlay.classList.add('show');
    } else {
      overlay.classList.remove('show');
    }
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/printer/video`;
  }

  function destroyPlayer() {
    if (player) {
      try { player.destroy(); } catch (_) { /* ignore */ }
      player = null;
    }
    decodedFrame = false;
  }

  // ---- MJPEG (image-camera printers) ----
  function showMjpeg(url) {
    if (mjpegActive) return; // already streaming; re-setting src restarts it
    destroyPlayer();
    if (!img) {
      img = document.createElement('img');
      img.id = 'camImg';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
      img.addEventListener('error', () => { teardownMjpeg(); setOverlay(true, 'Camera stream interrupted — retrying…', 'loading', lastHint || ''); });
      stage.appendChild(img);
    }
    canvas.style.display = 'none';
    img.style.display = 'block';
    img.src = url;
    mjpegActive = true;
    setOverlay(false);
  }
  function teardownMjpeg() {
    if (!mjpegActive && !img) return;
    if (img) { img.src = ''; img.style.display = 'none'; }
    canvas.style.display = '';
    mjpegActive = false;
  }

  function connect() {
    if (player || typeof JSMpeg === 'undefined') return;
    setOverlay(true, 'Connecting to camera…', 'loading');
    try {
      player = new JSMpeg.Player(wsUrl(), {
        canvas,
        autoplay: true,
        audio: false,
        // JSMpeg's WebSocket source auto-reconnects on this interval (seconds)
        // if the relay drops, so transient blips recover without our help.
        reconnectInterval: 4,
        onVideoDecode: () => {
          if (decodedFrame) return;
          decodedFrame = true;
          if (relayState !== 'reconnecting' && relayState !== 'unavailable') setOverlay(false);
        },
      });
    } catch (e) {
      console.warn('[camera] JSMpeg connect failed:', e);
      destroyPlayer();
      setOverlay(true, 'Camera unavailable', 'error');
    }
  }

  async function poll() {
    let status;
    try {
      const res = await fetch('/api/printer/video/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error('Camera status unavailable');
      status = await res.json();
    } catch (_) {
      // Server unreachable — show a soft error, keep any running player as-is
      // (it has its own reconnect), and try again next tick.
      if (!decodedFrame) setOverlay(true, 'Waiting for server…', 'loading');
      return;
    }

    lastHint = status.hint || null;

    // Image-camera printers (P1 / A1): render the MJPEG stream in an <img>.
    if (status.cameraType === 'image') {
      relayState = 'idle';
      if (status.available) {
        showMjpeg(status.mjpegUrl || '/api/printer/camera.mjpeg');
      } else {
        teardownMjpeg();
        setOverlay(true, 'Camera unavailable', 'error', status.hint || '');
      }
      return;
    }

    // RTSP printers: JSMpeg over WebSocket.
    teardownMjpeg();
    if (status.available) {
      if (typeof JSMpeg === 'undefined') {
        setOverlay(true, 'Video decoder failed to load', 'error');
        return;
      }
      if (!player) connect();
      const recovering = status.state === 'reconnecting' || status.state === 'unavailable';
      const wasRecovering = relayState === 'reconnecting' || relayState === 'unavailable';
      const restarting = relayState === 'streaming' && (status.state === 'idle' || status.state === 'connecting');
      if ((recovering && !wasRecovering) || restarting) decodedFrame = false;
      relayState = status.state;
      if (relayState === 'unavailable') setOverlay(true, 'Camera unavailable', 'error', status.hint || '');
      else if (recovering || restarting) setOverlay(true, 'Reconnecting camera…', 'loading', status.hint || '');
      else if (decodedFrame) setOverlay(false);
    } else {
      // Camera not available — relay disabled or LAN Liveview off. Tear down
      // any stale player and surface the server's hint.
      destroyPlayer();
      relayState = 'idle';
      const msg = status.relayReady === false
        ? 'Video relay unavailable'
        : 'Camera off';
      setOverlay(true, msg, 'error', status.hint || '');
    }
  }

  async function pollStatus() {
    await poll();
    setTimeout(pollStatus, STATUS_POLL_MS);
  }
  void pollStatus();
})();
