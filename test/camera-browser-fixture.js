const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const express = require('express');
const { buildVideoRouter } = require('../src/routes/video');
const { listen, until } = require('./helpers');

function cameraSample(color) {
  return execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=320x180:r=30`,
    '-t', '0.8', '-c:v', 'mpeg1video', '-f', 'mpegts', 'pipe:1'], { timeout: 10000 });
}

async function checkCameraRecovery(browser, artifactDir) {
  const red = cameraSample('red'), blue = cameraSample('blue');
  const cleanup = [], t = { after: fn => cleanup.push(fn) };
  const app = express(), children = [];
  const printer = { type: 'H2D', url: '127.0.0.1', accessCode: 'fixture-only' };
  const mounted = buildVideoRouter({ app, getConfig: () => ({ printer }), getCameraTelemetry: () => ({ rtsp_url: 'enable' }),
    relayOptions: {
      spawn() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
        child.kills = [];
        child.kill = signal => {
          child.kills.push(signal);
          queueMicrotask(() => child.emit('close', null, signal));
          return true;
        };
        child.video = sample => {
          child.stdout.write(sample);
          child.stdio[3].write('frame=24\nprogress=continue\n');
        };
        children.push(child);
        return child;
      },
      timing: { firstFrameMs: 2500, frameGapMs: 1800, backoffMs: 800, maxBackoffMs: 1500, killGraceMs: 100, graceMs: 100 },
    } });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const base = await listen(t, app);
  const status = () => fetch(base + '/api/printer/video/status').then(res => res.json());
  const context = await browser.newContext({ viewport: { width: 420, height: 240 } });
  const page = await context.newPage();
  const errors = [], external = [], sockets = [], frames = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(base)) external.push(request.url()); });
  page.on('websocket', socket => {
    assert.equal(socket.url(), base.replace('http:', 'ws:') + '/api/printer/video');
    sockets.push(socket);
    socket.on('framereceived', event => frames.push(event.payload));
  });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...options) {
      // Read actual decoded pixels from JSMpeg's supported Canvas2D renderer.
      if (type.toLowerCase().includes('webgl')) return null;
      return getContext.call(this, type, ...options);
    };
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 5000 ? 100 : delay, ...args);
  });
  const paint = channel => page.waitForFunction(channel => {
    const canvas = document.getElementById('camCanvas');
    const pixel = canvas?.getContext('2d')?.getImageData(80, 80, 1, 1).data;
    return pixel?.[channel] > 180 && pixel[(channel + 2) % 4] < 35;
  }, channel);
  try {
    await page.goto(base + '/widgets/camera/');
    await until(() => frames.length === 1 && children.length === 1);
    assert.equal(frames[0].length, 8, 'A header by itself has no video frame');
    assert.notEqual((await status()).state, 'streaming');
    assert.equal(await page.locator('#camOverlay').isVisible(), true);
    await until(() => children[0].kills.length === 1);
    assert.deepEqual(children[0].kills, ['SIGTERM']);
    await page.locator('#camMsg').filter({ hasText: /reconnecting/i }).waitFor({ state: 'visible' });
    await until(() => children.length === 2);
    children[1].video(red);
    assert.equal((await status()).state, 'streaming');
    await paint(0);
    await page.locator('#camOverlay').waitFor({ state: 'hidden' });
    assert.equal((await status()).state, 'streaming');

    // Stop emitting frames without closing the child or socket. The same
    // browser connection must recover and paint a different decoded image.
    await until(() => children[1].kills.length === 1);
    assert.deepEqual(children[1].kills, ['SIGTERM']);
    await page.locator('#camMsg').filter({ hasText: /reconnecting/i }).waitFor({ state: 'visible' });
    assert.notEqual((await status()).state, 'streaming');
    if (artifactDir) await page.screenshot({ path: path.join(artifactDir, 'camera-reconnecting.png') });
    await until(() => children.length === 3);
    children[2].video(blue);
    assert.equal((await status()).state, 'streaming');
    await paint(2);
    await page.locator('#camOverlay').waitFor({ state: 'hidden' });
    assert.equal((await status()).state, 'streaming');
    assert.equal(sockets.length, 1, 'The existing viewer reconnects to video on the original WebSocket');
    assert.equal(sockets[0].isClosed(), false);
    assert.equal(frames.filter(frame => frame.length === 8).length, 1, 'The JSMpeg header is sent once per viewer');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    if (artifactDir) await page.screenshot({ path: path.join(artifactDir, 'camera-recovered.png') });
  } finally {
    await context.close();
    await mounted?.stop?.();
    for (const fn of cleanup.reverse()) await fn();
  }
}

module.exports = { checkCameraRecovery };

if (require.main === module) {
  const { chromium } = require('playwright');
  (async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE });
    try { await checkCameraRecovery(browser); console.log('Camera browser passed: first frame and stalled camera recover on one WebSocket.'); }
    finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
