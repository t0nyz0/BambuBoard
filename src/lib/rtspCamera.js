const { spawn } = require('node:child_process');
const { ffmpeg } = require('./ffmpeg');

const packetBytes = 188;
const videoPid = 0x100;
const sequenceStart = Buffer.from([0, 0, 1, 0xb3]);
const maxBufferedBytes = 1024 * 1024;
const streamHeader = Buffer.from([0x6a, 0x73, 0x6d, 0x70, 0, 0, 0, 0]); // jsmp
const defaults = Object.freeze({
  firstFrameMs: 18000, frameGapMs: 9000, backoffMs: 1500, maxBackoffMs: 60000,
  retriesBeforeUnavailable: 3, stableMs: 30000, killGraceMs: 2000,
  refreshMs: 2000, graceMs: 20000, pingMs: 15000, pongMs: 35000,
});

// Decode only the dimensions in this encoder's MPEG-1 sequence header.
// A header can span two TS packets or separate writes to the pipe.
function createFormatReader() {
  let tail = Buffer.alloc(0), format = null;
  return packets => {
    for (let offset = 0; offset < packets.length; offset += packetBytes) {
      const end = offset + packetBytes;
      const flags = packets[offset + 3];
      const pid = ((packets[offset + 1] & 0x1f) << 8) | packets[offset + 2];
      if (packets[offset] !== 0x47 || pid !== videoPid || !(flags & 0x10)) continue;
      let start = offset + 4;
      if (flags & 0x20) start += 1 + packets[start];
      if (start >= end) continue;
      if ((packets[offset + 1] & 0x40) && start + 9 <= end) start += 9 + packets[start + 8]; // PES header
      if (start >= end) continue;
      const payload = packets.subarray(start, end);
      const bytes = tail.length ? Buffer.concat([tail, payload]) : payload;
      for (let i = bytes.indexOf(sequenceStart); i !== -1 && i + 7 <= bytes.length; i = bytes.indexOf(sequenceStart, i + 4)) {
        const width = (bytes[i + 4] << 4) | (bytes[i + 5] >> 4);
        const height = ((bytes[i + 5] & 0x0f) << 8) | bytes[i + 6];
        if (width && height && (format?.width !== width || format?.height !== height)) format = { width, height };
      }
      tail = Buffer.from(bytes.subarray(-6));
    }
    return format;
  };
}

// One shared FFmpeg process for the configured printer. Viewer sockets belong
// to the relay, so a stalled/disconnected child never takes the viewers down.
function createRtspCamera({ resolveUrl, spawn: launch = spawn, timing: overrides }) {
  const timing = { ...defaults, ...overrides };
  const viewers = new Map();
  let source = null, attempt, failureCount = 0, closed = false;
  let grace, retry, refreshTimer, lastPing = performance.now();

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
      '-map', '0:v:0', '-an', '-codec:v', 'mpeg1video', '-r', '30', '-streamid', `0:${videoPid}`, '-f', 'mpegts', 'pipe:1',
    ];
    let child;
    try { child = launch(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }); }
    catch (_) { fail(); beginRetry(); return; }

    const current = attempt = { child, url: source, hasFrame: false, stopping: false };
    current.done = new Promise(resolve => { current.resolve = resolve; });
    const readFormat = createFormatReader();
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
      current.format = readFormat(packets);
      for (const [viewer, data] of viewers) {
        if (data.matchFormat) {
          if (data.format && !current.format) continue;
          if (data.format && (data.format.width !== current.format.width || data.format.height !== current.format.height)) {
            if (viewer.readyState === viewer.OPEN) viewer.close(1012, 'Camera video size changed');
            continue;
          }
          data.format ??= current.format;
        }
        send(viewer, packets);
      }
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

  function maintainViewers() {
    const now = performance.now();
    const ping = now - lastPing >= timing.pingMs;
    if (ping) lastPing = now;
    for (const [viewer, data] of viewers) {
      if (now - data.lastPong >= timing.pongMs) viewer.terminate();
      else if (ping && viewer.readyState === viewer.OPEN) viewer.ping();
    }
    refresh();
  }

  function subscribe(viewer, matchFormat = false) {
    if (closed) { viewer.close(1001); return; }
    clearTimeout(grace);
    grace = null;
    const data = { lastPong: performance.now(), matchFormat };
    viewers.set(viewer, data);
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
    viewer.on('pong', () => { data.lastPong = performance.now(); });
    viewer.on('error', () => viewer.terminate());
    refreshTimer ??= setInterval(maintainViewers, timing.refreshMs).unref();
    refresh();
  }

  function stop() {
    closed = true;
    clearTimeout(retry);
    clearTimeout(grace);
    clearInterval(refreshTimer);
    for (const viewer of viewers.keys()) viewer.terminate();
    viewers.clear();
    stopAttempt(attempt);
    return attempt?.done;
  }

  return {
    subscribe, refresh, state, stop,
    format: () => attempt?.stopping ? null : attempt?.format || null,
    forceStop() { attempt?.child.kill('SIGKILL'); },
  };
}

module.exports = { createRtspCamera, rtspReady: Boolean(ffmpeg) };
