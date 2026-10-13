// Exercise the shipped Chromium and real widget, including the software GPU.
// Desktop Playwright checks cannot detect missing Alpine renderer libraries.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright-core');
const { browserPath } = require('../src/services/streamCapture');

(async () => {
  const app = express();
  const print = { _bb_job_id: 'native-renderer-fixture', subtask_name: 'Native preview',
    gcode_file: '/data/Metadata/plate_1.gcode', gcode_state: 'FINISH', layer_num: 2,
    mc_percent: 100, stg_cur: -1, ams: { ams: [] } };
  app.get('/data.json', (_req, res) => res.json({ print, _bb_received_at: Date.now() }));
  app.get('/api/status', (_req, res) => res.json({ printer: { type: 'H2D' } }));
  app.get('/settings', (_req, res) => res.json({}));
  app.get('/api/gcode/current', (_req, res) => res.type('text/plain').send(
    'G90\nM83\nG1 X10 Y10 Z0.2 E1\nG1 X70 Y10 E1\nG1 X70 Y70 E1\nG1 X10 Y70 E1\nG1 Z0.4\nG1 X10 Y10 E1\n'));
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 320, height: 300 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/widgets/gcode-viz/?debug=1`);
    await page.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')) || window.BBGcodeUI?.log.length, null, { timeout: 20000 });
    const result = await page.evaluate(() => ({
      rendererErrors: window.BBGcodeUI.log,
      loaded: !!window.__log?.().some(line => line.includes('loadGcode OK')),
      layers: window.__preview?.layers.length,
      renderedLayers: window.__preview?.endLayer,
      draws: window.__preview?.renderer.info.render.calls,
      busy: document.querySelector('.gcode-stage').getAttribute('aria-busy'),
    }));
    assert.deepEqual(result.rendererErrors, [], 'Shipped Chromium cannot create a WebGL preview');
    assert.equal(result.loaded, true, JSON.stringify(result));
    assert.ok(result.layers > 0 && result.draws > 0, JSON.stringify(result));
    assert.equal(result.renderedLayers, result.layers);
    assert.equal(result.busy, 'false');
    assert.deepEqual(errors, []);
    console.log('Native container WebGL toolpath preview passed:', JSON.stringify(result));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
