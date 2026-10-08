// Full widget -> HTTP -> implicit FTPS -> ZIP -> WebGL and recovery controls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');
const { archive, ftpsFixture } = require('./ftps-fixture');
const { temporary, listen, until } = require('./helpers');
const { fetchPlateGcode } = require('../src/services/printerFiles');
const { buildGcodeRouter } = require('../src/routes/gcode');
const root = path.resolve(__dirname, '..');
const sample = 'G90\nM83\nG1 X10 Y10 Z0.2 E1\nG1 X70 Y10 E1\nG1 X70 Y70 E1\nG1 X10 Y70 E1\nG1 X10 Y10 E1\nG1 Z0.4\nG1 X70 Y10 E1\nG1 X70 Y70 E1\n';
(async () => {
  const cleanup = [], t = { after: fn => cleanup.push(fn) };
  const data = await temporary(t), artifacts = process.env.BB_SCREENSHOTS || await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-gcode-browser-'));
  await fs.mkdir(artifacts, { recursive: true });
  const files = {}, ftp = await ftpsFixture(t, { files });
  const app = express(), passed = [], errors = [], external = new Set();
  let clock = Date.now(), mode = 'normal', count = 0, releaseSlow = null, telemetryBroken = false, telemetryStale = false;
  let print;
  const write = async (name, state = 'RUNNING', overrides = {}) => {
    print = { _bb_job_id: name, task_id: '0', subtask_id: '0', subtask_name: name, gcode_file: '/data/Metadata/plate_1.gcode', gcode_state: state, layer_num: 1, mc_percent: 47, mc_remaining_time: 20, stg_cur: 0, ams: { ams: [] }, ...overrides };
    const temp = path.join(data, 'data.json.tmp'); await fs.writeFile(temp, JSON.stringify({ print })); await fs.rename(temp, path.join(data, 'data.json'));
  };
  const routes = buildGcodeRouter({ paths: { data }, getConfig: () => ({ printer: { url: '127.0.0.1', type: 'H2D', accessCode: 'fixture-only', serialNumber: 'FIXTURE' } }), log: () => {}, now: () => clock,
    fetchGcode: async options => {
      count++;
      if (options.job.name === 'Slow job') return new Promise(resolve => { releaseSlow = () => resolve(Buffer.from(sample)); });
      if (mode === 'oversize') return Buffer.alloc(25 * 1024 * 1024, 'G');
      if (mode === 'unprintable') return Buffer.from('G90\nG1 X10 Y10 Z0.2\n');
      return fetchPlateGcode({ ...options, port: ftp.port });
    } });
  app.get('/data.json', (_req, res) => telemetryBroken ? res.status(503).json({ error: 'fixture failure' }) : res.json({ print, _bb_received_at: Date.now() - (telemetryStale ? 65000 : 0) }));
  app.get('/api/status', (_req, res) => res.json({ printer: { type: 'H2D' } }));
  app.use('/api/gcode', routes.router);
  app.use(express.static(path.join(root, 'public')));
  const base = await listen(t, app);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 640, height: 640 }, acceptDownloads: true });
    await context.addInitScript(() => { window.__timeOffset = 0; const original = Date.now; Date.now = () => original() + window.__timeOffset; });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', req => { if (!req.url().startsWith(base) && !req.url().startsWith('blob:') && !req.url().startsWith('data:')) external.add(req.url()); });
    const page = await context.newPage();
    const open = () => page.goto(base + '/widgets/gcode-viz/?debug=1');
    const rendered = async () => {
      await page.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')));
      assert.ok(await page.evaluate(() => window.__preview.layers.length > 0 && window.__preview.renderer.info.render.calls > 0));
    };
    await write('Root job'); files['/Root job.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    await open(); await rendered(); assert.equal(count, 1);
    await page.screenshot({ path: path.join(artifacts, 'gcode-rendered.png') });
    passed.push('Real HTTP/FTPS/ZIP/WebGL path renders a zero-ID LAN job');

    await write('Missing file'); await open();
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('cannot expose'));
    const atFailure = count;
    await page.waitForTimeout(1800); assert.equal(count, atFailure, 'No 800ms download loop');
    for (let attempt = 2; attempt <= 5; attempt++) {
      clock += 300000;
      await page.evaluate(() => { window.__timeOffset += 300000; });
      await page.waitForFunction(attempt => window.__log?.().some(line => line.includes(`attempt=${attempt} `)), attempt);
      await page.waitForFunction(attempt => window.__log?.().some(line => line.includes(`attempts=${attempt} retryable=true`)), attempt);
    }
    assert.equal(count, atFailure + 4);
    clock += 300000; await page.evaluate(() => { window.__timeOffset += 300000; });
    await page.waitForTimeout(1000); assert.equal(count, atFailure + 4);
    assert.ok(!(await page.locator('#gcodeOverlay').innerText()).includes('Retrying in'));
    await page.setViewportSize({ width: 320, height: 300 });
    const rects = await page.evaluate(() => {
      const message = document.getElementById('gcodeOverlay').getBoundingClientRect();
      const tools = document.getElementById('gcodeRecovery').getBoundingClientRect();
      return { messageBottom: message.bottom, toolsTop: tools.top, toolsBottom: tools.bottom, width: document.documentElement.scrollWidth };
    });
    assert.ok(rects.messageBottom <= rects.toolsTop && rects.toolsBottom <= 300 && rects.width <= 320, JSON.stringify(rects));
    // Capture the transparent widget over a dark surface, as in the app/OBS.
    await page.evaluate(() => document.documentElement.style.setProperty('background', '#0c1116', 'important'));
    await page.screenshot({ path: path.join(artifacts, 'gcode-error-compact.png') });
    await page.evaluate(() => document.documentElement.style.removeProperty('background'));
    await page.setViewportSize({ width: 640, height: 640 });
    passed.push('Missing-file retries back off, stop at five, and error controls fit a compact widget');

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#gcodeDownloadLog').click()]);
    const reportPath = path.join(artifacts, 'gcode-diagnostics.json'); await download.saveAs(reportPath);
    const diagnostic = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(diagnostic.server.error.code, 'FILE_NOT_FOUND'); assert.ok(diagnostic.server.events.some(e => e.stage === 'list'));
    assert.ok(diagnostic.widget.some(line => line.includes('loadGcode HTTP 502')));
    assert.ok(!JSON.stringify(diagnostic).includes('fixture-only'));
    const countBeforeRetry = count;
    await page.locator('#gcodeRetry').click(); await until(() => count === countBeforeRetry + 1);
    await page.waitForFunction(() => document.getElementById('gcodeRecovery').hidden === false);
    await page.locator('#gcodeFile').setInputFiles({ name: 'exact-sliced-plate.gcode.3mf', mimeType: 'application/octet-stream', buffer: archive({ 'Metadata/plate_1.gcode': sample }) });
    await rendered();
    assert.equal(await page.locator('#gcodeRecovery').isVisible(), false);
    assert.equal((await fetch(base + '/api/gcode/current')).status, 200);
    passed.push('Diagnostics export, manual Retry now, and exact sliced-file recovery work');

    await page.evaluate(() => { window.__timeOffset = 7200000; });
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#gcodeOverlay').isVisible(), false, 'Viewer clock skew must not make fresh NAS telemetry stale');
    await page.evaluate(() => { window.__timeOffset = 0; });
    telemetryBroken = true;
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('telemetry is unavailable'));
    assert.equal(await page.evaluate(() => window.__nozzle.visible), false, 'Do not simulate nozzle motion with missing telemetry');
    assert.ok(await page.evaluate(() => window.__preview.layers.length > 0), 'The loaded model remains available');
    telemetryBroken = false;
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').style.display === 'none');
    telemetryStale = true;
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('stopped updating'));
    assert.equal(await page.evaluate(() => window.__nozzle.visible), false);
    telemetryStale = false;
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').style.display === 'none');
    passed.push('Unavailable/stale telemetry pauses and recovers; viewer clock skew does not discard a valid preview');

    await write('Slow job'); await open(); await until(() => releaseSlow);
    await write('Next job'); files['/Next job.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    await rendered(); const loaded = count; releaseSlow(); releaseSlow = null;
    await page.waitForTimeout(1000); assert.equal(count, loaded);
    assert.equal(await page.locator('#gcodeOverlay').isVisible(), false);
    assert.equal((await fs.readdir(path.join(data, 'gcode-cache'))).length, 3);
    passed.push('A new print renders while its obsolete download is still pending');

    const rectangle = (x1, y1, x2, y2, layers) => {
      const lines = ['G90', 'M83', 'G1 F6000'];
      for (let layer = 1; layer <= layers; layer++) lines.push(`G1 X${x1} Y${y1} Z${(layer * 0.2).toFixed(1)}`, `G1 X${x2} Y${y1} E1`, `G1 X${x2} Y${y2} E1`, `G1 X${x1} Y${y2} E1`, `G1 X${x1} Y${y1} E1`);
      return lines.join('\n') + '\n';
    };
    const framing = [];
    for (const [name, toolpath, state, overrides] of [
      ['Long narrow', rectangle(10, 160, 330, 166, 3), 'FINISH', { layer_num: 2, total_layer_num: 2, mc_percent: 100, mc_remaining_time: 0, stg_cur: -1 }],
      ['Tall model', rectangle(100, 100, 140, 140, 1500), 'RUNNING', { layer_num: 1500, total_layer_num: 1500 }]
    ]) {
      files[`/${name}.gcode.3mf`] = archive({ 'Metadata/plate_1.gcode': toolpath });
      await write(name, state, overrides); await open(); await rendered();
      await page.waitForFunction(() => window.__preview.endLayer === window.__preview.layers.length);
      if (state === 'FINISH') assert.equal(await page.evaluate(() => window.__nozzle.visible), false);
      for (const viewport of [{ width: 640, height: 640 }, { width: 320, height: 640 }, { width: 1000, height: 240 }]) {
        await page.setViewportSize(viewport);
        await page.waitForFunction(aspect => Math.abs(window.__preview.camera.aspect - aspect) < 0.001, viewport.width / viewport.height);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const bounds = await page.evaluate(async () => {
          const { Vector3 } = await import('/vendor/three.module.js'), preview = window.__preview;
          preview.scene.updateMatrixWorld(true);
          let vertices = 0, maxX = 0, maxY = 0, minZ = Infinity, maxZ = -Infinity;
          preview.scene.traverse(object => {
            const position = object.geometry?.getAttribute('position');
            if (!object.material?.isLineBasicMaterial || !position || object.geometry.getAttribute('color')) return;
            for (let i = 0; i < position.count; i++) {
              const point = new Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).project(preview.camera);
              vertices++; maxX = Math.max(maxX, Math.abs(point.x)); maxY = Math.max(maxY, Math.abs(point.y)); minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
            }
          });
          return { vertices, maxX, maxY, minZ, maxZ, layers: preview.layers.length, renderedLayers: preview.endLayer };
        });
        assert.ok(bounds.vertices > 0 && bounds.maxX < 0.93 && bounds.maxY < 0.93 && bounds.minZ > -1 && bounds.maxZ < 1, JSON.stringify({ name, viewport, bounds }));
        framing.push({ name, viewport, bounds });
      }
    }
    await fs.writeFile(path.join(artifacts, 'gcode-framing-results.json'), JSON.stringify(framing, null, 2));
    await page.setViewportSize({ width: 640, height: 640 });
    passed.push('Long/narrow and 300mm tall models fit square, portrait and wide canvases; FINISH stage -1 shows every parsed layer');

    mode = 'oversize'; await write('Large job'); await open();
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('24 MiB'));
    let before = count; await page.waitForTimeout(1000); assert.equal(count, before);
    mode = 'unprintable'; await write('No extrusion'); await open();
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('no printable extrusion'));
    before = count; await page.waitForTimeout(1000); assert.equal(count, before);
    passed.push('Oversized and unprintable files fail visibly without automatic reload loops');

    mode = 'normal'; await write('Context job'); files['/Context job.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    await open(); await rendered();
    await page.evaluate(() => window.__preview.renderer.forceContextLoss());
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('WebGL 2'));
    await page.locator('#gcodeRetry').click(); await rendered();
    passed.push('GPU context loss displays recovery instructions and Retry now restores rendering');

    const disabled = await browser.newContext({ viewport: { width: 640, height: 640 } });
    await disabled.addInitScript(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...args) { return /webgl/.test(type) ? null : get.call(this, type, ...args); }; });
    const noWebGL = await disabled.newPage();
    await noWebGL.goto(base + '/widgets/gcode-viz/');
    await noWebGL.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('WebGL 2'));
    assert.equal(await noWebGL.locator('#gcodeDownloadLog').isVisible(), true);
    await noWebGL.screenshot({ path: path.join(artifacts, 'gcode-no-webgl.png') });
    await disabled.close();
    passed.push('Renderer initialization failure has a usable diagnostic/export UI');
    assert.deepEqual(errors, []); assert.deepEqual([...external], []);
    await fs.writeFile(path.join(artifacts, 'gcode-browser-results.json'), JSON.stringify({ passed, errors, external: [...external], source: 'Loopback FTPS and sample toolpath; no physical printer', downloads: count }, null, 2));
    console.log(`Gcode browser passed: ${passed.length} end-to-end recovery groups; no JavaScript errors or external requests. Artifacts: ${artifacts}`);
  } finally {
    releaseSlow?.(); await browser?.close(); await routes.stop();
    for (const fn of cleanup.reverse()) await fn();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
