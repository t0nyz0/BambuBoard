// Streaming controls stay independent from scene publication. A browser
// capture is owned by this page; a server capture survives navigation.
(function () {
  const $ = id => document.getElementById(id);
  const delays = [1000, 3000, 10000], maxBuffered = 8 * 1024 * 1024, sliceBytes = 256 * 1024;
  let capabilities = null, remote = null, active = false, owned = null, stopping = false, checking = false, selectedOnce = false;
  let lastClient = { state: 'idle', events: [] }, statusSequence = 0;
  const messages = { idle: 'Ready when you are.', starting: 'Preparing the stream…', connecting: 'Connecting to YouTube and encoding the first frames…', sending: 'Sending video. Confirm the broadcast in YouTube Studio.', reconnecting: 'Connection interrupted. Reconnecting…', stopping: 'Stopping the stream…', stopped: 'Stream stopped.' };
  const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
  function supportProblem() {
    if ($('yt-mode').value === 'server') return capabilities?.serverCapture ? '' : 'Server capture needs Chromium. Use the current Docker image with Chromium, or configure BAMBUBOARD_CHROMIUM_BIN.';
    if (!capabilities?.browserRelay) return 'The browser relay is unavailable on this server. Choose server capture or check the installation.';
    if (!window.isSecureContext) return 'Tab sharing needs HTTPS or localhost. This HTTP LAN address cannot capture a tab. Choose server capture or use OBS.';
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) return 'This browser cannot capture and encode a tab. Choose server capture or use OBS.';
    return '';
  }
  function controls() {
    const busy = !!owned || active || stopping;
    const problem = capabilities ? supportProblem() : '';
    $('yt-support').hidden = !problem; setText('yt-support', problem);
    $('yt-start').disabled = busy || checking || !capabilities || !!problem;
    $('yt-check').disabled = busy || checking || !capabilities;
    $('yt-stop').disabled = !busy || stopping;
    $('yt-active-controls').hidden = !busy;
    for (const id of ['yt-mode', 'yt-quality', 'yt-key', 'yt-show-key', 'yt-bitrate', 'yt-destination']) $(id).disabled = busy || checking;
    $('yt-audio').disabled = busy || checking || $('yt-mode').value === 'server';
    const server = $('yt-mode').value === 'server';
    for (const option of $('yt-quality').options) option.disabled = server && option.value === '1080p60';
    if (server && $('yt-quality').value === '1080p60') { $('yt-quality').value = '1080p30'; qualityChanged(); }
    setText('yt-mode-help', server ? 'Runs on your BambuBoard host. You can close this control page; the server keeps streaming until you stop it.' : 'Share the /live tab. Keep both this control page and the shared tab open while streaming.');
    setText('yt-audio-help', server ? 'Server capture supplies silence. Use browser capture to include tab audio.' : 'Enable tab audio in the share picker when including it. Microphone audio is not captured.');
  }
  function render(session = {}, message) {
    const state = session.state || 'idle';
    const slow = state === 'sending' && session.elapsedMs > 15000 && session.speed > 0 && session.speed < 0.9;
    const recovery = state === 'reconnecting' && session.attempt ? `Connection interrupted. Retrying ${session.attempt} of ${capabilities?.retries || delays.length}…` : '';
    const text = message || (state === 'reconnecting' ? recovery : session.error?.message) || (slow ? 'Encoding is falling behind. Stop and choose a lower quality or bitrate. Check YouTube Studio for stream health.' : messages[state]) || 'Checking streaming status…';
    setText('yt-status', text); setText('yt-active-status', text);
    setText('yt-state-badge', state === 'sending' ? 'Sending video' : state[0].toUpperCase() + state.slice(1));
    $('yt-state-badge').className = 'pill' + (state === 'sending' ? ' pill-ok' : state === 'error' ? ' pill-error' : state === 'reconnecting' ? ' pill-warn' : '');
    $('yt-metrics').hidden = !session.profile;
    if (session.profile) {
      setText('yt-metric-quality', `${session.profile.width} × ${session.profile.height} · ${session.profile.fps} fps`);
      const secs = Math.max(0, Math.floor((session.elapsedMs || 0) / 1000));
      setText('yt-metric-duration', `${Math.floor(secs / 3600).toString().padStart(2, '0')}:${Math.floor(secs % 3600 / 60).toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`);
      setText('yt-metric-fps', session.fps ? Number(session.fps).toFixed(1) : '—');
      setText('yt-metric-speed', session.speed ? Number(session.speed).toFixed(2) + '×' : '—');
      setText('yt-metric-bytes', session.outputBytes ? (session.outputBytes / 1048576).toFixed(1) + ' MB' : '—');
    }
    controls();
  }
  function qualityChanged() {
    const profile = capabilities?.profiles.find(p => p.id === $('yt-quality').value);
    if (profile) { $('yt-bitrate').value = profile.bitrate; setText('yt-bitrate-help', `YouTube recommends ${profile.bitrate.toLocaleString()} kbps for this H.264 preset.`); }
  }
  function options() {
    const key = $('yt-key').value.trim(), bitrate = Number($('yt-bitrate').value);
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(key)) throw new Error('Paste the stream key from YouTube Studio, without a URL or spaces.');
    if (!Number.isInteger(bitrate) || bitrate < 1000 || bitrate > 25000) throw new Error('Video bitrate must be between 1,000 and 25,000 kbps.');
    return { key, profile: $('yt-quality').value, bitrate, destination: $('yt-destination').value, source: $('yt-mode').value };
  }
  async function request(route, body) {
    const response = await fetch('/api/stream/youtube/' + route, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let data; try { data = await response.json(); } catch (_) { throw new Error('The server returned an unreadable streaming response.'); }
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'The streaming request failed.'), { code: data.error?.code });
    return data;
  }
  function current(ctx) { return owned === ctx && !ctx.cancelled; }
  function note(ctx, state, message, code) {
    lastClient = { state, id: ctx?.id || null, source: ctx?.options.source || $('yt-mode').value, profile: ctx?.options.profile || $('yt-quality').value, code: code || null,
      events: [...lastClient.events, { at: new Date().toISOString(), state, message }].slice(-80) };
    render({ state, error: state === 'error' ? { message } : null }, message);
  }
  function closeProducer(ctx, tracks = false) {
    clearTimeout(ctx.connectionTimer);
    const ws = ctx.ws; ctx.ws = null;
    try { if (ctx.recorder && ctx.recorder.state !== 'inactive') ctx.recorder.stop(); } catch (_) {}
    ctx.recorder = null;
    try { ws?.close(); } catch (_) {}
    if (tracks) ctx.capture?.getTracks().forEach(track => track.stop());
  }
  function finish(ctx, message, code) {
    if (!current(ctx)) return;
    ctx.cancelled = true; clearTimeout(ctx.retryTimer); closeProducer(ctx, true); ctx.options.key = ''; owned = null;
    note(ctx, code ? 'error' : 'stopped', message, code); void poll();
  }
  function retry(ctx, error) {
    if (!current(ctx) || ctx.retryTimer) return;
    closeProducer(ctx);
    if (!error.retryable || ctx.attempt >= delays.length) return finish(ctx, error.message || 'The stream could not recover. Check diagnostics before restarting.', error.code || 'CONNECTION');
    const delay = delays[ctx.attempt++];
    note(ctx, 'reconnecting', `${error.message || 'Connection interrupted.'} Retrying ${ctx.attempt} of ${delays.length}…`, error.code);
    ctx.retryTimer = setTimeout(() => { ctx.retryTimer = null; if (current(ctx)) connect(ctx); }, delay);
  }
  function connect(ctx) {
    if (!current(ctx)) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/stream/youtube`);
    ctx.ws = ws; ws.binaryType = 'arraybuffer'; ctx.failure = null;
    ctx.connectionTimer = setTimeout(() => { if (current(ctx) && ctx.ws === ws) retry(ctx, { code: 'SOCKET_TIMEOUT', message: 'The relay connection timed out.', retryable: true }); }, 12000);
    ws.onopen = () => { if (!current(ctx) || ctx.ws !== ws) return ws.close(); ws.send(JSON.stringify({ ...ctx.options, hasAudio: ctx.hasAudio })); };
    ws.onmessage = event => {
      if (!current(ctx) || ctx.ws !== ws) return;
      let m; try { m = JSON.parse(event.data); } catch (_) { return; }
      if (m.type === 'ready') {
        clearTimeout(ctx.connectionTimer); ctx.id = m.id;
        try {
          const recorder = new MediaRecorder(ctx.capture, { mimeType: ctx.mime, videoBitsPerSecond: ctx.options.bitrate * 1000, audioBitsPerSecond: 128000 });
          ctx.recorder = recorder; let chain = Promise.resolve(), queuedBytes = 0;
          recorder.ondataavailable = event => {
            if (!event.data?.size || !current(ctx) || ctx.ws !== ws) return;
            queuedBytes += event.data.size;
            if (queuedBytes > maxBuffered) return finish(ctx, 'The browser encoder cannot keep up. Choose a lower quality.', 'BROWSER_OVERLOADED');
            chain = chain.then(async () => {
              for (let offset = 0; offset < event.data.size; offset += sliceBytes) {
                const chunk = await event.data.slice(offset, offset + sliceBytes).arrayBuffer();
                if (!current(ctx) || ctx.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
                if (ws.bufferedAmount + chunk.byteLength > maxBuffered) return finish(ctx, 'The upload cannot keep up. Lower the bitrate and check the network.', 'UPLOAD_OVERLOADED');
                ws.send(chunk);
              }
            }).catch(() => { if (current(ctx) && ctx.ws === ws) finish(ctx, 'The browser could not send captured video.', 'CAPTURE_ENCODE'); }).finally(() => { queuedBytes -= event.data.size; });
          };
          recorder.onerror = () => { if (current(ctx) && ctx.ws === ws) finish(ctx, 'Browser video encoding failed. Restart capture or choose server mode.', 'CAPTURE_ENCODE'); };
          recorder.start(500);
          note(ctx, 'connecting', ctx.audioFallback ? 'Tab audio was not shared; sending silence instead. Connecting to YouTube…' : messages.connecting);
        } catch (_) { finish(ctx, 'This browser could not start video encoding. Choose server mode or OBS.', 'CAPTURE_ENCODE'); }
      } else if (m.type === 'status') { ctx.id = m.id; if (!ctx.retryTimer) render(m); }
      else if (m.type === 'error') { ctx.failure = m; }
      else if (m.type === 'ended') {
        if (m.error || ctx.failure) retry(ctx, m.error || ctx.failure);
        else finish(ctx, 'Stream stopped.', null);
      }
    };
    ws.onerror = () => { if (current(ctx) && ctx.ws === ws) retry(ctx, ctx.failure || { code: 'CONNECTION', message: 'The relay connection failed.', retryable: true }); };
    ws.onclose = () => { if (current(ctx) && ctx.ws === ws) retry(ctx, ctx.failure || { code: 'CONNECTION', message: 'The relay connection closed.', retryable: true }); };
  }
  async function start() {
    if (owned || active || stopping || !capabilities || supportProblem()) return;
    let opts; try { opts = options(); } catch (error) { return render({ state: 'error' }, error.message); }
    const ctx = { options: opts, attempt: 0, cancelled: false, retryTimer: null, capture: null, ws: null, recorder: null }; owned = ctx;
    note(ctx, 'starting', opts.source === 'server' ? 'Preparing server capture…' : 'Choose the /live tab in the share picker…');
    try {
      if (opts.source === 'server') {
        const data = await request('start', opts); ctx.id = data.session.id;
        $('yt-key').value = ''; ctx.options.key = '';
        if (!current(ctx)) { await request('stop', { id: ctx.id }); return; }
        remote = data.session; active = true; render(remote); return;
      }
      const includeAudio = $('yt-audio').value === 'tab';
      const capture = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: opts.profile === '1080p60' ? 60 : 30, max: opts.profile === '1080p60' ? 60 : 30 }, displaySurface: 'browser' }, audio: includeAudio,
        selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'exclude', surfaceSwitching: 'exclude', systemAudio: 'exclude' });
      if (!current(ctx)) { capture.getTracks().forEach(track => track.stop()); return; }
      ctx.capture = capture; ctx.hasAudio = includeAudio && !!capture.getAudioTracks?.().length; ctx.audioFallback = includeAudio && !ctx.hasAudio;
      for (const track of capture.getTracks()) if (!ctx.hasAudio && track.kind === 'audio') track.stop();
      ctx.mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
      if (!ctx.mime) throw Object.assign(new Error(), { code: 'CAPTURE_ENCODE' });
      capture.getVideoTracks()[0]?.addEventListener('ended', () => finish(ctx, 'Tab sharing ended. Stream stopped.', null));
      $('yt-key').value = ''; connect(ctx);
    } catch (error) {
      if (!current(ctx)) return;
      const denied = ['NotAllowedError', 'AbortError'].includes(error.name);
      finish(ctx, denied ? 'Screen share was cancelled or denied.' : error.code === 'CAPTURE_ENCODE' ? 'No supported video encoding format. Choose server mode or OBS.' : error.code ? error.message : 'Capture could not start. Check browser permissions or choose server mode.', error.code || (denied ? 'CAPTURE_DENIED' : 'CAPTURE_START'));
    }
  }
  async function stop() {
    const ctx = owned; stopping = true;
    if (ctx) { ctx.cancelled = true; clearTimeout(ctx.retryTimer); closeProducer(ctx, true); ctx.options.key = ''; owned = null; }
    render({ state: 'stopping' });
    try {
      const id = ctx?.id || (active ? remote?.id : null);
      if (id) await request('stop', { id });
      await poll();
      if (!active) render({ state: 'stopped' });
    } catch (error) { render({ state: 'error' }, error.message); }
    finally { stopping = false; controls(); }
  }
  async function poll() {
    const sequence = ++statusSequence;
    try {
      const data = await request('status'); if (sequence !== statusSequence) return;
      capabilities = data.capabilities; active = data.active; remote = data.session;
      if (!selectedOnce) { selectedOnce = true; $('yt-mode').value = capabilities.serverCapture ? 'server' : 'browser'; qualityChanged(); }
      if (owned?.options.source === 'server' && owned.id && remote.id === owned.id) {
        if (!active) { const ctx = owned; ctx.options.key = ''; owned = null; ctx.cancelled = true; }
        render(remote);
      } else if (!owned && !stopping) {
        if (active) render(remote);
        // Closing a failed browser producer makes the server report "stopped".
        // Preserve the actionable local error instead of erasing it on polling.
        else if (lastClient.state === 'error') render({ state: 'error' }, lastClient.events.at(-1)?.message);
        else if (remote.id && lastClient.id === remote.id) render(remote);
        else if (lastClient.state === 'idle') render(remote);
      }
      controls();
    } catch (_) { if (!owned) render({ state: 'error' }, 'Could not check streaming status. Check the BambuBoard server connection.'); }
  }
  $('yt-start').addEventListener('click', start); $('yt-stop').addEventListener('click', stop);
  $('yt-quality').addEventListener('change', qualityChanged); $('yt-mode').addEventListener('change', controls);
  $('yt-show-key').addEventListener('click', () => {
    const show = $('yt-key').type === 'password'; $('yt-key').type = show ? 'text' : 'password';
    setText('yt-show-key', show ? 'Hide' : 'Show'); $('yt-show-key').setAttribute('aria-label', show ? 'Hide stream key' : 'Show stream key'); $('yt-show-key').setAttribute('aria-pressed', String(show));
  });
  $('yt-check').addEventListener('click', async () => {
    const problem = supportProblem(); if (problem) return render({ state: 'error' }, problem);
    checking = true; controls(); setText('yt-status', 'Checking encoder, capture support and the encrypted YouTube connection…');
    try { const data = await request('check', { source: $('yt-mode').value, destination: $('yt-destination').value }); render({ state: 'idle' }, data.message); }
    catch (error) { render({ state: 'error' }, error.message); }
    finally { checking = false; controls(); }
  });
  $('yt-diagnostics').addEventListener('click', async event => {
    event.preventDefault();
    try {
      const server = await request('diagnostics');
      const blob = new Blob([JSON.stringify({ schema: 1, browser: lastClient, server }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'bambuboard-stream-diagnostics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) { setText('yt-status', 'Diagnostics could not be downloaded. Check the server connection.'); }
  });
  window.addEventListener('beforeunload', event => { if (owned?.options.source === 'browser') { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { if (owned?.options.source === 'browser') { const ctx = owned; ctx.cancelled = true; clearTimeout(ctx.retryTimer); closeProducer(ctx, true); ctx.options.key = ''; owned = null; } });
  controls(); void poll(); setInterval(poll, 2000);
})();
