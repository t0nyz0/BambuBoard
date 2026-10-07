// Browser → server → RTMP relay for streaming the composited /live view to
// YouTube (or any RTMP endpoint) without OBS.
//
// The browser captures the /live tab (getDisplayMedia), encodes it with
// MediaRecorder (WebM/VP8/9 or MP4/H264), and sends the chunks over this
// WebSocket. The server pipes them into ffmpeg, which transcodes to H.264 +
// AAC and pushes FLV over RTMP. A silent audio track is synthesized so the
// endpoint always gets audio (print streams usually have none).
//
// Protocol on WS /api/stream/youtube:
//   1. First message (text JSON): { rtmpBase?, key }
//        rtmpBase defaults to YouTube's ingest; key is the stream key.
//   2. Subsequent messages (binary): MediaRecorder chunks → ffmpeg stdin.
//   3. Server → browser status (text JSON): { type: 'started'|'ended'|'error', … }.
//
// NOTE: requires express-ws to already be applied to `app` (the video relay
// does this). Heavy server work (H.264 encode) — fine on a desktop, not a Pi.

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function buildStreamRouter({ app }) {
  if (typeof app.ws !== 'function') {
    console.warn('[bambuboard] stream relay unavailable: express-ws not initialized');
    return;
  }

  app.ws('/api/stream/youtube', (ws) => {
    let ff = null;
    let started = false;
    let shutdownTimer = null;
    let forceKillTimer = null;

    function clearShutdownTimers() {
      clearTimeout(shutdownTimer);
      clearTimeout(forceKillTimer);
      shutdownTimer = null;
      forceKillTimer = null;
    }

    const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} };

    function start(rtmpUrl) {
      // -i pipe:0          → the browser's encoded media
      // anullsrc           → synthesized silent stereo audio
      // Pace silence in real time and end it when the browser video ends.
      // libx264 + yuv420p  → YouTube-compatible H.264
      // -g 60 (~2s @30fps) → keyframe interval YouTube wants
      const args = [
        '-i', 'pipe:0',
        '-re', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-g', '60', '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-shortest',
        '-f', 'flv', rtmpUrl,
      ];
      const encoder = spawn(ffmpegPath, args);
      ff = encoder;
      encoder.stdin.on('error', () => {}); // EPIPE when ffmpeg exits first
      encoder.stderr.on('data', () => {});
      encoder.on('error', () => {
        clearShutdownTimers();
        if (ff === encoder) ff = null;
        send({ type: 'error', msg: 'Video encoder could not start on the server.' });
        try { ws.close(); } catch (_) {}
      });
      encoder.on('exit', (code, signal) => {
        clearShutdownTimers();
        send({ type: 'ended', code, signal });
        if (ff === encoder) ff = null;
        try { ws.close(); } catch (_) {}
      });
      started = true;
      send({ type: 'started' });
    }

    ws.on('message', (data, isBinary) => {
      if (!started) {
        // First message is the control JSON.
        try {
          const msg = JSON.parse(data.toString());
          const base = String(msg.rtmpBase || 'rtmp://a.rtmp.youtube.com/live2').trim();
          const key = String(msg.key || '').trim();
          if (!/^rtmps?:\/\//i.test(base)) return send({ type: 'error', msg: 'RTMP URL must start with rtmp:// or rtmps://' });
          if (!key) return send({ type: 'error', msg: 'Missing stream key' });
          start(`${base.replace(/\/+$/, '')}/${key}`);
        } catch (_) {
          send({ type: 'error', msg: 'Expected a JSON control message first' });
        }
        return;
      }
      // Media chunk → ffmpeg stdin.
      if (ff && ff.stdin.writable) {
        ff.stdin.write(isBinary ? data : Buffer.from(data));
      }
    });

    ws.on('close', () => {
      if (ff) {
        const encoder = ff;
        try { encoder.stdin.end(); } catch (_) {} // flush + let ffmpeg finish
        shutdownTimer = setTimeout(() => {
          if (ff !== encoder) return;
          try { encoder.kill('SIGTERM'); } catch (_) {}
          forceKillTimer = setTimeout(() => {
            if (ff === encoder) { try { encoder.kill('SIGKILL'); } catch (_) {} }
          }, 2000);
          forceKillTimer.unref();
        }, 3000);
        shutdownTimer.unref();
      }
    });
  });

  console.log('[bambuboard] YouTube stream relay ready at ws://*/api/stream/youtube');
}

module.exports = { buildStreamRouter };
