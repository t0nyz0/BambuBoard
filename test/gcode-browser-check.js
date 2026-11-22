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
const { mergePrint } = require('../src/lib/printTelemetry');
const { toolpathMiB } = require('../public/js/gcode-limits');
const root = path.resolve(__dirname, '..');
const firstLayer = 'G90\nM83\nG1 X10 Y10 Z0.2 E1\nG1 X70 Y10 E1\nG1 X70 Y70 E1\nG1 X10 Y70 E1\nG1 X10 Y10 E1\n';
const lastLayer = 'G1 Z0.4\nG1 X70 Y10 E1\nG1 X70 Y70 E1\n';
const sample = firstLayer + lastLayer;
const modalPrefix = 'G90\nM82\nG92 E0\nT0\nG1 X10 Y10 Z0.2 F6000\nG1 X50 Y10 E1\nG1 X50 Y40 E2\n';
const modalSuffix = 'M83\nT1\nG1 Z0.4\nG1 X10 Y40 E0.5\nG1 X10 Y10 E0.5';
const modalSample = modalPrefix + modalSuffix;
const denseSquare = 'G1 X30 Y20 E0.1\nG1 X30 Y30 E0.1\nG1 X20 Y30 E0.1\nG1 X20 Y20 E0.1\n';
const denseArcs = 'G2 X70 Y50 I10 J0 E0.5\nG2 X50 Y50 I-10 J0 E0.5\n';
const sampleBytes = Buffer.from(sample);
const mebibyte = 1024 * 1024;
const paddingLine = Buffer.from('; fixture padding 0123456789\n');
const paddingLines = Math.ceil((92 * mebibyte - Buffer.byteLength(modalSample)) / paddingLine.length);
const largeToolpathBytes = Buffer.byteLength(modalSample) + paddingLines * paddingLine.length;
(async () => {
  const cleanup = [], t = { after: fn => cleanup.push(fn) };
  const data = await temporary(t), artifacts = process.env.BB_SCREENSHOTS || await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-gcode-browser-'));
  await fs.mkdir(artifacts, { recursive: true });
  const files = {}, ftp = await ftpsFixture(t, { files });
  const app = express(), passed = [], errors = [], external = new Set();
  let clock = Date.now(), mode = 'normal', count = 0, releaseSlow = null, telemetryBroken = false, telemetryStale = false;
  let printerConnection = 'online';
  let printerType = 'H2D';
  let print, responseBody, pendingPrinter;
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
      if (mode === 'slow-printer') {
        for (let step = 1; step <= 8; step++) {
          await new Promise(resolve => setTimeout(resolve, 240));
          options.signal.throwIfAborted();
          options.onEvent({ stage: 'download', result: 'progress', bytes: Math.floor(sampleBytes.length * step / 8), expectedBytes: sampleBytes.length });
        }
        return sampleBytes;
      }
      if (mode === 'stalled-printer') {
        return new Promise((resolve, reject) => {
          const request = pendingPrinter = { stopped: false };
          options.signal.addEventListener('abort', () => {
            request.stopped = true;
            reject(options.signal.reason);
          }, { once: true });
        });
      }
      if (mode === 'large') {
        const toolpath = Buffer.alloc(largeToolpathBytes);
        const paddingStart = toolpath.write(modalPrefix);
        const paddingEnd = paddingStart + paddingLines * paddingLine.length;
        toolpath.fill(paddingLine, paddingStart, paddingEnd);
        toolpath.write(modalSuffix, paddingEnd);
        return toolpath;
      }
      if (mode === 'dense') return Buffer.from('G90\nM83\nG1 X20 Y20 Z0.2\n' + denseSquare.repeat(4000) + 'G1 Z0.4\n' + denseSquare);
      if (mode === 'complexity') return Buffer.from('G90\nM83\nG1 X50 Y50 Z0.2\n' + denseArcs.repeat(80000));
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
  app.get('/toolpath-view-fixture', (_req, res) => res.send('<iframe title="Toolpath test" src="/widgets/gcode-viz/?debug=1&mode=preview&view=front&zoom=125" width="640" height="640"></iframe>'));
  app.get('/api/gcode/current', (_req, res, next) => {
    if (['slow-response', 'stalled-response', 'truncated-response'].includes(mode)) {
      count++;
      const sent = responseBody = { started: Date.now(), closed: false, bytes: 0 };
      const truncated = mode === 'truncated-response';
      res.set({ 'Content-Type': 'text/plain', 'Content-Length': String(sampleBytes.length + (truncated ? 64 : 0)) });
      if (truncated) res.set('Connection', 'close');
      let interval;
      res.on('close', () => { clearInterval(interval); sent.closed = true; });
      const remaining = () => sampleBytes.subarray(sent.bytes);
      const push = size => {
        const chunk = remaining().subarray(0, size);
        sent.bytes += chunk.length;
        res.write(chunk);
      };
      if (truncated) {
        push(sampleBytes.length);
        return res.end();
      }
      push(mode === 'stalled-response' ? Buffer.byteLength(firstLayer) : 16);
      if (mode === 'slow-response') {
        interval = setInterval(() => {
          push(16);
          if (!remaining().length) { clearInterval(interval); res.end(); }
        }, 240);
      }
      return;
    }
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
    const open = settings => page.goto(base + '/widgets/gcode-viz/?' + new URLSearchParams({ debug: '1', mode: 'preview', ...settings }));
    const rendered = async () => {
      await page.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')));
      assert.ok(await page.evaluate(() => window.__preview.layers.length > 0 && window.__preview.renderer.info.render.calls > 0));
    };
    await write('Root job'); files['/Root job.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    await open(); await rendered(); assert.equal(count, 1);
    await page.screenshot({ path: path.join(artifacts, 'gcode-rendered.png') });
    passed.push('Real HTTP/FTPS/ZIP/WebGL path renders a zero-ID LAN job');

    const calibrationName = 'auto_cali_for_user_param.gcode';
    const calibrationPath = '/usr/etc/print/' + calibrationName;
    const beforeCalibration = count;
    const renderedBeforeCalibration = await page.evaluate(() => window.__log().filter(line => line.includes('loadGcode OK')).length);
    await write(calibrationName, 'RUNNING', { gcode_file: calibrationPath, stg_cur: 25, mc_percent: 16 });
    await page.getByText('Calibrating', { exact: true }).waitFor();
    assert.equal(await page.locator('#gcodeCanvas').isVisible(), false);
    assert.equal(await page.locator('#gcodeRecovery').isVisible(), false);
    assert.ok(await page.evaluate(() => window.__preview.layers.every(layer => layer.commands.length === 0)));
    const calibrationGet = await fetch(base + '/api/gcode/current');
    assert.equal(calibrationGet.status, 409);
    assert.equal((await calibrationGet.json()).code, 'CALIBRATING');
    const calibrationPost = await fetch(base + '/api/gcode/current', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: sampleBytes });
    assert.equal(calibrationPost.status, 409);
    assert.equal((await calibrationPost.json()).code, 'CALIBRATING');
    assert.equal((await fetch(base + '/api/gcode/progress')).status, 204);
    await page.waitForTimeout(1800);
    assert.equal(count, beforeCalibration, 'Built-in calibration cannot fetch, retry, or upload an ordinary toolpath');

    files['/cache/' + calibrationName] = sampleBytes;
    await write(calibrationName, 'FINISH', { _bb_job_id: 'user job with calibration basename', gcode_file: '/cache/' + calibrationName, mc_percent: 100 });
    await page.locator('#gcodeOverlay').waitFor({ state: 'hidden' });
    await page.waitForFunction(previous => window.__log().filter(line => line.includes('loadGcode OK')).length > previous, renderedBeforeCalibration);
    await rendered();
    assert.equal(count, beforeCalibration + 1, 'An identically named user file from ordinary storage still renders');
    passed.push('Calibration clears the previous preview, blocks transfer and recovery controls, and restores rendering for a similarly named ordinary print');

    await write('Public missing file', 'FINISH', { mc_percent: 100 });
    await page.goto(base + '/widgets/gcode-viz/?debug=1');
    await page.getByText('Print preview unavailable.', { exact: true }).waitFor();
    for (const id of ['gcodeRetry', 'gcodeDownloadLog', 'gcodeFileButton', 'gcodeCancel', 'gcodeDebug', 'gcodeLog']) {
      assert.equal(await page.locator('#' + id).isVisible(), false, `Public widget exposed ${id}`);
    }
    await write(calibrationName, 'RUNNING', { gcode_file: calibrationPath, stg_cur: 25, mc_percent: 16 });
    await page.getByText('Calibrating', { exact: true }).waitFor();
    assert.equal(await page.locator('#gcodeRecovery').isVisible(), false);
    await page.screenshot({ path: path.join(artifacts, 'gcode-live-calibrating.png') });
    passed.push('The default browser source shows a concise public error and calibration status without operator controls');

    printerType = 'P1S';
    const localPrint = {
      gcode_state: 'RUNNING', print_type: 'local', task_id: '0', subtask_id: '0',
      gcode_file: '/cache/P1S inline calibration.gcode', subtask_name: 'P1S inline calibration',
      layer_num: 0, total_layer_num: 2, mc_percent: 0, stg_cur: 25, ams: { ams: [] },
    };
    const beforeP1S = count;
    files[localPrint.gcode_file] = sampleBytes;
    await writePacket(mergePrint({}, localPrint));
    await open(); await rendered();
    await page.getByText('Preparing print…', { exact: true }).waitFor();
    assert.equal(await page.locator('#gcodeCanvas').isVisible(), true, 'Inline calibration preserves the real print preview');
    assert.equal(count, beforeP1S + 1);
    passed.push('Ordinary P1S print with an inline calibration stage still fetches and renders its real toolpath');

    await writePacket(mergePrint(print, {
      ...localPrint, print_type: 'system', gcode_file: calibrationName, subtask_name: calibrationName,
    }));
    await page.getByText('Calibrating', { exact: true }).waitFor();
    assert.equal(await page.locator('#gcodeCanvas').isVisible(), false);
    assert.equal(await page.locator('#gcodeRecovery').isVisible(), false);
    assert.ok(await page.evaluate(() => window.__preview.layers.every(layer => layer.commands.length === 0)));
    const p1sCalibration = await fetch(base + '/api/gcode/current');
    assert.equal(p1sCalibration.status, 409);
    assert.equal((await p1sCalibration.json()).code, 'CALIBRATING');
    await writePacket(mergePrint(print, { gcode_state: 'RUNNING', mc_percent: 16 }));
    await page.waitForTimeout(1800);
    assert.equal(await page.locator('#gcodeOverlay').textContent(), 'Calibrating');
    assert.equal(count, beforeP1S + 1, 'Partial P1S system updates do not start a download');

    files['/' + calibrationName] = sampleBytes;
    await writePacket(mergePrint(print, {
      ...localPrint, gcode_file: calibrationName, subtask_name: calibrationName,
      gcode_state: 'FINISH', layer_num: 2, mc_percent: 100, stg_cur: -1,
    }));
    await page.locator('#gcodeOverlay').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__log().filter(line => line.includes('loadGcode OK')).length === 2);
    assert.equal(count, beforeP1S + 2, 'The same bare basename from a local user print is still previewable');
    passed.push('P1S confirmed bare system calibration clears the old preview, survives partial telemetry, and resumes on an identically named local print');
    printerType = 'H2D';

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
    await rendered(); const loaded = count;
    const confirmedCache = (await fs.readdir(path.join(data, 'gcode-cache'))).sort();
    releaseSlow(); releaseSlow = null;
    await page.waitForTimeout(1000); assert.equal(count, loaded);
    assert.equal(await page.locator('#gcodeOverlay').isVisible(), false);
    assert.deepEqual((await fs.readdir(path.join(data, 'gcode-cache'))).sort(), confirmedCache, 'The obsolete download cannot update the cache');
    passed.push('A confirmed new print renders after a provisional report while its obsolete download is still pending');

    // Accelerate the inactivity wait on this page only. The standalone
    // fixture still uses real HTTP body chunks and actual progress responses.
    await page.goto('about:blank');
    const transport = await context.newPage();
    await transport.addInitScript(() => {
      window.__framedTestLines = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          if (String(url).endsWith('/toolpath-reader-worker.js')) {
            this.addEventListener('message', ({ data }) => { window.__framedTestLines += data.lines?.length || 0; });
          }
        }
      };
    });
    await transport.route('**/js/gcode-limits.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const faster = source.replace(/\btransferIdleMs:\s*[\d_]+/, 'transferIdleMs: 1200')
        .replace(/\btransferPollMs:\s*[\d_]+/, 'transferPollMs: 180');
      assert.notEqual(faster, source, 'The production limit module supplies the inactivity timing');
      await route.fulfill({ response, body: faster });
    });
    const transportOpen = async (nextMode, job, state = 'FINISH') => {
      await transport.goto('about:blank');
      responseBody = null;
      mode = nextMode;
      await write(job, state);
      await transport.goto(base + '/widgets/gcode-viz/?debug=1&mode=preview');
    };
    const transportRendered = () => transport.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')) && window.__preview.renderer.info.render.calls > 0);
    const progressReceipts = [];
    transport.on('response', response => {
      if (new URL(response.url()).pathname !== '/api/gcode/progress') return;
      response.json().then(body => progressReceipts.push(body)).catch(() => {});
    });
    await transportOpen('slow-printer', 'Slowly progressing printer transfer');
    await transportRendered();
    assert.ok(new Set(progressReceipts.filter(item => item.bytes > 0).map(item => item.bytes)).size >= 2, 'The real progress route reports ongoing bytes before the response body starts');
    assert.ok(await transport.evaluate(() => window.__loadingMessages.some(message => /Reading file from printer.*\d+%/.test(message))), 'Printer progress is visible before BambuBoard sends the toolpath');
    passed.push('A progressing printer transfer outlasts the idle deadline while the viewer polls for actual activity');

    await transportOpen('slow-response', 'Slowly progressing response body');
    await transportRendered();
    assert.ok(Date.now() - responseBody.started > 1200);
    assert.equal(responseBody.bytes, sampleBytes.length);
    passed.push('A progressing browser response outlasts the idle deadline and renders its full toolpath');

    await transportOpen('stalled-printer', 'Stalled printer transfer');
    await until(() => pendingPrinter);
    await transport.locator('#gcodeOverlay').filter({ hasText: /No file data received/i }).waitFor();
    assert.equal(await transport.locator('#gcodeRetry').isVisible(), true);
    assert.equal(await transport.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    await until(() => pendingPrinter.stopped);
    passed.push('A printer transfer that never sends headers times out and releases its obsolete backend download');

    await transportOpen('stalled-response', 'Stalled response body');
    await transport.locator('#gcodeOverlay').filter({ hasText: /No file data received/i }).waitFor();
    await until(() => responseBody.closed);
    assert.equal(await transport.locator('#gcodeRetry').isVisible(), true);
    assert.equal(await transport.locator('#gcodeCancel').isVisible(), false);
    assert.equal(await transport.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    passed.push('A stalled response is aborted and presents an actionable retry while the widget stays responsive');

    await transportOpen('truncated-response', 'Interrupted response body');
    await transport.locator('#gcodeOverlay.error').waitFor();
    assert.match(await transport.locator('#gcodeOverlay').innerText(), /before all toolpath bytes|incomplete|truncat|interrupted|network|connection/i);
    assert.equal(await transport.evaluate(() => window.__log().some(line => line.includes('loadGcode OK'))), false);
    assert.equal(await transport.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    passed.push('A truncated HTTP response gives a transport error and never renders partial geometry');

    await transportOpen('stalled-response', 'Canceled preview', 'RUNNING');
    await until(() => responseBody?.bytes > 0);
    await transport.waitForFunction(() => window.__framedTestLines >= 5);
    await transport.locator('#gcodeCancel').click();
    await transport.locator('#gcodeOverlay').filter({ hasText: /Toolpath loading canceled/i }).waitFor();
    await until(() => responseBody.closed);
    const afterCancel = count;
    files['/Canceled preview.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    mode = 'normal';
    clock += 300000;
    await transport.evaluate(() => { window.__timeOffset += 300000; });
    await transport.waitForTimeout(1800);
    assert.equal(count, afterCancel, 'A user-canceled job stays canceled through later polls');
    assert.equal(await transport.evaluate(() => window.__log().some(line => line.includes('loadGcode OK'))), false, 'Cancel must not publish a partial preview');
    await transport.locator('#gcodeRetry').click();
    await transportRendered();
    assert.equal(count, afterCancel + 1);
    passed.push('Cancel closes the active response, stops automatic retries and allows an explicit retry of the same job');

    await transportOpen('stalled-response', 'Old in-flight body');
    await until(() => responseBody?.bytes > 0);
    await transport.waitForFunction(() => window.__framedTestLines >= 5);
    const retiredBody = responseBody;
    files['/Replacement after body abort.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': modalSample });
    mode = 'normal';
    await write('Replacement after body abort', 'FINISH');
    await transportRendered();
    await until(() => retiredBody.closed);
    assert.ok(await transport.evaluate(() => window.__preview.layers.at(-1).commands.some(command => command.params.x === 10 && command.params.y === 10 && command.params.e === 0.5)));
    assert.equal(await transport.evaluate(() => window.__preview.layers.some(layer => layer.commands.some(command => command.params?.x === 70))), false, 'The replacement must not include partially parsed geometry from its predecessor');
    assert.equal(await transport.evaluate(() => window.__log().filter(line => line.includes('loadGcode OK')).length), 1);
    await transport.close();
    passed.push('Changing the print closes an obsolete partially read response and renders only the replacement geometry');

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

    const renderedToolpath = (target = page) => target.evaluate(() => {
      const preview = window.__preview;
      const layers = preview.layers.map(layer => ({ height: layer.height,
        commands: layer.commands.filter(command => command.gcode).map(command => [command.gcode, command.params]),
      }));
      const paths = [];
      preview.scene.traverse(object => {
        const position = object.geometry?.getAttribute('position');
        if (object.material?.isLineBasicMaterial && position && !object.geometry.getAttribute('color')) {
          paths.push(Array.from(position.array));
        }
      });
      return { layers, paths };
    });
    files['/Small modal fixture.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': modalSample });
    await write('Small modal fixture', 'FINISH'); await open(); await rendered();
    const smallPreview = await renderedToolpath();
    assert.equal(smallPreview.layers.length, 3, 'The pinned parser retains its prep layer before the two extrusion layers');
    assert.ok(smallPreview.paths.some(path => path.length > 0), 'The comparison has real geometry');
    assert.ok(smallPreview.layers.at(-1).commands.some(([code, params]) => code === 'g1' && params.x === 10 && params.y === 10 && params.e === 0.5), 'The last command without a newline reaches the final layer');

    assert.ok(largeToolpathBytes > 91.45 * mebibyte && largeToolpathBytes < 93 * mebibyte);
    assert.ok(paddingLines > 3000000);
    mode = 'large'; await write('Large printable job', 'FINISH'); await open(); await rendered();
    const largeReport = await fetch(base + '/api/gcode/diagnostics').then(response => response.json());
    assert.equal(largeReport.bytes, largeToolpathBytes);
    const loading = await page.evaluate(() => window.__loadingMessages);
    for (const phase of ['Getting print file', 'Downloading print file', 'Processing toolpath', 'Rendering 3D preview']) assert.ok(loading.some(text => text.includes(phase)), JSON.stringify(loading));
    assert.ok(loading.some(text => /Downloading print file.*\d+%/.test(text)), 'Known body length shows meaningful download percentages');
    assert.equal(await page.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#gcodeOverlay').isVisible(), false);
    assert.deepEqual(await renderedToolpath(), smallPreview, 'Over three million comment lines leave the modal commands, layers and WebGL geometry intact');
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
    passed.push('A 92 MiB plate with over three million comment lines renders the exact small-file modal toolpath and layers with visible progress');

    await page.goto('about:blank');
    mode = 'normal';
    files['/Worker unavailable.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': modalSample });
    await write('Worker unavailable', 'FINISH');
    const fallback = await context.newPage();
    await fallback.addInitScript(() => { window.Worker = class { constructor() { throw new Error('Worker blocked in fixture'); } }; });
    await fallback.goto(base + '/widgets/gcode-viz/?debug=1&mode=preview');
    await fallback.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')));
    assert.deepEqual(await renderedToolpath(fallback), smallPreview);
    await fallback.close();
    passed.push('The same bounded decoder preserves layers and geometry when the browser blocks Worker creation');

    mode = 'dense'; await write('Dense printable plate', 'FINISH'); await open(); await rendered();
    const densePreview = await renderedToolpath();
    assert.equal(densePreview.layers.length, 3);
    assert.equal(densePreview.layers[1].commands.filter(([code, params]) => code === 'g1' && params.e > 0).length, 16000);
    assert.ok(densePreview.paths.some(path => path.length >= 16000 * 3), 'The dense printable fixture draws its actual motion geometry');
    passed.push('A dense two-layer fixture renders all 16,000 extrusion moves on its first layer');

    const beforeDenseOverflow = count;
    mode = 'complexity'; await write('Dense arc plate above the geometry budget', 'FINISH'); await open();
    await page.locator('#gcodeOverlay').filter({ hasText: /Bambu Studio/ }).waitFor();
    assert.match(await page.locator('#gcodeOverlay').innerText(), /geometry|complex|dense|detail|preview capacity/i);
    assert.equal(await page.locator('#gcodeRetry').isVisible(), false);
    assert.equal(await page.locator('#gcodeFileButton').isVisible(), false);
    assert.equal(await page.locator('.gcode-stage').getAttribute('aria-busy'), 'false');
    assert.equal(await page.evaluate(() => window.__log().some(line => line.includes('loadGcode OK'))), false);
    assert.equal(count, beforeDenseOverflow + 1);
    passed.push('A dense arc plate above the geometry budget offers Bambu Studio without rendering a partial path or retrying');

    mode = 'normal'; await write('Suspended animation frames', 'FINISH');
    files['/Suspended animation frames.gcode.3mf'] = archive({ 'Metadata/plate_1.gcode': sample });
    const suspended = await context.newPage();
    await suspended.addInitScript(() => { window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {}; });
    await suspended.goto(base + '/widgets/gcode-viz/?debug=1&mode=preview');
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
    await noWebGL.goto(base + '/widgets/gcode-viz/?mode=preview');
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
