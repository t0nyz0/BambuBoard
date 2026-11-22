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
  const STATUS_REQUEST_MS = 4000;
  const STATUS_FRESH_MS = 15000;
  // Allow the shared relay to run its 18s startup and 9s frame-gap checks first.
  const FIRST_FRAME_MS = 24000;
  const FRAME_GAP_MS = 14000;
  const RESUME_GRACE_MS = 6000;
  const STABLE_PLAYBACK_MS = 20000;
  const FRAME_CHECK_MS = 1000;
  const BASE_BACKOFF_MS = 2500;
  const MAX_BACKOFF_MS = 30000;

  let viewer = null;
  let decodedFrame = false;
  let failures = 0;
  let rtspAvailable = false;
  let relayState = 'idle';
  let lastStatusAt = -Infinity;
  let lastHint = null;
  let active = false, inViewport = true;
  let statusTimer, frameTimer, statusRequest, statusRequestDeadline;
  let img = null;          // <img> element for MJPEG (image-camera printers)
  let mjpegActive = false;

  function setOverlay(show, msg, kind = 'loading', hint = '') {
    if (show) {
      if (msgEl.textContent !== (msg || '')) msgEl.textContent = msg || '';
      if (hintEl.textContent !== hint) hintEl.textContent = hint;
      overlay.classList.toggle('error', kind === 'error');
      overlay.classList.add('show');
    } else {
      overlay.classList.remove('show');
    }
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/printer/video?formatReset=1`;
  }

  function destroyPlayer() {
    const player = viewer?.player;
    viewer = null;
    decodedFrame = false;
    if (player) {
      // The vendor player can still be waiting to initialize WASM. Its bound
      // callback must not open a socket or animate after this viewer retires.
      if (player.source && !player.source.socket) {
        player.autoplay = false;
        player.source.start = () => {};
        player.source.destroy = () => {};
      }
      try { player.destroy(); } catch (_) { /* ignore */ }
    }
  }

  function relayRecovering(now) {
    return now - lastStatusAt < STATUS_FRESH_MS && (relayState === 'reconnecting' || relayState === 'unavailable');
  }

  function visible() {
    return inViewport && !document.hidden;
  }

  function grantPlaybackGrace(current, now = performance.now()) {
    current.resumeUntil = now + RESUME_GRACE_MS;
    current.retrySince = null;
    current.healthySince = null;
  }

  // ---- MJPEG (image-camera printers) ----
  function showMjpeg(url) {
    if (mjpegActive) return; // already streaming; re-setting src restarts it
    if (!img) {
      img = document.createElement('img');
      img.id = 'camImg';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
      img.addEventListener('error', () => {
        if (!mjpegActive) return;
        teardownMjpeg();
        setOverlay(true, 'Camera stream interrupted — retrying…', 'loading', lastHint || '');
      });
      stage.appendChild(img);
    }
    canvas.style.display = 'none';
    img.style.display = 'block';
    img.src = url;
    mjpegActive = true;
    setOverlay(false);
  }
  function teardownMjpeg() {
    if (!mjpegActive) return;
    mjpegActive = false;
    img.removeAttribute('src');
    img.style.display = 'none';
    canvas.style.display = '';
  }

  function connect() {
    if (viewer || !active || !rtspAvailable || !visible() || typeof JSMpeg === 'undefined') return;
    const current = viewer = { player: null, startedAt: performance.now(), lastFrameAt: null,
      healthySince: null, format: null, retrySince: null, resumeUntil: 0,
      wasPaused: false, resumeWhenVisible: false, failed: false };
    setOverlay(true, 'Connecting to camera…', 'loading');
    try {
      current.player = new JSMpeg.Player(wsUrl(), {
        canvas,
        autoplay: true,
        audio: false,
        // One widget-level visibility handler covers all player generations.
        pauseWhenHidden: false,
        reconnectInterval: 0,
        onPause: () => {
          if (viewer !== current) return;
          current.wasPaused = true;
          current.healthySince = null;
        },
        onVideoDecode: () => {
          if (viewer !== current || !visible() || current.player?.paused) return;
          const now = performance.now();
          if (current.healthySince === null || now - current.lastFrameAt >= FRAME_GAP_MS) current.healthySince = now;
          current.lastFrameAt = now;
          current.retrySince = null;
          current.format ??= `${canvas.width}x${canvas.height}`;
          if (now - current.healthySince >= STABLE_PLAYBACK_MS) failures = 0;
          decodedFrame = true;
          if (overlay.classList.contains('show') && !relayRecovering(now)) setOverlay(false);
        },
      });
    } catch (e) {
      console.warn('[camera] JSMpeg connect failed:', e);
      current.failed = true;
      setOverlay(true, 'Camera unavailable', 'error');
    }
  }

  function replaceViewer() {
    destroyPlayer();
    canvas.width = canvas.width;
    connect();
  }

  function checkFrames() {
    if (!active || !rtspAvailable || !visible()) return;
    if (!viewer) { connect(); return; }
    const current = viewer;
    const now = performance.now();
    const socket = current.player?.source?.socket;
    if (socket && current.player.paused) {
      current.wasPaused = true;
      return;
    }
    if (current.wasPaused) {
      current.wasPaused = false;
      grantPlaybackGrace(current, now);
    }
    const socketClosed = socket?.readyState === WebSocket.CLOSED;
    // Keep receiving on the existing socket while the shared process restarts.
    // Expire that hint if status stops updating so a stuck poll cannot block us.
    if (!socketClosed && !current.failed && relayRecovering(now)) {
      current.retrySince = null;
      return;
    }
    const firstFrame = current.lastFrameAt === null;
    const deadline = firstFrame ? current.startedAt + FIRST_FRAME_MS : current.lastFrameAt + FRAME_GAP_MS;
    if (!current.failed && !socketClosed && now < Math.max(deadline, current.resumeUntil)) return;

    decodedFrame = false;
    current.retrySince ??= now;
    const delay = failures ? Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) : 0;
    if (now - current.retrySince >= delay) {
      // Keep the old socket open during backoff, then replace only this viewer.
      // Another viewer, or this camera relay's grace window, keeps video alive.
      failures = Math.min(failures + 1, 5);
      replaceViewer();
    }
    setOverlay(true, 'Reconnecting camera…', 'loading', firstFrame
      ? 'This viewer has not decoded a camera frame yet.'
      : 'Video stopped updating in this viewer.');
  }

  function applyStatus(status, polledViewer) {
    const now = performance.now();
    const wasRecovering = relayRecovering(now);
    const previousState = relayState;
    lastStatusAt = now;

    lastHint = status.hint || null;

    // Image-camera printers (P1 / A1): render the MJPEG stream in an <img>.
    if (status.cameraType === 'image') {
      rtspAvailable = false;
      failures = 0;
      relayState = 'idle';
      destroyPlayer();
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
    rtspAvailable = status.available === true && status.cameraType === 'rtsp';
    if (rtspAvailable) {
      if (typeof JSMpeg === 'undefined') {
        setOverlay(true, 'Video decoder failed to load', 'error');
        return;
      }
      relayState = status.state;
      const recovering = relayRecovering(now);
      const restarting = previousState === 'streaming' && (relayState === 'idle' || relayState === 'connecting');
      if ((recovering && !wasRecovering) || restarting) decodedFrame = false;
      if (viewer && wasRecovering && relayState === 'streaming') grantPlaybackGrace(viewer, now);
      const format = status.format && `${status.format.width}x${status.format.height}`;
      if (visible() && viewer && viewer === polledViewer && !viewer.player?.paused
          && viewer.format && format && viewer.format !== format) replaceViewer();
      else if (!viewer) connect();
      if (relayState === 'unavailable') setOverlay(true, 'Camera unavailable', 'error', status.hint || '');
      else if (recovering || restarting) setOverlay(true, 'Reconnecting camera…', 'loading', status.hint || '');
      else if (decodedFrame) setOverlay(false);
    } else {
      // Camera not available — relay disabled or LAN Liveview off. Tear down
      // any stale player and surface the server's hint.
      destroyPlayer();
      failures = 0;
      relayState = 'idle';
      const msg = status.relayReady === false
        ? 'Video relay unavailable'
        : 'Camera off';
      setOverlay(true, msg, 'error', status.hint || '');
    }
  }

  async function pollStatus() {
    if (!active) return;
    const controller = statusRequest = new AbortController();
    const polledViewer = viewer;
    const deadline = statusRequestDeadline = setTimeout(() => controller.abort(), STATUS_REQUEST_MS);
    try {
      const res = await fetch('/api/printer/video/status', { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('Camera status unavailable');
      const status = await res.json();
      if (statusRequest === controller && !controller.signal.aborted) applyStatus(status, polledViewer);
    } catch (_) {
      if (statusRequest === controller && !rtspAvailable && !mjpegActive) setOverlay(true, 'Waiting for server…', 'loading');
    } finally {
      clearTimeout(deadline);
      if (statusRequest === controller) {
        statusRequest = null;
        statusTimer = setTimeout(pollStatus, STATUS_POLL_MS);
      }
    }
  }

  function updateVisibility() {
    if (!viewer) { if (visible()) connect(); return; }
    const current = viewer;
    if (!visible()) {
      if (current.player && !current.player.paused) {
        current.resumeWhenVisible = true;
        current.player.pause();
      }
    } else {
      grantPlaybackGrace(current);
      if (current.resumeWhenVisible) current.player.play();
      current.resumeWhenVisible = false;
    }
  }

  document.addEventListener('visibilitychange', updateVisibility);
  // Host pages can hide an iframe without changing the widget's document state.
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
    if (!active || !entry || inViewport === entry.isIntersecting) return;
    inViewport = entry.isIntersecting;
    updateVisibility();
  }) : null;

  function start() {
    if (active) return;
    active = true;
    inViewport = true;
    observer?.observe(stage);
    frameTimer = setInterval(checkFrames, FRAME_CHECK_MS);
    void pollStatus();
  }

  window.addEventListener('pagehide', () => {
    active = false;
    observer?.disconnect();
    clearInterval(frameTimer);
    clearTimeout(statusTimer);
    clearTimeout(statusRequestDeadline);
    statusRequest?.abort();
    statusRequest = null;
    rtspAvailable = false;
    relayState = 'idle';
    failures = 0;
    destroyPlayer();
    teardownMjpeg();
  });
  window.addEventListener('pageshow', start);
  start();
})();
