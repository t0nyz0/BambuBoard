const assert = require('node:assert/strict');
const { ffmpeg } = require('../src/lib/ffmpeg');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const express = require('express');
const { buildVideoRouter } = require('../src/routes/video');
const { listen, until } = require('./helpers');

function cameraSample(color, size = '320x180') {
  return execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=${size}:r=30`,
    '-t', '0.8', '-c:v', 'mpeg1video', '-f', 'mpegts', 'pipe:1'], { timeout: 10000 });
}

async function checkCameraRecovery(browser, artifactDir) {
  const red = cameraSample('red'), blue = cameraSample('blue'), green = cameraSample('lime', '160x120');
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
        let frames = 0;
        child.video = sample => {
          child.stdout.write(sample);
          frames += 24;
          child.stdio[3].write(`frame=${frames}\nprogress=continue\n`);
        };
        children.push(child);
        return child;
      },
      timing: { firstFrameMs: 2500, frameGapMs: 1800, backoffMs: 800, maxBackoffMs: 1500, retriesBeforeUnavailable: 5, killGraceMs: 100, graceMs: 100 },
    } });
  const root = path.resolve(__dirname, '..');
  const camera = { id: 'ffmpeg_source', name: 'Fixture camera', settings: { width: 420, height: 240 } };
  const scene = { id: 'scene', name: 'Fixture live output', settings: { items: [{ id: 1, name: camera.name, pos: { x: 0, y: 0 }, align: 5 }] } };
  app.get('/live', (_req, res) => res.sendFile(path.join(root, 'views/live.html')));
  app.get('/api/obs/active', (_req, res) => res.json({ slug: 'camera-fixture', updatedAt: 1 }));
  app.get('/api/obs/published', (_req, res) => res.json({ resolution: { x: 420, y: 240 }, sources: [camera, scene] }));
  app.use(express.static(path.join(root, 'public')));
  const base = await listen(t, app);
  const status = () => fetch(base + '/api/printer/video/status').then(res => res.json());
  const context = await browser.newContext({ viewport: { width: 420, height: 240 } });
  const errors = [], external = [];
  async function viewer() {
    const page = await context.newPage();
    const sockets = [], frames = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(base)) external.push(request.url()); });
    page.on('websocket', socket => {
      assert.equal(socket.url(), base.replace('http:', 'ws:') + '/api/printer/video?formatReset=1');
      sockets.push(socket);
      socket.on('framereceived', event => frames.push(event.payload));
    });
    return { page, sockets, frames };
  }
  await context.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...options) {
      // Read actual decoded pixels from JSMpeg's supported Canvas2D renderer.
      if (type.toLowerCase().includes('webgl')) return null;
      return getContext.call(this, type, ...options);
    };
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 5000 ? 100 : delay, ...args);
  });
  const paint = (view, channel) => view.waitForFunction(channel => {
    const canvas = document.getElementById('camCanvas');
    const pixel = canvas?.getContext('2d')?.getImageData(80, 80, 1, 1).data;
    return pixel?.[channel] > 180 && [0, 1, 2].every(index => index === channel || pixel[index] < 35);
  }, channel);
  let feed;
  try {
    const [direct, live] = await Promise.all([viewer(), viewer()]);
    await Promise.all([direct.page.goto(base + '/widgets/camera/'), live.page.goto(base + '/live')]);
    const cameraFrame = await live.page.locator('iframe[title="Live camera"]').elementHandle();
    const activeView = await cameraFrame.contentFrame();
    const views = [direct.page, activeView];
    const viewers = [direct, live];
    const overlay = (state) => Promise.all(views.map(view => view.locator('#camOverlay').waitFor({ state })));
    const reconnecting = () => Promise.all(views.map(view => view.locator('#camMsg').filter({ hasText: /reconnecting/i }).waitFor({ state: 'visible' })));
    const screenshots = async label => {
      if (!artifactDir) return;
      await direct.page.screenshot({ path: path.join(artifactDir, `camera-${label}.png`) });
      await live.page.screenshot({ path: path.join(artifactDir, `live-camera-${label}.png`) });
    };
    await until(() => viewers.every(viewer => viewer.frames.length === 1) && children.length === 1);
    for (const { frames } of viewers) assert.equal(frames[0].length, 8, 'A header by itself has no video frame');
    assert.notEqual((await status()).state, 'streaming');
    await overlay('visible');
    await until(() => children[0].kills.length === 1);
    assert.deepEqual(children[0].kills, ['SIGTERM']);
    await reconnecting();
    await until(() => children.length === 2);
    children[1].video(red);
    assert.equal((await status()).state, 'streaming');
    await Promise.all(views.map(view => paint(view, 0)));
    await overlay('hidden');
    assert.equal((await status()).state, 'streaming');

    // Stop emitting frames without closing the child or socket. The same
    // browser connection must recover and paint a different decoded image.
    await until(() => children[1].kills.length === 1);
    assert.deepEqual(children[1].kills, ['SIGTERM']);
    await reconnecting();
    assert.notEqual((await status()).state, 'streaming');
    await screenshots('reconnecting');
    await until(() => children.length === 3);
    children[2].video(blue);
    assert.equal((await status()).state, 'streaming');
    await Promise.all(views.map(view => paint(view, 2)));
    await overlay('hidden');
    assert.equal((await status()).state, 'streaming');
    for (const { sockets, frames } of viewers) {
      assert.equal(sockets.length, 1, 'The existing viewer reconnects to video on the original WebSocket');
      assert.equal(sockets[0].isClosed(), false);
      assert.equal(frames.filter(frame => frame.length === 8).length, 1, 'The JSMpeg header is sent once per viewer');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await screenshots('recovered');

    // A camera restart can also change its resolution. The new decoder must
    // replace the old 320×180 canvas allocation instead of leaving old pixels.
    await until(() => children[2].kills.length === 1);
    await reconnecting();
    await until(() => children.length === 4);
    const replacement = children[3];
    replacement.video(green);
    feed = setInterval(() => replacement.video(green), 150);
    await Promise.all(views.map(view => view.waitForFunction(() => {
      const canvas = document.getElementById('camCanvas');
      return canvas.width === 160 && canvas.height === 120;
    })));
    await Promise.all(views.map(view => paint(view, 1)));
    await overlay('hidden');
    for (const view of views) {
      const stale = await view.evaluate(() => Array.from(document.getElementById('camCanvas').getContext('2d').getImageData(230, 140, 1, 1).data));
      assert.deepEqual(stale, [0, 0, 0, 0], 'The region outside the replacement video contains no old pixels');
    }
    for (const { sockets } of viewers) {
      assert.equal(sockets.length, 2, 'A size change initializes one fresh decoder per viewer');
      assert.equal(sockets[0].isClosed(), true);
      assert.equal(sockets[1].isClosed(), false);
    }
    assert.deepEqual((await status()).format, { width: 160, height: 120 });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await screenshots('resized');
  } finally {
    clearInterval(feed);
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
    try { await checkCameraRecovery(browser); console.log('Camera browser passed: standalone and /live viewers keep their sockets after same-size recovery and replace stale pixels after a resolution change.'); }
    finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
