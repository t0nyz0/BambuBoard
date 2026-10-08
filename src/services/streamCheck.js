const tls = require('node:tls');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const ffmpeg = require('ffmpeg-static');
const { browserPath } = require('./streamCapture');
const { StreamError } = require('./streamEncoder');
async function checkSetup(input) {
  let codecs;
  try { codecs = (await execFile(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 8000, maxBuffer: 512 * 1024 })).stdout; }
  catch (_) { throw new StreamError('ENCODER_START', 'FFmpeg could not run on this server. Check its installation.'); }
  if (!/\s+libx264\s/.test(codecs) || !/\s+aac\s/.test(codecs)) throw new StreamError('ENCODER_CODEC', 'The server FFmpeg installation needs H.264 (libx264) and AAC encoding.');
  if (input.source === 'server') {
    const binary = browserPath();
    if (!binary) throw new StreamError('BROWSER_MISSING', 'Server capture needs Chromium. Set BAMBUBOARD_CHROMIUM_BIN or use the Docker image with Chromium.');
    try { await execFile(binary, ['--version'], { timeout: 8000, maxBuffer: 8192 }); }
    catch (_) { throw new StreamError('CAPTURE_BROWSER', 'The installed capture browser could not run. Check its dependencies.'); }
  }
  const host = `${input.destination === 'backup' ? 'b' : 'a'}.rtmps.youtube.com`;
  await new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    let done = false;
    const finish = error => { if (done) return; done = true; socket.destroy(); if (error) reject(error); else resolve(); };
    socket.setTimeout(8000, () => finish(new StreamError('CONNECTION', 'The encrypted YouTube connection timed out. Check server internet access to port 443.', true)));
    socket.once('secureConnect', () => finish());
    socket.once('error', error => finish(new StreamError(/CERT|TLS|SSL/.test(error.code || '') ? 'TLS' : 'CONNECTION', 'The server could not establish a trusted encrypted YouTube connection. Check DNS, firewall rules, server time and certificates.', true)));
  });
  return { ok: true, message: 'Encoder and capture checks passed. The encrypted YouTube server is reachable. The stream key and public broadcast are verified when you start and check YouTube Studio.' };
}
module.exports = { checkSetup };
