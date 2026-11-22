const { spawn } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');

const packetBytes = 188;
const maxBufferedBytes = 1024 * 1024;
const streamHeader = Buffer.from([0x6a, 0x73, 0x6d, 0x70, 0, 0, 0, 0]); // jsmp
const defaults = Object.freeze({
  firstFrameMs: 18000, frameGapMs: 9000, backoffMs: 1500, maxBackoffMs: 60000,
  retriesBeforeUnavailable: 3, stableMs: 30000, killGraceMs: 2000,
  refreshMs: 2000, graceMs: 20000,
});

// One shared FFmpeg process for the configured printer. Viewer sockets belong
// to the relay, so a stalled/disconnected child never takes the viewers down.
function createRtspCamera({ resolveUrl, spawn: launch = spawn, timing: overrides }) {
  const timing = { ...defaults, ...overrides };
  const viewers = new Set();
  let source = null, attempt, failureCount = 0, closed = false;
  let grace, retry, refreshTimer;

  function send(viewer, bytes) {
    if (viewer.readyState !== viewer.OPEN) return;
    if (viewer.bufferedAmount + bytes.length > maxBufferedBytes) {
      viewer.terminate();
      return;
    }
    viewer.send(bytes, { binary: true }, error => { if (error) viewer.terminate(); });
  }

  function state() {
    if (closed || !source || !ffmpeg) return 'unavailable';
    if (attempt && !attempt.stopping && attempt.hasFrame) return 'streaming';
    if (failureCount >= timing.retriesBeforeUnavailable) return 'unavailable';
    if (failureCount) return 'reconnecting';
    return viewers.size ? 'connecting' : 'idle';
  }

  function fail() {
    if (viewers.size) failureCount = Math.min(failureCount + 1, 32);
  }

  function beginRetry() {
    if (!viewers.size || !source || closed || retry) return;
    const delay = Math.min(timing.maxBackoffMs, timing.backoffMs * 2 ** (failureCount - 1));
    retry = setTimeout(() => { retry = null; refresh(); }, delay).unref();
  }

  function stopAttempt(current) {
    if (!current || current.stopping) return;
    current.stopping = true;
    clearTimeout(current.watchdog);
    current.killTimer = setTimeout(() => {
      if (attempt === current) current.child.kill('SIGKILL');
    }, timing.killGraceMs).unref();
    current.child.kill('SIGTERM');
  }

  function start() {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-stats_period', '0.5', '-progress', 'pipe:3',
      '-rtsp_transport', 'tcp', '-allowed_media_types', 'video', '-i', source,
      '-map', '0:v:0', '-an', '-codec:v', 'mpeg1video', '-r', '30', '-f', 'mpegts', 'pipe:1',
    ];
    let child;
    try { child = launch(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }); }
    catch (_) { fail(); beginRetry(); return; }

    const current = attempt = { child, url: source, hasFrame: false, stopping: false };
    current.done = new Promise(resolve => { current.resolve = resolve; });
    let tail = Buffer.alloc(0), progress = '', outputAdvanced = false, frameCount = 0, lastFrameCount = 0;
    let healthySince;
    const isActive = () => attempt === current && !current.stopping;

    function armWatchdog(ms) {
      clearTimeout(current.watchdog);
      current.watchdog = setTimeout(onFailure, ms).unref();
    }

    function onFailure() {
      if (!isActive()) return;
      fail();
      stopAttempt(current);
    }

    function confirmFrames() {
      // The JSMpeg header is generated separately. Progress must show an
      // advancing output video frame count, alongside new MPEG-TS packets.
      if (!outputAdvanced || frameCount <= lastFrameCount) return;
      lastFrameCount = frameCount;
      outputAdvanced = false;
      current.hasFrame = true;
      const now = performance.now();
      healthySince ??= now;
      if (now - healthySince >= timing.stableMs) failureCount = 0;
      armWatchdog(timing.frameGapMs);
    }

    child.stdout.on('data', chunk => {
      if (!isActive()) return;
      const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      const end = bytes.length - bytes.length % packetBytes;
      tail = Buffer.from(bytes.subarray(end));
      if (!end) return;
      const packets = bytes.subarray(0, end);
      // Only send complete transport packets, so replacing a process can
      // never leave half a packet in the browser's demuxer.
      for (const viewer of viewers) send(viewer, packets);
      outputAdvanced = true;
      confirmFrames();
    });
    child.stdio[3].on('data', chunk => {
      if (!isActive()) return;
      const lines = (progress + chunk).split('\n');
      progress = lines.pop();
      if (progress.length > 1024) progress = '';
      for (const line of lines) {
        const frame = /^frame=\s*(\d+)\s*$/.exec(line);
        if (frame) frameCount = Number(frame[1]);
      }
      confirmFrames();
    });
    // FFmpeg errors can include the camera URL with credentials. Drain them
    // and derive the public status from frame delivery and process events.
    child.stderr.resume();
    for (const stream of [child.stdout, child.stderr, child.stdio[3]]) stream.on('error', onFailure);
    child.on('error', onFailure);
    child.once('close', () => {
      clearTimeout(current.watchdog);
      clearTimeout(current.killTimer);
      if (attempt === current) {
        if (!current.stopping) fail();
        attempt = null;
        if (failureCount && current.url === source) beginRetry();
        else refresh();
      }
      current.resolve();
    });
    armWatchdog(timing.firstFrameMs);
  }

  function refresh() {
    if (closed) return;
    const url = resolveUrl();
    if (url !== source) {
      source = url;
      failureCount = 0;
      clearTimeout(retry);
      retry = null;
      stopAttempt(attempt);
    }
    if (viewers.size && source && ffmpeg && !attempt && !retry) start();
  }

  function subscribe(viewer) {
    if (closed) { viewer.close(1001); return; }
    clearTimeout(grace);
    grace = null;
    viewers.add(viewer);
    send(viewer, streamHeader);
    viewer.once('close', () => {
      viewers.delete(viewer);
      if (closed || viewers.size || grace) return;
      grace = setTimeout(() => {
        grace = null;
        clearTimeout(retry);
        retry = null;
        clearInterval(refreshTimer);
        refreshTimer = null;
        failureCount = 0;
        stopAttempt(attempt);
      }, timing.graceMs).unref();
    });
    viewer.on('error', () => viewer.terminate());
    refreshTimer ??= setInterval(refresh, timing.refreshMs).unref();
    refresh();
  }

  function stop() {
    closed = true;
    clearTimeout(retry);
    clearTimeout(grace);
    clearInterval(refreshTimer);
    for (const viewer of viewers) viewer.terminate();
    viewers.clear();
    stopAttempt(attempt);
    return attempt?.done;
  }

  return { subscribe, refresh, state, stop, forceStop() { attempt?.child.kill('SIGKILL'); } };
}

module.exports = { createRtspCamera, rtspReady: Boolean(ffmpeg) };
