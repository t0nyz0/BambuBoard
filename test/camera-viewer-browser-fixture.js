const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const express = require('express');
const { buildVideoRouter } = require('../src/routes/video');
const { listen, until } = require('./helpers');

function videoSample(color) {
  return execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=160x120:r=30`,
    '-frames:v', '2', '-g', '1', '-c:v', 'mpeg1video', '-f', 'mpegts', 'pipe:1'], { timeout: 10000 });
}

function installViewerFixture({ dropAll, clockRate }) {
  const now = performance.now.bind(performance);
  performance.now = () => now() * clockRate;
  for (const name of ['setTimeout', 'setInterval']) {
    const schedule = window[name].bind(window);
    window[name] = (callback, delay, ...args) => schedule(callback, delay >= 500 ? delay / clockRate : delay, ...args);
  }

  // Observe the decoded frame without replacing the decoder or the socket.
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...options) {
    if (type.toLowerCase().includes('webgl')) return null;
    return getContext.call(this, type, ...options);
  };
  const fixture = window.cameraFixture = { dropAll, drop: new Set(), hidden: false, hangStatus: false, hung: 0, sockets: [] };
  Object.defineProperty(document, 'hidden', { get: () => fixture.hidden });
  Object.defineProperty(document, 'visibilityState', { get: () => fixture.hidden ? 'hidden' : 'visible' });

  const fetchNormally = window.fetch.bind(window);
  window.fetch = (url, options) => {
    if (fixture.hangStatus && url === '/api/printer/video/status') {
      fixture.hung++;
      // Deliberately never settles, even if the AbortSignal is fired.
      return new Promise(() => {});
    }
    return fetchNormally(url, options);
  };

  window.WebSocket = class extends WebSocket {
    constructor(...args) {
      super(...args);
      if (new URL(this.url).pathname !== '/api/printer/video') return;
      const index = fixture.sockets.length;
      const record = { socket: this, openedAt: performance.now(), headers: 0, dropped: 0 };
      fixture.sockets.push(record);
      this.addEventListener('message', event => {
        const length = event.data.byteLength ?? event.data.size;
        if (length === 8) record.headers++;
        if (length > 8 && (fixture.dropAll || fixture.drop.has(index))) {
          record.dropped++;
          event.stopImmediatePropagation();
        }
      });
    }
  };
}

function detectsColor(page, channel) {
  return page.waitForFunction(channel => {
    const canvas = document.getElementById('camCanvas');
    const pixel = canvas?.getContext('2d')?.getImageData(80, 80, 1, 1).data;
    return pixel?.[channel] > 180 && [0, 1, 2].every(index => index === channel || pixel[index] < 35);
  }, channel, { timeout: 6000 });
}

async function checkIndividualCameraRecovery(browser, artifactDir) {
  let sample = videoSample('red');
  const blue = videoSample('blue'), green = videoSample('lime');
  const cleanup = [], t = { after: fn => cleanup.push(fn) };
  const app = express(), children = [];
  const printer = { type: 'H2D', url: '127.0.0.1', accessCode: 'fixture-only' };
  const relay = buildVideoRouter({ app, getConfig: () => ({ printer }), getCameraTelemetry: () => ({ rtsp_url: 'enable' }),
    relayOptions: { spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
      child.kills = [];
      child.frames = 0;
      child.kill = signal => {
        child.kills.push(signal);
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      children.push(child);
      return child;
    } } });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const base = await listen(t, app);
  const status = () => fetch(base + '/api/printer/video/status').then(res => res.json());
  const context = await browser.newContext({ viewport: { width: 420, height: 240 } });
  const errors = [], external = [];
  const retryClockRate = 8;
  let feed;

  async function open(dropAll = false, clockRate = retryClockRate) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(base)) external.push(request.url()); });
    await page.addInitScript(installViewerFixture, { dropAll, clockRate });
    await page.goto(base + '/widgets/camera/');
    return page;
  }
  const count = page => page.evaluate(() => window.cameraFixture.sockets.length);
  const overlay = page => page.locator('#camOverlay');
  const waitUntilTime = (page, deadline) => page.waitForFunction(deadline => performance.now() >= deadline,
    // The page clock and its timers advance at the same rate.
    deadline, { timeout: 6000 });

  try {
    // Keep the healthy viewer on its real deadline. Only accelerate the
    // deliberate failure cases, and pace the fixture for software decoders.
    const [healthy, stale] = await Promise.all([open(false, 1), open()]);
    await until(() => children.length === 1);
    const child = children[0];
    feed = setInterval(() => {
      child.stdout.write(sample);
      child.frames += 2;
      child.stdio[3].write(`frame=${child.frames}\nprogress=continue\n`);
    }, 240);
    await Promise.all([detectsColor(healthy, 0), detectsColor(stale, 0)]);
    await Promise.all([overlay(healthy).waitFor({ state: 'hidden' }), overlay(stale).waitFor({ state: 'hidden' })]);
    assert.equal((await status()).state, 'streaming');

    await stale.evaluate(() => { window.cameraFixture.hangStatus = true; });
    await stale.waitForFunction(() => window.cameraFixture.hung > 0, null, { timeout: 6000 });
    await stale.evaluate(() => {
      window.cameraFixture.drop.add(0);
      // Briefly hold the replacement's first frames so the reconnect state
      // can be verified before playback resumes.
      window.cameraFixture.drop.add(1);
    });
    await stale.waitForFunction(() => {
      const first = window.cameraFixture.sockets[0];
      return first.dropped > 0 && first.socket.readyState === WebSocket.OPEN;
    }, null, { timeout: 6000 });
    await detectsColor(stale, 0);
    sample = blue;
    await detectsColor(healthy, 2);
    assert.equal(await count(healthy), 1);
    assert.equal((await status()).state, 'streaming');

    await stale.waitForFunction(() => window.cameraFixture.sockets.length === 2, null, { timeout: 4500 });
    await overlay(stale).waitFor({ state: 'visible' });
    assert.match(await stale.locator('#camMsg').textContent(), /connect|waiting for video/i);
    await stale.evaluate(() => window.cameraFixture.drop.delete(1));
    await detectsColor(stale, 2);
    await overlay(stale).waitFor({ state: 'hidden' });
    await stale.waitForFunction(() => window.cameraFixture.sockets[0].socket.readyState === WebSocket.CLOSED);
    assert.equal(await count(healthy), 1, 'Recovering the stale viewer must leave the healthy viewer alone');
    assert.equal((await status()).state, 'streaming');
    assert.equal(children.length, 1, 'The shared child must never be restarted by local recovery');
    assert.deepEqual(child.kills, []);
    if (artifactDir) await stale.screenshot({ path: path.join(artifactDir, 'camera-viewer-recovered.png') });

    const hiddenAt = await stale.evaluate(() => {
      const fixture = window.cameraFixture;
      fixture.hidden = true;
      fixture.dropAll = true;
      document.dispatchEvent(new Event('visibilitychange'));
      return performance.now();
    });
    await waitUntilTime(stale, hiddenAt + 29000);
    assert.equal(await count(stale), 2, 'A hidden viewer must not reconnect while decoding is suspended');
    const resumedAt = await stale.evaluate(() => {
      window.cameraFixture.hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      return performance.now();
    });
    await waitUntilTime(stale, resumedAt + 2500);
    assert.equal(await count(stale), 2, 'A resumed viewer gets a grace period to decode');
    await stale.evaluate(() => { window.cameraFixture.dropAll = false; });
    sample = green;
    await Promise.all([detectsColor(stale, 1), detectsColor(healthy, 1)]);
    assert.equal(await count(stale), 2);

    const cold = await open(true);
    await cold.waitForFunction(() => {
      const first = window.cameraFixture.sockets[0];
      return first?.headers === 1 && first.dropped > 0 && first.socket.readyState === WebSocket.OPEN;
    }, null, { timeout: 6000 });
    await overlay(cold).waitFor({ state: 'visible' });
    await cold.waitForFunction(() => window.cameraFixture.sockets.length >= 5, null, { timeout: 32000 });
    const opened = await cold.evaluate(() => window.cameraFixture.sockets.map(socket => socket.openedAt));
    const delays = opened.slice(1).map((stamp, i) => stamp - opened[i]);
    // The first deadline begins before the initial WASM startup and socket
    // creation. Compare the later attempts, when the decoder is already warm.
    const warmDelays = delays.slice(1);
    assert.ok(warmDelays.every(delay => delay >= 23000), `A header-only viewer must wait for each first-frame deadline: ${delays}`);
    assert.ok(warmDelays.at(-1) > warmDelays[0] + 6000, `Sustained failure increases retry delay: ${delays}`);
    assert.equal(await count(healthy), 1);
    assert.equal(await count(stale), 2);
    assert.deepEqual(child.kills, []);
    assert.equal((await status()).state, 'streaming');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    clearInterval(feed);
    await context.close();
    await relay.stop();
    for (const fn of cleanup.reverse()) await fn();
  }
}

module.exports = { checkIndividualCameraRecovery };

if (require.main === module) {
  const { chromium } = require('playwright');
  (async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE });
    try { await checkIndividualCameraRecovery(browser); console.log('Camera viewer browser passed: independent stale recovery, hung status, visibility grace, and bounded first-frame retry.'); }
    finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
