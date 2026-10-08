// Actual controls -> MediaRecorder -> WebSocket -> encoder, plus deterministic
// recovery fixtures. Ingest is forcibly loopback-only in this test harness.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const { buildStreamRouter } = require('../src/routes/stream');
const { StreamEncoder } = require('../src/services/streamEncoder');
const { until } = require('./helpers');
const root = path.resolve(__dirname, '..'), ffmpeg = require('ffmpeg-static');
(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-stream-browser-'));
  const artifacts = process.env.BB_SCREENSHOTS || path.join(data, 'screenshots'); await fs.mkdir(artifacts, { recursive: true });
  let browser, server, receiver, streaming, mode = 'fake', failuresLeft = 0, starts = 0, capturesStopped = 0, rtmpPort;
  const buffers = [], errors = [], passed = [], encoders = [];
  const app = express(); require('express-ws')(app); app.use(express.json());
  app.get('/', (_req, res) => res.sendFile(path.join(root, 'views/hub.html')));
  app.get('/live', (_req, res) => res.send('<!doctype html><style>body{margin:0;background:#13241e;color:#f1f6f4;font:28px sans-serif}.live-item{display:grid;place-content:center;height:100vh}</style><div class="live-item">Published print scene · sample telemetry</div>'));
  app.get('/api/status', (_req, res) => res.json({ version: '3.2.0', configured: true, connected: true, printer: { name: 'Demo H2D', type: 'H2D' }, cloud: { signedIn: false } }));
  app.get('/api/obs/active', (_req, res) => res.json({ slug: 'Studio demo', resolution: { x: 1920, y: 1080 } }));
  app.get('/api/obs/scenes', (_req, res) => res.json([]));
  app.use(express.static(path.join(root, 'public')));
  const fakeEncoder = options => {
    const child = new EventEmitter(), index = buffers.length; buffers.push([]); let closed = false, wrote = false;
    child.exit = () => { if (!closed) { closed = true; child.emit('close', 1, null); } }; child.kill = child.exit;
    child.stderr = new PassThrough(); child.stdio = [null, null, child.stderr, new PassThrough()];
    child.stdin = new Writable({ write(chunk, _e, cb) { buffers[index].push(Buffer.from(chunk)); cb(); if (!wrote) { wrote = true; if (failuresLeft > 0) { failuresLeft--; setTimeout(() => { child.stderr.write('Connection reset by peer\n'); child.exit(); }, 20); } else child.stdio[3].write('frame=30\nfps=30\ntotal_size=9000\nout_time_us=1000000\nspeed=1x\nprogress=continue\n'); } }, final(cb) { cb(); queueMicrotask(child.exit); } });
    child.stdio[0] = child.stdin; queueMicrotask(() => child.emit('spawn'));
    return new StreamEncoder(options, { spawnEncoder: () => child });
  };
  streaming = buildStreamRouter({ app, paths: { data }, createEncoder: options => { starts++; const encoder = mode === 'real' ? new StreamEncoder({ ...options, url: `rtmp://127.0.0.1:${rtmpPort}/live/fixture-browser` }) : fakeEncoder(options); encoders.push(encoder); return encoder; },
    createCapture: async hooks => { const timer = setInterval(() => { if (!hooks.signal.aborted) hooks.onFrame(Buffer.from('fixture-frame')); }, 50); return { async stop() { clearInterval(timer); capturesStopped++; } }; }, preflight: async () => ({ ok: true, message: 'Fixture checks passed. No stream key was sent.' }) });
  try {
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'dark', acceptDownloads: true });
    await context.addInitScript(() => {
      window.__shareMode = 'normal'; window.__stoppedTracks = 0;
      const NativeRecorder = window.MediaRecorder;
      window.MediaRecorder = class extends NativeRecorder { constructor(...args) { super(...args); window.__recorder = this; } };
      const makeStream = () => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const ctx = canvas.getContext('2d'); let frame = 0;
        const draw = () => { ctx.fillStyle = '#153428'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#83d4b7'; ctx.fillRect(frame++ % 500, 50, 100, 200); }; draw(); const timer = setInterval(draw, 33);
        const stream = canvas.captureStream(30); for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { window.__stoppedTracks++; clearInterval(timer); stop(); }; } return stream; };
      navigator.mediaDevices.getDisplayMedia = async () => { if (window.__shareMode === 'denied') throw new DOMException('Fixture denied', 'NotAllowedError'); if (window.__shareMode === 'pending') return new Promise(resolve => { window.__resolveShare = () => resolve(makeStream()); }); const stream = makeStream(); window.__lastStream = stream; return stream; };
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const open = async () => { await page.goto(base); await page.waitForFunction(() => !document.getElementById('yt-mode').disabled); await page.locator('#youtube-details').evaluate(n => { n.open = true; }); };
    const browserMode = async () => { await page.locator('#yt-mode').selectOption('browser'); await page.locator('#yt-key').fill('fixture-private-key'); };
    const start = () => page.locator('#yt-start').click();
    const stopped = async () => { await until(() => !streaming.status().id || ['stopped', 'error'].includes(streaming.status().state)); await page.waitForFunction(() => !document.getElementById('yt-start').disabled); };
    await open(); assert.equal(await page.locator('#yt-mode').inputValue(), 'server'); assert.equal(await page.locator('#yt-audio').isEnabled(), false);
    const order = await page.evaluate(() => { const y = document.querySelector('.youtube-section'), p = document.querySelector('.preview-card'), o = document.querySelector('.obs-card'); return p.compareDocumentPosition(o) & 4 && o.compareDocumentPosition(y) & 4; }); assert.ok(order);
    await page.locator('#yt-quality').selectOption('1080p30'); assert.equal(await page.locator('#yt-bitrate').inputValue(), '14000');
    await page.locator('#yt-quality').selectOption('720p30'); await page.locator('#yt-key').fill('fixture-private-key'); await page.locator('#yt-show-key').click(); assert.equal(await page.locator('#yt-key').getAttribute('type'), 'text'); await page.locator('#yt-show-key').click();
    const beforeCheck = starts; await page.locator('#yt-check').click(); await page.waitForFunction(() => document.getElementById('yt-status').textContent.includes('Fixture checks passed')); assert.equal(starts, beforeCheck);
    const accessibility = await new AxeBuilder({ page }).include('.youtube-section').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); assert.deepEqual(accessibility.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    await open(); await page.locator('.youtube-section').screenshot({ path: path.join(artifacts, 'youtube-controls-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.locator('.youtube-section').screenshot({ path: path.join(artifacts, 'youtube-controls-mobile.png') }); await page.setViewportSize({ width: 1440, height: 1100 });
    passed.push('Preview and OBS retain priority; quality, masked key, preflight, accessibility and mobile layout work');

    await browserMode(); await page.evaluate(() => { window.__shareMode = 'denied'; }); const deniedStarts = starts; await start(); await page.waitForFunction(() => document.getElementById('yt-status').textContent.includes('cancelled or denied')); assert.equal(starts, deniedStarts); assert.ok(await page.locator('#yt-start').isEnabled());
    await page.evaluate(() => { window.__shareMode = 'pending'; }); await start(); await page.locator('#yt-stop').click(); await page.evaluate(() => window.__resolveShare()); await page.waitForFunction(() => window.__stoppedTracks > 0); assert.equal(starts, deniedStarts);
    passed.push('Denied sharing and cancellation of a pending share picker create no hidden stream');

    await open(); await browserMode(); await page.locator('#yt-audio').selectOption('tab'); failuresLeft = 1;
    const firstBuffer = buffers.length; await start(); await page.waitForFunction(() => document.getElementById('yt-status').textContent.includes('Retrying 1 of 3'));
    await page.evaluate(() => { window.__staleRecorder = window.__recorder; });
    await page.waitForFunction(() => document.getElementById('yt-state-badge').textContent === 'Sending video');
    await page.evaluate(() => window.__staleRecorder.onerror({ error: new Error('Late old-recorder failure') }));
    assert.equal(await page.locator('#yt-state-badge').innerText(), 'Sending video');
    assert.equal(buffers.length, firstBuffer + 2); for (let i = firstBuffer; i < firstBuffer + 2; i++) assert.equal(buffers[i][0].subarray(0, 4).toString('hex'), '1a45dfa3', 'Every retry needs a fresh WebM header');
    assert.equal(streaming.status().hasAudio, false); assert.equal(await page.locator('#yt-key').inputValue(), '');
    await page.locator('.youtube-section').screenshot({ path: path.join(artifacts, 'youtube-sending.png') });
    await page.locator('#youtube-details').evaluate(n => { n.open = false; }); assert.equal(await page.locator('#yt-stop').isVisible(), true); await page.locator('#yt-stop').click(); await stopped(); assert.ok(await page.evaluate(() => window.__stoppedTracks > 0));
    passed.push('Real MediaRecorder retries use new container headers; missing tab audio supplies silence; Stop remains available when collapsed');

    await open(); await browserMode(); failuresLeft = 1; const retryStarts = starts; await start(); await page.waitForFunction(() => document.getElementById('yt-status').textContent.includes('Retrying 1 of 3')); await page.locator('#yt-stop').click(); await page.waitForTimeout(1200); assert.equal(starts, retryStarts + 1);
    passed.push('Stopping during browser recovery cancels the retry and releases capture');

    await open(); await browserMode(); await start(); await page.waitForFunction(() => document.getElementById('yt-state-badge').textContent === 'Sending video');
    await page.evaluate(() => window.__recorder.ondataavailable({ data: new Blob([new Uint8Array(9 * 1024 * 1024)]) }));
    await page.waitForFunction(() => document.getElementById('yt-status').textContent.includes('cannot keep up'));
    await page.waitForTimeout(2200); assert.match(await page.locator('#yt-status').innerText(), /cannot keep up/); assert.ok(await page.locator('#yt-start').isEnabled());
    passed.push('Browser buffering is bounded and actionable overload errors survive status polling');

    await open(); await page.locator('#yt-key').fill('fixture-private-key'); await start(); await page.waitForFunction(() => document.getElementById('yt-state-badge').textContent === 'Sending video'); const serverId = streaming.status().id;
    await page.close(); const replacement = await context.newPage(); await replacement.goto(base); await replacement.waitForFunction(() => document.getElementById('yt-stop').disabled === false); assert.equal(streaming.status().id, serverId); assert.equal(await replacement.locator('#youtube-details').evaluate(n => n.open), false);
    await replacement.locator('#yt-stop').click(); await until(() => streaming.status().state === 'stopped'); assert.ok(capturesStopped > 0);
    await replacement.locator('#youtube-details').evaluate(n => { n.open = true; }); const downloadPromise = replacement.waitForEvent('download'); await replacement.locator('#yt-diagnostics').click(); const download = await downloadPromise; const reportPath = path.join(artifacts, 'stream-diagnostics.json'); await download.saveAs(reportPath); const report = await fs.readFile(reportPath, 'utf8'); assert.ok(!report.includes('fixture-private-key')); assert.equal(JSON.parse(report).server.session.state, 'stopped');
    passed.push('Server stream survives closing controls, is managed from a fresh page and downloads redacted diagnostics');

    const rtmpServer = net.createServer(); await new Promise(r => rtmpServer.listen(0, '127.0.0.1', r)); rtmpPort = rtmpServer.address().port; await new Promise(r => rtmpServer.close(r));
    const received = path.join(data, 'browser.flv'); receiver = spawn(ffmpeg, ['-v', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${rtmpPort}/live/fixture-browser`, '-c', 'copy', '-t', '3', '-f', 'flv', received]); let receiverError = ''; receiver.stderr.on('data', b => { receiverError += b; }); await new Promise(r => setTimeout(r, 250));
    mode = 'real'; await replacement.locator('#yt-mode').selectOption('browser'); await replacement.locator('#yt-key').fill('fixture-private-key'); await replacement.locator('#yt-start').click(); await replacement.waitForFunction(() => document.getElementById('yt-state-badge').textContent === 'Sending video', null, { timeout: 40000 }); await replacement.locator('#yt-stop').click(); await until(() => receiver.exitCode !== null, 10000); assert.equal(receiver.exitCode, 0, receiverError);
    execFileSync(ffmpeg, ['-v', 'error', '-i', received, '-f', 'null', '-'], { timeout: 5000, stdio: 'pipe' }); assert.ok((await fs.stat(received)).size > 10000);
    passed.push('Actual browser canvas capture -> MediaRecorder -> WebSocket -> H.264/AAC -> loopback RTMP produces playable video');
    assert.deepEqual(errors, []); assert.ok(encoders.every(e => e.finished));
    await fs.writeFile(path.join(artifacts, 'stream-browser-check.json'), JSON.stringify({ passed, browserErrors: errors, publicYouTubeBroadcastTested: false }, null, 2)); console.log(JSON.stringify({ passed, browserErrors: errors, artifacts }, null, 2));
  } finally {
    await browser?.close(); await streaming?.stop(); if (receiver?.exitCode === null) receiver.kill('SIGKILL');
    if (server) await new Promise(r => { server.closeAllConnections(); server.close(r); }); await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
