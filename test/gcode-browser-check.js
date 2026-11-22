// Full widget -> HTTP -> implicit FTPS -> ZIP -> WebGL and recovery controls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');
const { archive, ftpsFixture } = require('./ftps-fixture');
const { temporary, listen, until } = require('./helpers');
const { fetchPlateGcode, LIMITS } = require('../src/services/printerFiles');
const { buildGcodeRouter } = require('../src/routes/gcode');
const { toolpathMiB, toolpathLines } = require('../public/js/gcode-limits');
const root = path.resolve(__dirname, '..');
const firstLayer = 'G90\nM83\nG1 X10 Y10 Z0.2 E1\nG1 X70 Y10 E1\nG1 X70 Y70 E1\nG1 X10 Y70 E1\nG1 X10 Y10 E1\n';
const lastLayer = 'G1 Z0.4\nG1 X70 Y10 E1\nG1 X70 Y70 E1\n';
const sample = firstLayer + lastLayer;
const mebibyte = 1024 * 1024;
const paddingLine = Buffer.from('; preview fixture padding 0123456789\n');
const paddingLines = Math.ceil((92 * mebibyte - Buffer.byteLength(sample)) / paddingLine.length);
const largeToolpathBytes = Buffer.byteLength(sample) + paddingLines * paddingLine.length;
(async () => {
  const cleanup = [], t = { after: fn => cleanup.push(fn) };
  const data = await temporary(t), artifacts = process.env.BB_SCREENSHOTS || await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-gcode-browser-'));
  await fs.mkdir(artifacts, { recursive: true });
  const files = {}, ftp = await ftpsFixture(t, { files });
  const app = express(), passed = [], errors = [], external = new Set();
  let clock = Date.now(), mode = 'normal', count = 0, releaseSlow = null, telemetryBroken = false, telemetryStale = false;
  let printerConnection = 'online';
  let printerType = 'H2D';
  let print;
  const writePacket = async packet => {
    print = packet;
    const temp = path.join(data, 'data.json.tmp');
    await fs.writeFile(temp, JSON.stringify({ print }));
    await fs.rename(temp, path.join(data, 'data.json'));
  };
  const write = async (name, state = 'RUNNING', overrides = {}) => {
    await writePacket({ _bb_job_id: name, task_id: '0', subtask_id: '0', subtask_name: name, gcode_file: '/data/Metadata/plate_1.gcode', gcode_state: state, layer_num: 1, mc_percent: 47, mc_remaining_time: 20, stg_cur: 0, ams: { ams: [] }, ...overrides });
  };
  const routes = buildGcodeRouter({ paths: { data }, getConfig: () => ({ printer: { url: '127.0.0.1', type: printerType, accessCode: 'fixture-only', serialNumber: 'FIXTURE' } }), log: () => {}, now: () => clock,
    fetchGcode: async options => {
      count++;
      if (options.job.name === 'Slow job') return new Promise(resolve => { releaseSlow = () => resolve(Buffer.from(sample)); });
      if (mode === 'large') {
        const toolpath = Buffer.alloc(largeToolpathBytes);
        const paddingStart = toolpath.write(firstLayer);
        const paddingEnd = paddingStart + paddingLines * paddingLine.length;
        toolpath.fill(paddingLine, paddingStart, paddingEnd);
        toolpath.write(lastLayer, paddingEnd);
        return toolpath;
      }
      if (mode === 'many-lines') return Buffer.from(sample + ';\n'.repeat(toolpathLines + 1));
      if (mode === 'unprintable') return Buffer.from('G90\nG1 X10 Y10 Z0.2\n');
      const limits = mode === 'oversize-archive' ? { ...LIMITS, archive: 10 } : LIMITS;
      return fetchPlateGcode({ ...options, port: ftp.port, limits });
    } });
  app.get('/data.json', (_req, res) => {
    res.set('X-BambuBoard-Printer-Connection', printerConnection);
    if (telemetryBroken) return res.status(503).json({ error: 'fixture failure' });
    res.json({ print, _bb_received_at: Date.now() - (telemetryStale ? 65000 : 0) });
  });
  app.get('/api/status', (_req, res) => res.json({ printer: { type: printerType } }));
  app.get('/toolpath-view-fixture', (_req, res) => res.send('<iframe title="Toolpath test" src="/widgets/gcode-viz/?debug=1&view=front&zoom=125" width="640" height="640"></iframe>'));
  app.get('/api/gcode/current', (_req, res, next) => {
    if (mode !== 'oversize') return next();
    // The viewer should refuse the declared size without reading the body.
    // Keep the response open for cancellation rather than allocating a 250 MiB fixture.
    count++;
    res.set({ 'Content-Type': 'text/plain', 'Content-Length': String(toolpathMiB * mebibyte + 1) });
    res.write(sample);
  });
  app.use('/api/gcode', routes.router);
  app.use(express.static(path.join(root, 'public')));
  const base = await listen(t, app);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 640, height: 640 }, acceptDownloads: true });
    await context.addInitScript(() => {
      window.__timeOffset = 0; const original = Date.now; Date.now = () => original() + window.__timeOffset;
      window.__loadingMessages = [];
      new MutationObserver(() => {
        const overlay = document.getElementById('gcodeOverlay');
        if (overlay?.classList.contains('loading') && window.__loadingMessages.at(-1) !== overlay.textContent) window.__loadingMessages.push(overlay.textContent);
      }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', req => { if (!req.url().startsWith(base) && !req.url().startsWith('blob:') && !req.url().startsWith('data:')) external.add(req.url()); });
    const page = await context.newPage();
    const open = settings => page.goto(base + '/widgets/gcode-viz/?' + new URLSearchParams({ debug: '1', ...settings }));
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
    const manualJob = print;
    const manualReconnectRequests = [];
    const trackReconnectRequest = request => {
      if (new URL(request.url()).pathname === '/api/gcode/current') manualReconnectRequests.push(request.method());
    };
    page.on('request', trackReconnectRequest);
    printerConnection = 'offline';
    await page.getByText('Printer offline', { exact: true }).waitFor();
    await writePacket({ _bb_job_pending: true, gcode_state: 'RUNNING', gcode_file: '/data/Metadata/plate_1.gcode' });
    printerConnection = 'online';
    await page.getByText('Waiting for print details', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__preview.layers.length > 0 && !window.__nozzle.visible);
    await page.locator('#gcodeFile').setInputFiles({ name: 'picker-returned-during-reconnect.gcode', mimeType: 'application/octet-stream', buffer: Buffer.from(sample) });
    await writePacket({ ...manualJob, mc_percent: undefined, layer_num: undefined });
    await page.getByText('Waiting for print progress', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => window.__preview.layers.length > 0 && !window.__nozzle.visible));
    await writePacket(manualJob);
    await page.locator('#gcodeOverlay').waitFor({ state: 'hidden' });
    assert.deepEqual(manualReconnectRequests, [], 'Partial reconnect must not re-fetch the manual preview or send a file chosen during reconnect');
    page.off('request', trackReconnectRequest);
    passed.push('Partial identity and missing progress pause a manually loaded preview until the same job is confirmed');

    await write('Picker old');
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('cannot expose'));
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#gcodeFileButton').click()]);
    const loadedBeforePicker = await page.evaluate(() => window.__log().filter(line => line.includes('loadGcode OK')).length);
    files['/Picker new.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    await write('Picker new');
    await page.waitForFunction(before => window.__log().filter(line => line.includes('loadGcode OK')).length > before, loadedBeforePicker);
    await chooser.setFiles({ name: 'old-job.gcode', mimeType: 'application/octet-stream', buffer: Buffer.from('G90\nM83\nG1 X500 Y500 Z0.2 E1\nG1 X550 Y500 E1\n') });
    await page.waitForFunction(() => window.__log().some(line => line.includes('manual file ignored: print changed')));
    assert.equal(await fetch(base + '/api/gcode/current').then(r => r.text()), sample, 'A stale file picker cannot overwrite the new print');
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').style.display === 'none');
    passed.push('Diagnostics, manual Retry/file recovery work; a stale file picker cannot overwrite a new print');

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
    await write('Picker new', 'FINISH', { mc_percent: 100 });
    telemetryStale = true;
    await page.waitForFunction(() => window.__log().some(line => line.includes('finished (showing full model)')));
    assert.equal(await page.locator('#gcodeOverlay').isVisible(), false, 'A quiet printer still shows its finished job within one refresh interval');
    telemetryStale = false;
    await write('Picker new', 'RUNNING');
    await page.waitForFunction(() => window.__log().some(line => line.includes('lifecycle: NEW PRINT (justStarted)')));
    await page.locator('#gcodeOverlay').waitFor({ state: 'hidden' });
    passed.push('Unavailable/stale telemetry pauses and recovers; clock skew and a quiet finished job retain their previews');

    const jobBeforeReconnect = print;
    const loadsBeforeReconnect = await page.evaluate(() => window.__log().filter(line => line.includes('loadGcode OK')).length);
    printerConnection = 'offline';
    await page.getByText('Printer offline', { exact: true }).waitFor();
    await page.waitForFunction(() => !window.__nozzle.visible && window.__preview.layers.length > 0);
    assert.equal(await page.locator('#gcodeOverlay').evaluate(node => node.classList.contains('waiting')), false, 'The status does not cover a loaded preview');
    printerConnection = 'waiting';
    await page.getByText('Waiting for printer data', { exact: true }).waitFor();
    await writePacket({ gcode_state: 'RUNNING' });
    printerConnection = 'online';
    await page.getByText('Waiting for print details', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => window.__preview.layers.length > 0 && !window.__nozzle.visible));
    await writePacket(jobBeforeReconnect);
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').style.display === 'none');
    assert.equal(await page.evaluate(() => window.__log().filter(line => line.includes('loadGcode OK')).length), loadsBeforeReconnect);
    passed.push('A disconnect and an older state-only report retain the preview until the next complete report for the same job');

    await write('Slow job'); await open(); await until(() => releaseSlow);
    await writePacket({ _bb_job_pending: true, gcode_state: 'RUNNING', gcode_file: '/data/Metadata/plate_1.gcode' });
    await page.getByText('Waiting for print details', { exact: true }).waitFor();
    await write('Next job'); files['/Next job.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    await rendered(); const loaded = count; releaseSlow(); releaseSlow = null;
    await page.waitForTimeout(1000); assert.equal(count, loaded);
    assert.equal(await page.locator('#gcodeOverlay').isVisible(), false);
    assert.equal((await fs.readdir(path.join(data, 'gcode-cache'))).length, 4);
    passed.push('A confirmed new print renders after a provisional report while its obsolete download is still pending');

    const rectangle = (x1, y1, x2, y2, layers) => {
      const lines = ['G90', 'M83', 'G1 F6000'];
      for (let layer = 1; layer <= layers; layer++) lines.push(`G1 X${x1} Y${y1} Z${(layer * 0.2).toFixed(1)}`, `G1 X${x2} Y${y1} E1`, `G1 X${x2} Y${y2} E1`, `G1 X${x1} Y${y2} E1`, `G1 X${x1} Y${y1} E1`);
      return lines.join('\n') + '\n';
    };
    const framing = [];
    const standardViewports = [{ width: 640, height: 640 }, { width: 320, height: 640 }, { width: 1000, height: 240 }];
    const finished = { mc_percent: 100, mc_remaining_time: 0, stg_cur: -1 };
    for (const [name, toolpath, state, overrides, view, viewports] of [
      ['Long narrow', rectangle(10, 160, 330, 166, 3), 'FINISH', finished, 'angled', standardViewports],
      ['Tall model', rectangle(100, 100, 140, 140, 1500), 'RUNNING', { layer_num: 1500, total_layer_num: 1500 }, 'angled', standardViewports],
      ['Thin tower seen from above', rectangle(170, 160, 172, 162, 1250), 'FINISH', finished, 'top', [{ width: 640, height: 640 }]],
      ['Wide part in a narrow canvas', rectangle(10, 100, 280, 120, 10), 'FINISH', finished, 'front', [{ width: 130, height: 1000 }]],
    ]) {
      files[`/${name}.gcode.3mf`] = archive({ 'Metadata/plate_1.gcode': toolpath });
      await write(name, state, overrides); await open(view === 'angled' ? {} : { view }); await rendered();
      await page.waitForFunction(() => window.__preview.endLayer === window.__preview.layers.length);
      if (state === 'FINISH') assert.equal(await page.evaluate(() => window.__nozzle.visible), false);
      for (const viewport of viewports) {
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
        framing.push({ name, view, viewport, bounds });
      }
    }
    await fs.writeFile(path.join(artifacts, 'gcode-framing-results.json'), JSON.stringify(framing, null, 2));
    await page.setViewportSize({ width: 640, height: 640 });
    passed.push('Default and custom angles fit long, tall and narrow models, including near and far clip planes');

    await page.goto(base + '/toolpath-view-fixture');
    const frame = page.frame({ url: /\/widgets\/gcode-viz\// });
    const frameView = (view, zoom) => frame.waitForFunction(({ view, zoom }) => {
      const camera = window.__preview?.camera;
      return window.__log?.().some(line => line.includes('loadGcode OK')) && window.__diag().orbit.view === view && camera?.zoom === zoom;
    }, { view, zoom });
    await frameView('front', 1.25);
    const framePose = () => frame.evaluate(async () => {
      const { Vector3 } = await import('/vendor/three.module.js');
      const camera = window.__preview.camera;
      return { direction: camera.getWorldDirection(new Vector3()).negate().toArray(), zoom: camera.zoom, distance: Math.hypot(window.__diag().orbit.radius, window.__diag().orbit.height) };
    });
    const front = await framePose();
    assert.ok(Math.abs(front.direction[0]) < 0.001 && front.direction[2] > 0.98);
    const postView = (view, zoom) => page.locator('iframe[title="Toolpath test"]').evaluate((iframe, settings) => {
      iframe.contentWindow.postMessage({ type: 'bambuboard:gcode-view', ...settings }, location.origin);
    }, { view, zoom });
    const beforeViewChanges = count;
    await postView('side', 100); await frameView('side', 1);
    await frame.waitForFunction(() => window.__preview.camera.matrixWorld.elements[8] > 0.98);
    const side = await framePose();
    assert.ok(side.direction[0] > 0.98 && Math.abs(side.direction[2]) < 0.001);
    await postView('side', 200); await frameView('side', 2);
    assert.ok(Math.abs(side.distance - (await framePose()).distance) < 0.01, 'Zoom adjusts the projection while preserving the auto-fitted distance');
    await postView('top', 999); await frameView('top', 2);
    await frame.waitForFunction(() => window.__preview.camera.matrixWorld.elements[9] > 0.999);
    const top = await framePose();
    assert.ok(top.direction[1] > 0.999, JSON.stringify(top));
    await postView('invalid', 'invalid'); await frameView('angled', 1);
    assert.equal(count, beforeViewChanges);
    assert.equal(await frame.evaluate(() => window.__log().filter(line => line.includes('loadGcode OK')).length), 1);
    passed.push('Widget URL presets and editor updates change the actual camera and zoom without reloading the toolpath');

    assert.ok(largeToolpathBytes > 91.45 * mebibyte && largeToolpathBytes < 93 * mebibyte);
    assert.ok(paddingLines + sample.split('\n').length < toolpathLines);
    mode = 'large'; await write('Large printable job', 'FINISH'); await open(); await rendered();
    const largeReport = await fetch(base + '/api/gcode/diagnostics').then(response => response.json());
    assert.equal(largeReport.bytes, largeToolpathBytes);
    const loading = await page.evaluate(() => window.__loadingMessages);
    for (const phase of ['Getting print file', 'Downloading print file', 'Processing toolpath', 'Rendering 3D preview']) assert.ok(loading.some(text => text.includes(phase)), JSON.stringify(loading));
    assert.ok(loading.some(text => /Processing toolpath.*\d+%/.test(text)));
    assert.equal(await page.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#gcodeOverlay').isVisible(), false);
    assert.ok(await page.evaluate(() => window.__preview.layers.length >= 2), 'The extrusion after the padding is parsed and rendered');
    assert.ok(await page.evaluate(() => window.__preview.endLayer === window.__preview.layers.length));
    await page.evaluate(() => {
      window.__drawCount = 0;
      const renderer = window.__preview.renderer, draw = renderer.render.bind(renderer);
      renderer.render = (...args) => { window.__drawCount++; return draw(...args); };
    });
    await page.waitForTimeout(1000);
    assert.ok(await page.evaluate(() => window.__drawCount <= 8), 'A finished plate must not be continuously drawn by duplicate animation loops');
    const beforeResize = await page.evaluate(() => window.__drawCount);
    await page.setViewportSize({ width: 400, height: 320 });
    await page.waitForFunction(before => window.__drawCount > before, beforeResize);
    await page.setViewportSize({ width: 640, height: 640 });
    passed.push('A 92 MiB toolpath above the previous 80 MiB cap renders with visible progress');

    mode = 'normal'; await write('Suspended animation frames', 'FINISH');
    files['/Suspended animation frames.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    const suspended = await context.newPage();
    await suspended.addInitScript(() => { window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {}; });
    await suspended.goto(base + '/widgets/gcode-viz/?debug=1');
    await suspended.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')), null, { polling: 100 });
    assert.equal(await suspended.locator('#gcodeOverlay').isVisible(), false);
    assert.equal(await suspended.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    await suspended.close();
    passed.push('An obscured widget with suspended animation frames still finishes loading');

    mode = 'oversize-archive'; await write('Oversized archive');
    files['/Oversized archive.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    await open();
    await page.getByText(/sliced archive exceeds.+Load the exact \.gcode file/).waitFor();
    assert.equal(await page.locator('#gcodeRetry').isVisible(), false);
    assert.equal(await page.locator('#gcodeFileButton').isVisible(), true);
    const archiveAttempts = count;
    await page.locator('#gcodeFile').setInputFiles({ name: 'exact-plate.gcode', mimeType: 'application/octet-stream', buffer: Buffer.from(sample) });
    await rendered();
    assert.equal(count, archiveAttempts, 'Manual G-code recovery must not download the oversized archive again');
    passed.push('Oversized archive preserves manual G-code recovery without retrying the archive');

    const beforeOversize = count;
    mode = 'oversize'; await write('Oversized job'); await open();
    await page.waitForFunction(limit => document.getElementById('gcodeOverlay').textContent.includes(`${limit} MiB`), toolpathMiB);
    assert.ok(!(await page.locator('#gcodeOverlay').innerText()).includes('Use Retry now'));
    assert.equal(await page.locator('#gcodeRetry').isVisible(), false);
    assert.equal(await page.locator('#gcodeFileButton').isVisible(), false);
    assert.equal(await page.locator('#gcodeDownloadLog').isVisible(), true);
    assert.equal(count, beforeOversize + 1);
    let before = count; await page.waitForTimeout(1000); assert.equal(count, before);
    mode = 'many-lines'; await write('Too many lines'); await open();
    await page.waitForFunction(limit => document.getElementById('gcodeOverlay').textContent.includes(`${limit}-line`), toolpathLines.toLocaleString('en-US'));
    assert.equal(await page.locator('#gcodeRetry').isVisible(), false);
    assert.equal(await page.locator('#gcodeFileButton').isVisible(), false);
    assert.equal(await page.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    mode = 'unprintable'; await write('No extrusion'); await open();
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('no printable extrusion'));
    before = count; await page.waitForTimeout(1000); assert.equal(count, before);
    assert.equal(await page.locator('#gcodeFileButton').isVisible(), true, 'Recovery controls return for a fixable file error');
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

    printerType = 'H3C';
    // Bambu Studio's H3C tool-change template emits T[next_filament_id].
    // Follow the observed full H3C report's packed unit/tray mapping: T5 uses
    // AMS 3H slot 0. T8 selects a virtual 2.85 mm spool in slot 8.
    const h3c = ['G90', 'M83', 'T5', 'G1 X300 Y290 Z0.2', 'G1 X320 Y290 E1', 'G1 X320 Y310 E1',
      'T8', 'M83', 'G1 Z0.4', 'G1 X300 Y310 E1', 'G1 X300 Y290 E1', ''].join('\n');
    const h3cArchive = archive({ 'Metadata/plate_1.gcode': sample, 'Metadata/plate_2.gcode': h3c });
    const h3cJob = {
      plate_idx: 2, plate_id: 2, layer_num: 2, total_layer_num: 2,
      mapping: [65535, 65535, 65535, 65535, 65535, 8192, 65535, 65535, 63487],
      ams: { ams: [
        { id: '0', tray: [{ id: '0', tray_color: 'FFDD00FF' }] },
        { id: '32', tray: [{ id: '0', state: 283, tray_color: '1234ABFF' }, { id: '8', state: 160 }] },
      ] },
      vir_slot: [{ id: '247', state: 283, tray_color: 'BC21D4FF' }],
      device: { extruder: { info: [{ id: 0, snow: 63487 }] } },
    };
    files['/cache/H3C plate.gcode.3mf'] = h3cArchive;
    await write('H3C plate', 'FINISH', { ...h3cJob, gcode_file: 'H3C plate.gcode.3mf' });
    await open({ view: 'top', zoom: '125' }); await rendered();
    assert.deepEqual(await page.evaluate(() => ({ ...window.__preview.buildVolume })), { x: 330, y: 320, z: 325 });
    assert.deepEqual(await page.evaluate(() => [0, 5, 8].map(index => window.__preview.extrusionColor[index].getHexString())), ['888888', '1234ab', 'bc21d4']);
    const h3cReport = await fetch(base + '/api/gcode/diagnostics').then(response => response.json());
    assert.equal(h3cReport.printer.model, 'H3C');
    assert.ok(h3cReport.events.some(event => event.entry === 'Metadata/plate_2.gcode'));
    assert.ok(h3cReport.events.some(event => event.path === '/cache/H3C plate.gcode.3mf' && event.result === 'ok'));
    assert.deepEqual(await page.evaluate(() => [window.__diag().orbit.view, window.__preview.camera.zoom]), ['top', 1.25]);
    await page.screenshot({ path: path.join(artifacts, 'gcode-h3c-rendered.png') });
    passed.push('H3C FTPS retrieves plate 2, renders actual WebGL on the H3C bed and applies packed filament mapping with a virtual 3H spool');

    await write('H3C internal-storage job', 'FINISH', { plate_idx: 2, gcode_file: '/data/Metadata/plate_2.gcode' });
    await page.waitForFunction(() => document.getElementById('gcodeOverlay').textContent.includes('cannot expose'));
    assert.equal(await page.locator('#gcodeFileButton').isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__preview.extrusionColor.getHexString()), '888888');
    await page.locator('#gcodeFile').setInputFiles({ name: 'h3c-plate.gcode.3mf', mimeType: 'application/octet-stream', buffer: h3cArchive });
    await page.waitForFunction(() => window.__log().filter(line => line.includes('loadGcode OK')).length === 2);
    await rendered();
    assert.equal(await page.evaluate(() => window.__preview.extrusionColor.getHexString()), '888888');
    const manualReport = await fetch(base + '/api/gcode/diagnostics').then(response => response.json());
    assert.equal(manualReport.source, 'manual');
    assert.ok(manualReport.events.some(event => event.entry === 'Metadata/plate_2.gcode'));
    passed.push('H3C FTPS failure allows manual loading of the exact sliced plate, with neutral colors until mapping is available');

    assert.deepEqual(errors, []); assert.deepEqual([...external], []);
    await fs.writeFile(path.join(artifacts, 'gcode-browser-results.json'), JSON.stringify({ passed, errors, external: [...external], source: 'Loopback FTPS and sample toolpath; no physical printer', downloads: count }, null, 2));
    console.log(`Gcode browser passed: ${passed.length} end-to-end recovery groups; no JavaScript errors or external requests. Artifacts: ${artifacts}`);
  } finally {
    releaseSlow?.(); await browser?.close(); await routes.stop();
    for (const fn of cleanup.reverse()) await fn();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
