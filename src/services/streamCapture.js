const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { StreamError } = require('./streamEncoder');

function browserPath() {
  const candidates = [process.env.BAMBUBOARD_CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', chromium.executablePath()];
  return candidates.find(file => file && fs.existsSync(file)) || null;
}
// A fresh browser renders only the local published /live scene. It never uses
// the maintainer's desktop profile, cookies or an arbitrary request-supplied URL.
async function captureScene({ origin, profile, signal, onFrame, onWarning, onFailure }) {
  const executablePath = browserPath();
  if (!executablePath) throw new StreamError('BROWSER_MISSING', 'Server capture needs Chromium. Use a Docker image containing Chromium or set BAMBUBOARD_CHROMIUM_BIN.');
  let browser, stopped = false, timer;
  const stop = async () => {
    stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
  };
  const onAbort = () => { void stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20000,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
    if (signal?.aborted) { await stop(); throw new StreamError('CANCELLED', 'Stream start cancelled.'); }
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1, colorScheme: 'dark' });
    const page = await context.newPage();
    page.on('pageerror', () => onWarning?.('A scene widget reported a browser error. Inspect the published /live scene.'));
    browser.on('disconnected', () => { if (!stopped) onFailure?.(new StreamError('CAPTURE_BROWSER', 'The server capture browser closed unexpectedly.', true)); });
    await page.goto(`${origin}/live`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (new URL(page.url()).pathname !== '/live') throw new StreamError('SETUP_INCOMPLETE', 'Complete printer Setup and check the published /live scene before streaming.');
    await page.waitForSelector('.live-item', { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    const tick = async () => {
      if (stopped || signal?.aborted) return;
      const start = Date.now();
      try { onFrame(await page.screenshot({ type: 'jpeg', quality: 75, timeout: 10000 })); }
      catch (_) { if (!stopped && !signal?.aborted) onFailure?.(new StreamError('CAPTURE_BROWSER', 'The server could not capture the published scene.', true)); return; }
      if (!stopped) timer = setTimeout(tick, Math.max(0, 1000 / Math.min(30, profile.fps) - (Date.now() - start)));
    };
    void tick();
    return { stop };
  } catch (error) {
    await stop();
    throw error instanceof StreamError ? error : new StreamError('CAPTURE_BROWSER', 'Server capture could not start. Check Chromium installation and server resources.');
  }
}
module.exports = { browserPath, captureScene };
