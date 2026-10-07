// Live workspace: show the published output first; relay is an optional action.
(function () {
  const $ = id => document.getElementById(id);
  const liveUrl = `${location.origin}/live`;
  $('live-url').value = liveUrl;
  $('copy-url').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(liveUrl);
      window.toast('Source URL copied');
    } catch (_) {
      $('live-url').focus(); $('live-url').select();
      window.toast('URL selected. Press ⌘/Ctrl+C to copy.');
    }
  });
  async function refreshActive() {
    try {
      const r = await fetch('/api/obs/active', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const a = await r.json();
      $('active-line').textContent = a.slug || a.label || 'Default scene';
      $('publication-state').textContent = a.slug ? 'Published' : 'Default layout';
      $('publication-state').className = 'pill' + (a.slug ? ' pill-ok' : '');
      $('output-label').textContent = a.slug ? 'Published output' : 'Default output · nothing published yet';
      const { x = 1920, y = 1080 } = a.resolution || {};
      $('preview-viewport').style.aspectRatio = `${x} / ${y}`;
      $('preview-dimensions').textContent = `${x} × ${y}`;
      $('obs-dimensions').textContent = `${x} × ${y}`;
    } catch (_) {
      $('active-line').textContent = 'Could not check publication state';
      $('publication-state').textContent = 'Unavailable';
      $('publication-state').className = 'pill pill-warn';
    }
  }
  window.addEventListener('bambuboard:status', ({ detail: s }) => {
    $('app-version').textContent = s.version || '';
    $('printer-notice').hidden = !!s.connected;
    $('printer-notice').replaceChildren();
    if (!s.connected) {
      $('printer-notice').append('Printer disconnected. Your output remains available. ');
      const link = document.createElement('a'); link.href = '/setup#connect'; link.textContent = 'Check connection';
      $('printer-notice').appendChild(link);
    }
  });
  refreshActive();
  setInterval(() => { if (!document.hidden) refreshActive(); }, 4000);

  let capture = null, recorder = null, socket = null;
  let running = false;
  function supportProblem() {
    if (!window.isSecureContext) return 'Tab sharing needs HTTPS or localhost. This HTTP LAN address cannot capture a tab. You can still use the OBS source above.';
    if (!navigator.mediaDevices?.getDisplayMedia) return 'This browser does not support tab sharing. Use a desktop browser with tab capture or the OBS source above.';
    if (!window.MediaRecorder) return 'This browser cannot encode shared video. Use OBS or a browser with MediaRecorder support.';
    return '';
  }
  function checkSupport() {
    const problem = supportProblem();
    $('yt-support').hidden = !problem;
    $('yt-support').textContent = problem;
    $('yt-start').disabled = running || !!problem;
  }
  const status = message => { $('yt-status').textContent = message; $('yt-active-status').textContent = message; };
  function stopRelay(message = 'Relay stopped.') {
    running = false;
    const previousSocket = socket;
    socket = null;
    try { if (recorder?.state !== 'inactive') recorder?.stop(); } catch (_) {}
    capture?.getTracks().forEach(track => track.stop());
    try { previousSocket?.close(); } catch (_) {}
    recorder = null; capture = null;
    $('yt-stop').disabled = true;
    $('yt-active-controls').hidden = true;
    status(message); checkSupport();
  }
  async function startRelay() {
    if (running) return;
    const problem = supportProblem();
    if (problem) { checkSupport(); return status(problem); }
    const key = $('yt-key').value.trim();
    if (!key) return status('Enter your YouTube stream key first.');
    running = true;
    $('yt-start').disabled = true;
    $('yt-stop').disabled = false;
    $('yt-active-controls').hidden = false;
    status('Choose the /live tab to share…');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      if (!running) { stream.getTracks().forEach(t => t.stop()); return; }
      capture = stream;
      const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('No supported video encoding format. Use OBS for this browser.');
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/stream/youtube`);
      socket = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (socket !== ws || !running) return ws.close();
        try {
          recorder = new MediaRecorder(capture, { mimeType: mime, videoBitsPerSecond: 4500000 });
          recorder.ondataavailable = async e => {
            if (!e.data?.size) return;
            const chunk = await e.data.arrayBuffer();
            if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
          };
          recorder.onerror = () => stopRelay('Video encoding failed. Try OBS.');
          ws.send(JSON.stringify({ key }));
          recorder.start(1000);
          capture.getVideoTracks()[0]?.addEventListener('ended', () => stopRelay());
          status('Sending video to the relay…');
        } catch (e) { stopRelay(e.message); }
      };
      ws.onmessage = e => {
        if (socket !== ws) return;
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'started') status('Relay running. Check YouTube Studio for broadcast status.');
          else if (m.type === 'error') stopRelay('Relay error: ' + (m.msg || 'Could not start.'));
          else if (m.type === 'ended') stopRelay('Relay ended. Check your connection and YouTube Studio.');
        } catch (_) {}
      };
      ws.onerror = () => { if (socket === ws) stopRelay('Relay connection failed.'); };
      ws.onclose = () => { if (socket === ws) stopRelay('Relay connection closed.'); };
    } catch (e) {
      stopRelay(e.name === 'NotAllowedError' ? 'Screen share was cancelled or denied.' : e.message);
    }
  }
  $('yt-start').addEventListener('click', startRelay);
  $('yt-stop').addEventListener('click', () => stopRelay());
  window.addEventListener('pagehide', () => stopRelay());
  checkSupport();
})();
