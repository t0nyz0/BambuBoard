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
  // Two paths, one shared capture engine:
  //   • Connected account (OAuth) — we create the broadcast via the API (title,
  //     description, privacy, made-for-kids, latency), get an ingest URL + key,
  //     then capture the /live tab and push it. YouTube auto-starts/stops.
  //   • Manual stream key (advanced fallback) — push to a pasted key; metadata
  //     is whatever you set in YouTube Studio.
  // In both cases the browser captures the /live tab via getDisplayMedia,
  // encodes it with MediaRecorder, and streams chunks over a WebSocket to the
  // server, which pipes them into ffmpeg → RTMP. (DOM + cross-origin iframes
  // can't be drawn to a <canvas>, so tab capture is the only browser-native way
  // to grab the composited /live page.)
  let mediaStream = null, recorder = null, streamWs = null;
  let activeBroadcastId = null;     // set in connected mode for a clean end
  let statusSink = () => {};        // where status text goes (set per click)

  function setStreaming(on, mode) {
    const ids = mode === 'manual' ? ['yt-start-key', 'yt-stop-key'] : ['yt-start', 'yt-stop'];
    const s = document.getElementById(ids[0]);
    const p = document.getElementById(ids[1]);
    if (s) s.disabled = on;
    if (p) p.disabled = !on;
  }

  function stopStreaming() {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { if (streamWs && streamWs.readyState <= 1) streamWs.close(); } catch (_) {}
    recorder = null; mediaStream = null; streamWs = null;
    setStreaming(false, 'connected');
    setStreaming(false, 'manual');
    if (activeBroadcastId) {
      const id = activeBroadcastId; activeBroadcastId = null;
      fetch('/api/youtube/end', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcastId: id }),
      }).catch(() => {});
    }
  }

  // Capture the /live tab and push it to {rtmpBase?, key}. Returns true if the
  // share dialog succeeded (the WS/recorder spin up asynchronously after).
  async function startCapture({ rtmpBase, key }, mode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      statusSink('Your browser does not support tab capture (getDisplayMedia).'); return false;
    }
    try {
      mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch (_) {
      statusSink('Screen share was cancelled.'); return false;
    }
    const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4']
      .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    streamWs = new WebSocket(`${proto}//${location.host}/api/stream/youtube`);
    streamWs.binaryType = 'arraybuffer';

    streamWs.onopen = () => {
      const ctrl = { key };
      if (rtmpBase) ctrl.rtmpBase = rtmpBase;
      streamWs.send(JSON.stringify(ctrl));
      recorder = new MediaRecorder(mediaStream, { mimeType: mime || undefined, videoBitsPerSecond: 4500000 });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size && streamWs && streamWs.readyState === 1) {
          e.data.arrayBuffer().then(b => { try { streamWs.send(b); } catch (_) {} });
        }
      };
      recorder.start(1000); // 1s chunks
      // If the user stops sharing via the browser's bar, end cleanly.
      const vt = mediaStream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', stopStreaming);
      setStreaming(true, mode);
      statusSink('🔴 Streaming…');
    };
    streamWs.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'error') statusSink('Error: ' + m.msg);
        else if (m.type === 'ended') { statusSink('Stream ended' + (m.detail ? ': ' + m.detail.split('\n').pop() : '')); stopStreaming(); }
      } catch (_) {}
    };
    streamWs.onerror = () => statusSink('Stream connection error.');
    return true;
  }

  // Show one of the three account states based on /api/youtube/status.
  async function refreshYouTube() {
    let st;
    try { st = await (await fetch('/api/youtube/status', { cache: 'no-store' })).json(); }
    catch (_) { return; }
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('yt-state-unconfigured', !st.clientConfigured);
    show('yt-state-disconnected', !!st.clientConfigured && !st.connected);
    show('yt-state-connected', !!st.clientConfigured && !!st.connected);
    if (st.connected && st.channel && st.channel.title) {
      const c = document.getElementById('yt-channel');
      if (c) c.textContent = st.channel.title;
    }
  }

  // Post-OAuth feedback banner driven by the ?yt= query param, then clean the URL.
  (function ytBanner() {
    const p = new URLSearchParams(location.search);
    const yt = p.get('yt'); if (!yt) return;
    const b = document.getElementById('yt-banner'); if (!b) return;
    const msg = {
      connected: '✓ YouTube account connected — set your title below and go live.',
      notconfigured: 'Add a Google OAuth client in Setup → YouTube streaming first.',
      error: 'YouTube connection failed: ' + (p.get('msg') || 'unknown error'),
    }[yt];
    if (msg) { b.textContent = msg; b.style.display = ''; }
    history.replaceState({}, '', location.pathname);
  })();

  // Connected-account: 🔴 Go Live → create broadcast, then capture + push.
  const cStart = document.getElementById('yt-start');
  const cStop = document.getElementById('yt-stop');
  const cStatus = document.getElementById('yt-status');
  if (cStart) cStart.addEventListener('click', async () => {
    statusSink = (m) => { if (cStatus) cStatus.textContent = m; };
    const title = (document.getElementById('yt-title').value || '').trim();
    if (!title) return statusSink('Enter a title first.');
    cStart.disabled = true;
    statusSink('Creating broadcast…');
    let r;
    try {
      r = await (await fetch('/api/youtube/broadcast', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: document.getElementById('yt-desc').value || '',
          privacy: document.getElementById('yt-privacy').value,
          latency: document.getElementById('yt-latency').value,
          madeForKids: document.getElementById('yt-kids').checked,
        }),
      })).json();
    } catch (e) { cStart.disabled = false; return statusSink('Failed to create broadcast: ' + e.message); }
    if (!r || !r.ok) { cStart.disabled = false; return statusSink('Failed: ' + ((r && r.error) || 'unknown')); }
    activeBroadcastId = r.broadcastId;
    const watch = document.getElementById('yt-watch');
    const link = document.getElementById('yt-watch-link');
    if (watch && link) { link.href = r.watchUrl; link.textContent = r.watchUrl; watch.style.display = ''; }
    const ok = await startCapture({ rtmpBase: r.rtmpBase, key: r.streamKey }, 'connected');
    if (!ok) { cStart.disabled = false; activeBroadcastId = null; }
    else statusSink('🔴 Live — pick the /live tab to share. YouTube goes live once it receives video.');
  });
  if (cStop) cStop.addEventListener('click', () => {
    statusSink = (m) => { if (cStatus) cStatus.textContent = m; };
    stopStreaming(); statusSink('Stopped — broadcast ended.');
  });

  // Manual stream-key fallback.
  const mStart = document.getElementById('yt-start-key');
  const mStop = document.getElementById('yt-stop-key');
  const mStatus = document.getElementById('yt-status-key');
  if (mStart) mStart.addEventListener('click', async () => {
    statusSink = (m) => { if (mStatus) mStatus.textContent = m; };
    const key = (document.getElementById('yt-key').value || '').trim();
    if (!key) return statusSink('Enter your YouTube stream key first.');
    await startCapture({ key }, 'manual'); // server defaults to YouTube's ingest base
  });
  if (mStop) mStop.addEventListener('click', () => {
    statusSink = (m) => { if (mStatus) mStatus.textContent = m; };
    stopStreaming(); statusSink('Stopped.');
  });

  // Disconnect the YouTube account.
  const disc = document.getElementById('yt-disconnect');
  if (disc) disc.addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/api/youtube/disconnect', { method: 'POST' }).catch(() => {});
    stopStreaming();
    refreshYouTube();
  });

  refreshYouTube();
})();
