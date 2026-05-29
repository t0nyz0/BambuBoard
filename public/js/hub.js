// Live page — surfaces the composited /live output, the OBS URL + 1-click
// scene download, and which scene is currently published. (Replaced the old
// OBS-export wizard: there's no scene-collection import or camera/SDP setup
// anymore — OBS just needs one Browser Source pointing at /live.)
(function () {
  const liveUrl = `${location.origin}/live`;

  const urlInput = document.getElementById('live-url');
  if (urlInput) urlInput.value = liveUrl;

  const copyBtn = document.getElementById('copy-url');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(liveUrl);
        copyBtn.textContent = 'Copied!';
      } catch (_) {
        // Fallback: select the field so the user can copy manually.
        urlInput && urlInput.select();
        copyBtn.textContent = 'Press ⌘/Ctrl+C';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1600);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Show which scene is currently published (or prompt the user to make one).
  async function refreshActive() {
    const line = document.getElementById('active-line');
    if (!line) return;
    try {
      const a = await (await fetch('/api/obs/active', { cache: 'no-store' })).json();
      if (a && a.slug) {
        line.innerHTML = `Currently live: <strong>${escapeHtml(a.slug)}</strong>. ` +
          `Change it in the <a href="/scene-editor">Layout editor</a> → 🔴 Go Live.`;
      } else {
        line.innerHTML = `Nothing published yet — open the ` +
          `<a href="/scene-editor">Layout editor</a>, design your overlay, and hit ` +
          `<strong>🔴 Go Live</strong>. Until then, /live shows a default layout.`;
      }
    } catch (_) {
      line.textContent = '';
    }
  }

  refreshActive();

  // ---- Stream to YouTube (browser capture → server RTMP relay) ----
  // The browser captures the /live tab via getDisplayMedia, encodes it with
  // MediaRecorder, and streams chunks over a WebSocket to the server, which
  // pipes them into ffmpeg → RTMP. (DOM + cross-origin iframes can't be drawn
  // to a <canvas>, so tab capture is the only browser-native way to grab the
  // composited /live page.)
  let mediaStream = null, recorder = null, streamWs = null;
  const startBtn = document.getElementById('yt-start');
  const stopBtn = document.getElementById('yt-stop');
  const keyInput = document.getElementById('yt-key');
  const ytStatusEl = document.getElementById('yt-status');
  const ytStatus = (m) => { if (ytStatusEl) ytStatusEl.textContent = m; };

  function stopYouTube() {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { if (streamWs && streamWs.readyState <= 1) streamWs.close(); } catch (_) {}
    recorder = null; mediaStream = null; streamWs = null;
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  }

  async function startYouTube() {
    const key = (keyInput && keyInput.value || '').trim();
    if (!key) return ytStatus('Enter your YouTube stream key first.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return ytStatus('Your browser does not support tab capture (getDisplayMedia).');
    }
    try {
      mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch (_) {
      return ytStatus('Screen share was cancelled.');
    }
    const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4']
      .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    streamWs = new WebSocket(`${proto}//${location.host}/api/stream/youtube`);
    streamWs.binaryType = 'arraybuffer';

    streamWs.onopen = () => {
      streamWs.send(JSON.stringify({ key }));
      recorder = new MediaRecorder(mediaStream, { mimeType: mime || undefined, videoBitsPerSecond: 4500000 });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size && streamWs && streamWs.readyState === 1) {
          e.data.arrayBuffer().then(b => { try { streamWs.send(b); } catch (_) {} });
        }
      };
      recorder.start(1000); // 1s chunks
      // If the user stops sharing via the browser's bar, end cleanly.
      const vt = mediaStream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', stopYouTube);
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      ytStatus('🔴 Live to YouTube…');
    };
    streamWs.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'error') ytStatus('Error: ' + m.msg);
        else if (m.type === 'ended') { ytStatus('Stream ended' + (m.detail ? ': ' + m.detail.split('\n').pop() : '')); stopYouTube(); }
      } catch (_) {}
    };
    streamWs.onerror = () => ytStatus('Stream connection error.');
  }

  if (startBtn) startBtn.addEventListener('click', startYouTube);
  if (stopBtn) stopBtn.addEventListener('click', stopYouTube);
})();
