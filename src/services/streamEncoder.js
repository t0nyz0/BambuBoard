const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const ffmpeg = require('ffmpeg-static');

// H.264/CBR presets from YouTube's encoder guidance, reviewed October 2026.
const PROFILES = [
  { id: '720p30', label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 8000 },
  { id: '1080p30', label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 14000 },
  { id: '1080p60', label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 17000 },
];
const LIMITS = { chunk: 1024 * 1024, queue: 8 * 1024 * 1024, startup: 45000, inputIdle: 15000, outputIdle: 30000 };
class StreamError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}
function settings(input = {}, allowLocal = false) {
  const profile = PROFILES.find(p => p.id === (input.profile || '720p30'));
  if (!profile) throw new StreamError('SETTINGS', 'Choose a supported video quality.');
  if (input.source === 'server' && profile.fps > 30) throw new StreamError('SETTINGS', 'Server capture supports up to 30 fps. Use browser capture for 60 fps.');
  const bitrate = input.bitrate == null ? profile.bitrate : Number(input.bitrate);
  if (!Number.isInteger(bitrate) || bitrate < 1000 || bitrate > 25000) throw new StreamError('SETTINGS', 'Video bitrate must be between 1,000 and 25,000 kbps.');
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(key)) throw new StreamError('STREAM_KEY', 'Paste the stream key from YouTube Studio, without a URL or spaces.');
  const destination = input.destination === 'backup' ? 'backup' : 'primary';
  let base = `rtmps://${destination === 'backup' ? 'b' : 'a'}.rtmps.youtube.com:443/live2`;
  if (input.rtmpBase != null) {
    let url; try { url = new URL(input.rtmpBase); } catch (_) {}
    if (!allowLocal || !url || url.protocol !== 'rtmp:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
      throw new StreamError('DESTINATION', 'Use the YouTube primary or backup server.');
    }
    base = url.href.replace(/\/+$/, '');
  }
  return { profile: { ...profile, bitrate }, key, destination, url: `${base}/${key}`, hasAudio: input.hasAudio === true, source: input.source === 'server' ? 'server' : 'browser' };
}
function encoderArgs(options) {
  const { profile: p, url, source, hasAudio } = options;
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-stats_period', '1', '-progress', 'pipe:3', '-thread_queue_size', '16'];
  if (source === 'server') args.push('-probesize', '32', '-analyzeduration', '0', '-use_wallclock_as_timestamps', '1', '-f', 'image2pipe', '-framerate', '30', '-vcodec', 'mjpeg');
  args.push('-i', 'pipe:0');
  if (!hasAudio) args.push('-re', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${p.fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', source === 'server' ? 'ultrafast' : 'veryfast', '-threads', '2', '-profile:v', 'main',
    '-g', String(p.fps * 2), '-keyint_min', String(p.fps * 2), '-sc_threshold', '0', '-bf', '2', '-refs', '1',
    '-b:v', `${p.bitrate}k`, '-minrate', `${p.bitrate}k`, '-maxrate', `${p.bitrate}k`, '-bufsize', `${p.bitrate * 2}k`,
    '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-coder', '1', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-shortest',
    '-rw_timeout', '15000000');
  if (url.startsWith('rtmps:')) args.push('-tls_verify', '1');
  // RTMP's application name carries the backup flag; the stream key remains
  // the playpath. Putting the query after the key changes its meaning.
  if (options.destination === 'backup') args.push('-rtmp_app', 'live2?backup=1');
  args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', url);
  return args;
}
function classify(text) {
  if (/certificate|TLS|SSL|handshake/i.test(text)) return new StreamError('TLS', 'The encrypted YouTube connection failed. Check server time and certificate trust.', true);
  if (/auth|denied|unauthorized|403|401|BadName|invalid.*key|already.*publish/i.test(text)) return new StreamError('STREAM_KEY', 'YouTube rejected the stream. Check the key and whether another encoder is already using it.');
  if (/refused|timed out|unreachable|resolve|Input\/output error|Broken pipe|reset by peer/i.test(text)) return new StreamError('CONNECTION', 'The YouTube connection was interrupted. Check the server internet connection and YouTube Studio.', true);
  return new StreamError('ENCODER', 'The server could not encode this capture. Check diagnostics, try a lower quality or restart the capture.');
}
function redact(value, secrets = []) {
  let text = String(value).replace(/(?:rtmps?|https?|wss?):\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.slice(0, 800);
}

class StreamEncoder extends EventEmitter {
  constructor(options, { spawnEncoder = spawn, limits = LIMITS } = {}) {
    super(); this.options = { ...options, profile: { ...options.profile } }; this.spawnEncoder = spawnEncoder; this.limits = { ...LIMITS, ...limits };
    this.id = randomUUID(); this.createdAt = Date.now(); this.state = 'starting'; this.logs = []; this.metrics = {};
    this.inputBytes = 0; this.lastInput = 0; this.lastOutput = 0; this.error = null; this.stopping = false;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }
  snapshot() { return { id: this.id, source: this.options.source, profile: this.options.profile, destination: this.options.destination, hasAudio: this.options.hasAudio, state: this.state, startedAt: this.createdAt, elapsedMs: Date.now() - this.createdAt, inputBytes: this.inputBytes, ...this.metrics, error: this.error }; }
  event() { this.emit('status', this.snapshot()); }
  log(text) { this.logs.push({ at: new Date().toISOString(), text: redact(text, [this.options.key, encodeURIComponent(this.options.key)]) }); if (this.logs.length > 100) this.logs.shift(); }
  start() {
    this.log('Encoder starting.'); this.event();
    let child;
    try { child = this.spawnEncoder(ffmpeg, encoderArgs(this.options), { stdio: ['pipe', 'ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (_) { this.fail(new StreamError('ENCODER_START', 'The server video encoder could not start. Check the FFmpeg installation.')); this.finish(); return; }
    this.child = child;
    let errors = '', progress = '', fields = {};
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => {
      errors = (errors + chunk.toString()).slice(-32768);
      const lines = errors.split(/\r?\n/); errors = lines.pop();
      for (const line of lines) if (line.trim()) { this.lastError = redact(line, [this.options.key]); this.log(line); }
    });
    child.stdio[3].on('data', chunk => {
      progress = (progress + chunk.toString()).slice(-8192);
      const lines = progress.split('\n'); progress = lines.pop();
      for (const line of lines) {
        const equal = line.indexOf('='); if (equal < 0) continue;
        const key = line.slice(0, equal), value = line.slice(equal + 1).trim(); fields[key] = value;
        if (key !== 'progress') continue;
        const frame = Number(fields.frame) || 0, bytes = Number(fields.total_size) || 0;
        if (frame > (this.metrics.frames || 0) && bytes > 0) this.lastOutput = Date.now();
        this.metrics = { frames: frame, outputBytes: bytes, fps: Number(fields.fps) || 0, speed: Number(String(fields.speed || '').replace('x', '')) || 0, videoTimeMs: (Number(fields.out_time_us) || 0) / 1000 };
        fields = {};
        if (!this.stopping && !this.error && frame > 0 && bytes > 0) this.state = 'sending';
        this.event();
      }
    });
    child.once('spawn', () => { if (!this.stopping) { this.state = 'connecting'; this.event(); this.emit('ready'); } });
    child.once('error', () => { this.fail(new StreamError('ENCODER_START', 'The server video encoder could not start. Check the FFmpeg installation.')); this.finish(); });
    child.once('close', (code, signal) => {
      if (errors.trim()) { this.lastError = redact(errors, [this.options.key]); this.log(errors); }
      if (!this.stopping && !this.error) this.fail(classify(this.logs.map(entry => entry.text).join('\n') || `Encoder exited (${code}, ${signal || 'no signal'}).`));
      this.finish();
    });
    this.watch = setInterval(() => {
      if (this.stopping || this.error) return;
      const now = Date.now();
      if (!this.lastOutput && now - this.createdAt > this.limits.startup) this.fail(new StreamError('START_TIMEOUT', 'No video reached the output before the startup deadline. Check diagnostics and restart the capture.', true));
      else if (this.lastInput && now - this.lastInput > this.limits.inputIdle) this.fail(new StreamError('CAPTURE_STALLED', this.options.source === 'server' ? 'Server scene capture stopped sending frames. Check the published scene and server resources.' : 'The video source stopped sending frames. Keep the shared tab active or restart the source.', true));
      else if (this.lastOutput && now - this.lastOutput > this.limits.outputIdle) this.fail(new StreamError('OUTPUT_STALLED', 'The encoder stopped sending video. Try a lower quality and check the server connection.', true));
    }, 1000); this.watch.unref();
  }
  write(data) {
    if (this.stopping || this.error || !this.child?.stdin.writable) return false;
    if (!data.length || data.length > this.limits.chunk) { this.fail(new StreamError('CHUNK_LIMIT', 'A video chunk exceeded the relay limit. Restart the capture.')); return false; }
    if (this.child.stdin.writableLength + data.length > this.limits.queue) { this.fail(new StreamError('ENCODER_OVERLOADED', 'The encoder cannot keep up. Select a lower quality before restarting.')); return false; }
    this.inputBytes += data.length; this.lastInput = Date.now();
    this.child.stdin.write(data); return true;
  }
  fail(error) {
    if (this.error || this.stopping) return;
    this.error = { code: error.code || 'ENCODER', message: error.message, retryable: !!error.retryable };
    this.state = 'error'; this.log(error.message); this.event(); this.emit('failure', this.error); this.closeEncoder();
  }
  stop() {
    if (!this.error) { this.stopping = true; this.state = 'stopping'; this.event(); }
    this.closeEncoder(); return this.done;
  }
  closeEncoder() {
    clearInterval(this.watch);
    if (!this.child) { this.finish(); return; }
    try { this.child.stdin.end(); } catch (_) {}
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => {
      try { this.child?.kill('SIGTERM'); } catch (_) {}
      this.forceTimer = setTimeout(() => { try { this.child?.kill('SIGKILL'); } catch (_) {} }, 1500); this.forceTimer.unref();
    }, 2500); this.killTimer.unref();
  }
  finish() {
    if (this.finished) return; this.finished = true;
    clearInterval(this.watch); clearTimeout(this.killTimer); clearTimeout(this.forceTimer);
    if (!this.error) this.state = 'stopped';
    this.event(); this.child = null; this.options.key = ''; this.options.url = ''; this.resolveDone(); this.emit('finished');
  }
  diagnostics() { return { schema: 1, capturedAt: new Date().toISOString(), session: this.snapshot(), events: this.logs }; }
}
module.exports = { PROFILES, LIMITS, StreamError, settings, encoderArgs, redact, StreamEncoder };
