// Full browser flow against temporary data, accessed over loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const fixtureGcode = 'G90\nM82\n;LAYER:0\nG1 X10 Y10 Z0.2 E1\nG1 X80 Y10 E2\nG1 X80 Y80 E3\nG1 X10 Y80 E4\nG1 X10 Y10 E5\n;LAYER:1\nG1 Z0.4\nG1 X80 Y10 E6\nG1 X80 Y80 E7\nG1 X10 Y80 E8\n';
(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-browser-'));
  const artifactDir = process.env.BB_SCREENSHOTS || path.join(data, 'screenshots');
  await fs.mkdir(artifactDir, { recursive: true });
  const config = { printer: { name: 'Demo H2D', type: 'H2D', url: '127.0.0.1', port: '9', serialNumber: 'FIXTURE', accessCode: 'fixture-only', detectedFrom: 'config' }, cloudAuth: { enabled: false } };
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(config));
  const telemetry = { print: { gcode_state: 'RUNNING', mc_percent: 47, mc_remaining_time: 69, layer_num: 2, total_layer_num: 18, task_id: 'fixture', subtask_id: 'fixture', subtask_name: 'Fixture print', gcode_file: '/data/Metadata/plate_1.gcode', nozzle_temper: 210, nozzle_target_temper: 215, bed_temper: 60, bed_target_temper: 60, chamber_temper: 28, wifi_signal: '-48dBm', spd_lvl: 2, ams: { ams: [] } } };
  await fs.writeFile(path.join(data, 'data.json'), JSON.stringify(telemetry));
  const portServer = net.createServer();
  await new Promise(r => portServer.listen(0, '127.0.0.1', r));
  const port = portServer.address().port;
  await new Promise(r => portServer.close(r));
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const server = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), BAMBUBOARD_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });
  let browser;
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/api/status')).ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' });
    // Toolpath data is a sample, never a request to a physical printer.
    await context.route('**/api/gcode/current*', route => route.fulfill({ contentType: 'text/plain', body: fixtureGcode }));
    const errors = [], external = new Set();
    context.on('page', page => page.on('pageerror', e => errors.push(e.stack || e.message)));
    context.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.add(request.url()); });
    const cameraSample = execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '1', '-c:v', 'mpeg1video', '-f', 'mpegts', 'pipe:1'], { timeout: 10000 });
    await context.route('**/assets/camera-fixture.ts*', route => route.fulfill({ contentType: 'video/mp2t', headers: { 'Content-Length': String(cameraSample.length) }, body: cameraSample }));
    const page = await context.newPage();
    await page.goto(base + '/scene-editor');
    await page.waitForSelector('.scene-item');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.bb-logo').getAttribute('src'), '/assets/bambuboard-prism.svg');
    assert.equal(await page.locator('#bb-stepper').isVisible(), false);
    assert.equal(await page.locator('#draft-state').innerText(), 'New draft');
    await page.locator('#draft-name').fill('Studio fixture');
    await page.locator('#save-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved');
    assert.equal((await fetch(base + '/api/obs/active').then(r => r.json())).slug, null);
    await page.locator('#golive-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Published to /live');
    const published = await fetch(base + '/api/obs/published').then(r => r.json());
    // Change geometry using the real inspector and save without publishing.
    await page.locator('.layer-row').first().click();
    await page.locator('#insp-x').fill('42');
    await page.locator('#insp-x').dispatchEvent('change');
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes');
    await page.locator('#save-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved');
    assert.deepEqual(await fetch(base + '/api/obs/published').then(r => r.json()), published);
    await page.reload(); await page.waitForSelector('.scene-item');
    assert.equal(await page.locator('#loader').inputValue(), 'scn:Studio fixture');
    // Library supports keyboard addition and capability notes.
    await page.locator('#widget-drawer-btn').click();
    await page.locator('.drawer-widget').filter({ hasText: 'Progress' }).first().focus();
    const before = await page.locator('.scene-item').count();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.scene-item').count(), before + 1);
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes');
    await page.locator('#undo-btn').click();
    assert.equal(await page.locator('.scene-item').count(), before);
    assert.equal(await page.locator('#draft-state').innerText(), 'Draft saved');
    await page.locator('#redo-btn').click();
    assert.equal(await page.locator('.scene-item').count(), before + 1);
    await page.locator('#save-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved');
    await page.locator('#widget-drawer-close').click();
    const layoutResults = [];
    for (const width of [1440, 1024, 736, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const route of ['/', '/scene-editor', '/setup']) {
        await page.goto(base + route);
        await page.waitForSelector('.nav-brand');
        if (route === '/scene-editor') await page.waitForSelector('.scene-item');
        if (route === '/') await page.waitForFunction(() => document.getElementById('publication-state').textContent === 'Published');
        await page.evaluate(() => document.fonts.ready);
        const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        assert.ok(dimensions.content <= width, `${route} overflows at ${width}: ${dimensions.content}`);
        layoutResults.push({ route, width, ...dimensions });
        if ((width === 1440 || width === 390) && route !== '/setup') await page.waitForTimeout(1400);
        if (width === 1440 || width === 390) await page.screenshot({ path: path.join(artifactDir, `${route === '/' ? 'live' : route.slice(1)}-${width}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(base + '/');
    await page.waitForFunction(() => document.getElementById('publication-state').textContent === 'Published');
    assert.equal(await page.locator('#youtube-details').getAttribute('open'), null);
    const order = await page.evaluate(() => document.querySelector('.preview-card').getBoundingClientRect().top < document.querySelector('.obs-card').getBoundingClientRect().top && document.querySelector('.obs-card').getBoundingClientRect().top < document.querySelector('.youtube-section').getBoundingClientRect().top);
    assert.ok(order);
    const iframe = page.frameLocator('#live-frame');
    await iframe.locator('.live-item').first().waitFor();
    const sceneExport = await fetch(base + '/api/obs/single-source').then(r => r.json());
    assert.equal(sceneExport.sources[0].settings.width, published.resolution.x);
    // Test HTTP LAN feature detection with the real document, without capture.
    await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
    await page.reload(); await page.locator('#youtube-details').evaluate(node => { node.open = true; });
    assert.match(await page.locator('#yt-support').innerText(), /HTTPS or localhost/);
    assert.equal(await page.locator('#yt-start').isEnabled(), false);
    await page.goto(base + '/setup'); await page.waitForFunction(() => document.getElementById('p-name').value === 'Demo H2D');
    await page.locator('#show-ac').click(); assert.equal(await page.locator('#p-ac').getAttribute('type'), 'text');
    await page.locator('.display-preferences > summary').click();
    const checked = await page.locator('#fan-pct').getAttribute('aria-checked');
    await page.locator('#fan-pct').focus(); await page.keyboard.press('Space');
    assert.notEqual(await page.locator('#fan-pct').getAttribute('aria-checked'), checked);
    await page.locator('#save-btn').click(); await page.waitForSelector('.toast');
    const saved = JSON.parse(await fs.readFile(path.join(data, 'config.json'), 'utf8'));
    assert.equal(saved.BambuBoard_displayFanPercentages, checked !== 'true');
    await page.locator('#cloud-tab-email').click();
    assert.equal(await page.locator('#cloud-method-email').isVisible(), true);
    const relayPage = await context.newPage();
    await relayPage.addInitScript(() => {
      const tracks = [{ stopped: false, stop() { this.stopped = true; }, addEventListener() {} }];
      window.captureFixture = { tracks, recorderStopped: false, socketClosed: false };
      Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: async () => ({ getTracks: () => tracks, getVideoTracks: () => tracks }) } });
      window.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.state = 'inactive'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; window.captureFixture.recorderStopped = true; } };
      window.WebSocket = class {
        static OPEN = 1;
        constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 10); }
        send() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'started' }) }), 10); }
        close() { this.readyState = 3; window.captureFixture.socketClosed = true; this.onclose?.(); }
      };
    });
    await relayPage.goto(base + '/');
    await relayPage.locator('#youtube-details').evaluate(node => { node.open = true; });
    await relayPage.locator('#yt-key').fill('fixture-only'); await relayPage.locator('#yt-start').click();
    await relayPage.waitForFunction(() => document.getElementById('yt-active-status').textContent.includes('Relay running'));
    await relayPage.locator('#youtube-details').evaluate(node => { node.open = false; });
    assert.equal(await relayPage.locator('#yt-stop').isVisible(), true);
    await relayPage.locator('#yt-stop').click();
    assert.ok(await relayPage.evaluate(() => captureFixture.tracks.every(track => track.stopped) && captureFixture.recorderStopped && captureFixture.socketClosed));
    await relayPage.close();
    // Every jQuery widget executes against the same sample telemetry.
    const widgets = await fetch(base + '/api/widgets').then(r => r.json());
    for (const widget of widgets) {
      await page.goto(base + `/widgets/${widget.slug}/`);
      await page.waitForTimeout(1300);
      // Telemetry arrives on an asynchronous poll. Slow runners can still be
      // showing placeholders after the delay above; wait for rendered data.
      if (widget.slug === 'progress-info') {
        await page.waitForFunction(() => /47%/.test(document.getElementById('printStatus')?.textContent || '') && document.getElementById('printProgressBar')?.getBoundingClientRect().width > 20);
        assert.match(await page.locator('#printStatus').innerText(), /47%/); assert.ok(await page.locator('#printProgressBar').evaluate(node => node.getBoundingClientRect().width > 20));
      }
      if (widget.slug === 'bed-temp') {
        await page.waitForFunction(() => document.getElementById('bedCurrentTempC')?.textContent === '60');
        assert.equal(await page.locator('#bedCurrentTempC').innerText(), '60');
      }
      if (widget.slug === 'print-info') {
        await page.waitForFunction(() => document.getElementById('printModelName')?.textContent === 'Fixture print' && /2.*18/.test(document.getElementById('printCurrentLayer')?.textContent || ''));
        assert.equal(await page.locator('#printModelName').innerText(), 'Fixture print'); assert.match(await page.locator('#printCurrentLayer').innerText(), /2.*18/);
      }
      if (widget.slug === 'camera') {
        await page.evaluate(() => {
          window.cameraDecodedFrames = 0;
          window.cameraFixturePlayer = new JSMpeg.Player('/assets/camera-fixture.ts', { canvas: document.getElementById('camCanvas'), audio: false, autoplay: true, onVideoDecode: () => window.cameraDecodedFrames++ });
        });
        await page.waitForFunction(() => window.cameraDecodedFrames >= 5);
        assert.equal(await page.locator('#camCanvas').evaluate(canvas => canvas.width), 320);
        await page.evaluate(() => window.cameraFixturePlayer.destroy());
      }
      if (widget.slug === 'gcode-viz') {
        await page.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')));
        const rendered = await page.evaluate(async gcode => {
          const { init } = await import('/vendor/gcode-preview.esm.js');
          const results = [];
          for (const renderTubes of [false, true]) {
            const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 400; document.body.appendChild(canvas);
            const preview = init({ canvas, renderTubes, renderTravel: false, buildVolume: { x: 256, y: 256, z: 256 } });
            preview.processGCode(gcode); preview.render();
            let extrusionVertices = 0;
            preview.scene.traverse(object => { if (object.isBatchedMesh) extrusionVertices += object.instanceCount; else if (object.material?.type === 'LineBasicMaterial' && !object.geometry.attributes.color) extrusionVertices += object.geometry.attributes.position?.count || 0; });
            results.push({ renderTubes, extrusionVertices, layers: preview.layers.length, calls: preview.renderer.info.render.calls, alpha: preview.renderer.getContext().getContextAttributes().alpha });
            preview.dispose?.(); preview.renderer.dispose(); canvas.remove();
          }
          return results;
        }, fixtureGcode);
        assert.ok(rendered.every(result => result.layers > 0 && result.extrusionVertices > 0 && result.calls > 0 && result.alpha), JSON.stringify(rendered));
        await page.screenshot({ path: path.join(artifactDir, 'gcode-widget.png') });
      }
      if (widget.slug !== 'camera' && widget.slug !== 'gcode-viz') assert.equal(await page.evaluate(() => window.jQuery?.fn.jquery), '4.0.0');
    }
    // Old hosts, AMS/nozzle selection, custom themes and bindings survive an editor round-trip.
    const parameters = structuredClone(published);
    const ams = parameters.sources.find(source => source.settings?.url?.includes('/widgets/ams/'));
    const secondAms = structuredClone(ams); secondAms.name = 'AMS duplicate'; secondAms.uuid = 'fixture-duplicate'; secondAms.settings.url = 'http://old-board.invalid/widgets/ams/?ams=3&theme=dark&accent=51a34f'; parameters.sources.push(secondAms);
    parameters.sources.find(source => source.id === 'scene').settings.items.push({ name: secondAms.name, pos: { x: 300, y: 300 }, scale: { x: 1, y: 1 }, align: 5 });
    ams.settings.url = 'https://old-board.invalid/widgets/ams/?ams=2&nozzle=1&theme=light&accent=8c7ae6&bind.temp=%24.print.bed_temper';
    await fetch(base + '/api/obs/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Parameter fixture', json: parameters }) });
    await page.goto(base + '/scene-editor'); await page.waitForSelector('.scene-item');
    await page.locator('#loader').selectOption('scn:Parameter fixture');
    await page.waitForFunction(() => document.getElementById('draft-name').value === 'Parameter fixture');
    assert.match(await page.locator('iframe[src*="/widgets/ams/"][src*="ams=2"]').getAttribute('src'), /ams=2/);
    await page.locator('#save-btn').click(); await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved');
    const roundTrip = await fetch(base + '/api/obs/scenes/Parameter%20fixture').then(r => r.json());
    const query = new URL(roundTrip.sources.find(source => source.name === ams.name).settings.url).searchParams;
    for (const [key, value] of Object.entries({ ams: '2', nozzle: '1', theme: 'light', accent: '8c7ae6', 'bind.temp': '$.print.bed_temper' })) assert.equal(query.get(key), value);
    const duplicateQuery = new URL(roundTrip.sources.find(source => source.name === 'AMS duplicate').settings.url).searchParams;
    assert.equal(duplicateQuery.get('ams'), '3'); assert.equal(duplicateQuery.get('theme'), 'dark'); assert.equal(duplicateQuery.get('accent'), '51a34f');
    // Inspect the docked controls and expanded optional settings on a narrow screen.
    await page.setViewportSize({ width: 320, height: 1100 });
    await page.locator('.layer-row').first().click();
    assert.equal(await page.locator('#inspector-fields').isVisible(), true);
    await page.locator('#widget-drawer-btn').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#widget-drawer-close').click(); assert.equal(await page.locator('#layers-panel').isVisible(), true);
    await page.goto(base + '/setup?firstRun=1'); await page.waitForFunction(() => !document.getElementById('bb-stepper').hidden);
    await page.locator('.display-preferences > summary').click(); await page.locator('#cloud-tab-email').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, [], 'browser JavaScript errors');
    assert.deepEqual([...external], [], 'LAN operation must not request CDN assets');
    await fs.writeFile(path.join(artifactDir, 'browser-results.json'), JSON.stringify({ layouts: layoutResults, widgets: widgets.length, errors, externalRequests: [...external] }, null, 2));
    console.log(`Browser passed: ${layoutResults.length} responsive layouts, ${widgets.length} widgets, save/publish isolation, setup keyboard controls, HTTP capture detection, no external requests. Screenshots: ${artifactDir}`);
  } catch (error) { console.error(logs); throw error; }
  finally {
    await browser?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
    if (!process.env.BB_SCREENSHOTS) console.log(`Test evidence retained at ${data}`);
    else await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
