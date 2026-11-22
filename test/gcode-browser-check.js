// Full widget -> HTTP -> implicit FTPS -> ZIP -> WebGL and recovery controls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
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

const compactPlate = { layers: 95, segments: 217125, commands: 248000, lines: 260031 };
const stressPlate = { layers: 1475, segments: 3442468, commands: 3914598, lines: 4213137 };
const rasterWidth = 128, layerThicknessCenti = 16;
const travelLiftCenti = 2400;
const layerShare = (count, layers, layer) => Math.floor(count / layers) + Number(layer <= count % layers);
const axis = centi => (centi / 100).toFixed(2).padStart(6, '0');
function rasterPoint(layer, step) {
  const startX = 1000 + (layer % 37), startY = 1200 + (layer % 16) * 12;
  if (!step) return [startX, startY, layer * layerThicknessCenti];
  const row = Math.floor((step - 1) / rasterWidth), column = (step - 1) % rasterWidth;
  return [startX + 30 * (row % 2 ? rasterWidth - column - 1 : column + 1), startY + row * 40, layer * layerThicknessCenti];
}
const compactHeader = 'G90\nM83\n', motionless = 'M400\n', compactComment = '; fixture layer metadata\n';
const travelLine = ([x, y, z]) => `G0 X${axis(x)} Y${axis(y)} Z${axis(z)} F1200\n`;
const liftLine = z => `G0 Z${axis(z)}\n`;
const extrusionLine = ([x, y]) => `G1 X${axis(x)} Y${axis(y)} E0.05\n`;
const nonMotionLines = plate => plate.commands - plate.segments - plate.layers * 3 - 2;
function compactByteLength(plate) {
  return compactHeader.length + plate.layers * travelLine([0, 0, 0]).length + plate.segments * extrusionLine([0, 0]).length
    + 2 * plate.layers * liftLine(0).length
    + nonMotionLines(plate) * motionless.length + (plate.lines - plate.commands) * compactComment.length;
}
function* compactToolpath(plate) {
  yield compactHeader;
  for (let layer = 1; layer <= plate.layers; layer++) {
    const segments = layerShare(plate.segments, plate.layers, layer);
    const lines = [motionless.repeat(layerShare(nonMotionLines(plate), plate.layers, layer)), travelLine(rasterPoint(layer, 0))];
    // Travel out and back after the first real extrusion. This lift stays on
    // the motion path but cannot change any finished model vertices or layers.
    const first = rasterPoint(layer, 1);
    lines.push(extrusionLine(first), liftLine(first[2] + travelLiftCenti), liftLine(first[2]));
    for (let step = 2; step <= segments; step++) lines.push(extrusionLine(rasterPoint(layer, step)));
    lines.push(compactComment.repeat(layerShare(plate.lines - plate.commands, plate.layers, layer)));
    yield lines.join('');
  }
}


const windowLayer = { moves: 270000, movesPerRow: 1000, z: 0.16 };
// Each move is exactly 1 mm at 60 mm/min. The last move of every row
// extrudes, including the final move, so travels stay inside the layer.
const windowHeader = compactHeader + 'G0 X10.00 Y10.00 Z0.16 F60\n';
function windowPoint(move) {
  const row = Math.floor(move / windowLayer.movesPerRow);
  return [10 + (move - row) % 2, 10 + row, windowLayer.z];
}
function windowMoveLine(move) {
  const [x, y] = windowPoint(move);
  const extrusion = move % windowLayer.movesPerRow === 0;
  return `G${extrusion ? 1 : 0} X${axis(x * 100)} Y${axis(y * 100)}${extrusion ? ' E0.05' : ''}\n`;
}
const windowLayerSegments = windowLayer.moves / windowLayer.movesPerRow;
function windowByteLength() {
  return windowHeader.length + (windowLayer.moves - windowLayerSegments) * windowMoveLine(1).length
    + windowLayerSegments * windowMoveLine(windowLayer.movesPerRow).length;
}
function* windowToolpath() {
  yield windowHeader;
  for (let start = 1; start <= windowLayer.moves; start += 4096) {
    const lines = [];
    for (let move = start; move <= windowLayer.moves && move < start + 4096; move++) lines.push(windowMoveLine(move));
    yield lines.join('');
  }
}

// A same-Z setup line is followed by two authored layers. The first spans
// a source block boundary between red deposition and travel, then deposits
// green after a retract and prime. F60 makes distance in mm equal seconds.
const depositionToolpath = Buffer.from(
  compactHeader + motionless.repeat(200_001) +
  'G0 X20 Y70 Z0.2 F60\nG1 X30 E1\n' +
  '; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; layer num/total_layer_count: 1/2\n' +
  'T0\nG1 X100 E1\n' + 'G1 F60\n'.repeat(2048) +
  'G0 X160\nG1 E-1\nG1 E1\nT1\nG1 X230 E1\n' +
  '; CHANGE_LAYER\n; Z_HEIGHT: 0.4\n; layer num/total_layer_count: 2/2\n' +
  'G0 Z0.4\nG1 Y160 E1\n'
);

// Each non-final physical layer commands 160 mm at 10 mm/s. Three prior
// measured layers will instead report roughly 48 seconds apiece.
const pacedLayerCount = 5;
const pacedToolpath = Buffer.from(
  compactHeader + motionless.repeat(200_001) + 'G0 X50 Y70 Z0.2 F600\nG1 X60 E1\n' +
  Array.from({ length: pacedLayerCount }, (_, i) => {
    const layer = i + 1;
    const z = (layer * 0.2).toFixed(1);
    return `; CHANGE_LAYER\n; Z_HEIGHT: ${z}\n; layer num/total_layer_count: ${layer}/${pacedLayerCount}\n` +
      `G0 Z${z}\nG1 X120 E1\nG1 Y90 E1\nG1 X60 E1\nG0 Y70\n`;
  }).join('')
);

function compactTiming(plate) {
  const layers = [];
  let elapsed = 0, previous = [0, 0, 0];
  const move = next => {
    elapsed += Math.hypot(...next.map((value, axis) => value - previous[axis]));
    previous = next;
  };
  for (let layer = 1; layer <= plate.layers; layer++) {
    move(rasterPoint(layer, 0));
    const start = elapsed;
    const segments = layerShare(plate.segments, plate.layers, layer);
    for (let step = 1; step <= segments; step++) {
      move(rasterPoint(layer, step));
      if (step === 1) elapsed += 2 * travelLiftCenti;
    }
    layers[layer] = { start, end: elapsed };
  }
  return {
    // The fixture uses a single feed rate, so distance ratios are time ratios.
    progress: layer => 100 * (layers[layer].start * 0.7 + layers[layer].end * 0.3) / elapsed,
  };
}

function onRasterMotion(plate, layer, position) {
  const [x, y, z] = position.map(value => value * 100);
  const [liftX, liftY, surface] = rasterPoint(layer, 1);
  const tolerance = 0.12; // Allow Float32 coordinate rounding.
  if (layer > 1) {
    const previous = rasterPoint(layer - 1, layerShare(plate.segments, plate.layers, layer - 1));
    const start = rasterPoint(layer, 0);
    const direction = start.map((value, i) => value - previous[i]);
    const relative = [x, y, z].map((value, i) => value - previous[i]);
    const dot = direction.reduce((sum, value, i) => sum + value * relative[i], 0);
    const lengthSquared = direction.reduce((sum, value) => sum + value * value, 0);
    const fraction = Math.min(1, Math.max(0, dot / lengthSquared));
    if (Math.hypot(...relative.map((value, i) => value - fraction * direction[i])) < tolerance) return true;
  }
  if (Math.abs(x - liftX) < tolerance && Math.abs(y - liftY) < tolerance
    && z >= surface - tolerance && z <= surface + travelLiftCenti + tolerance) return true;
  if (Math.abs(z - surface) > tolerance) return false;
  let [ax, ay] = rasterPoint(layer, 0);
  const segments = layerShare(plate.segments, plate.layers, layer);
  for (let step = 1; step <= segments; step++) {
    const [bx, by] = rasterPoint(layer, step);
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx ** 2 + dy ** 2)));
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < tolerance) return true;
    ax = bx; ay = by;
  }
  return false;
}

(async () => {
  const cleanup = [], t = { after: fn => cleanup.push(fn) };
  const data = await temporary(t), artifacts = process.env.BB_SCREENSHOTS || await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-gcode-browser-'));
  await fs.mkdir(artifacts, { recursive: true });
  const files = {}, ftp = await ftpsFixture(t, { files });
  const app = express(), passed = [], errors = [], external = new Set();
  let clock = Date.now(), mode = 'normal', count = 0, releaseSlow = null, telemetryBroken = false, telemetryStale = false;
  let printerConnection = 'online';
  let printerType = 'H2D';
  let print, responseBody, pendingPrinter, packedFixture, packedHold, receivedAt = 0;
  const writePacket = async packet => {
    print = packet;
    receivedAt = Math.max(Date.now(), receivedAt + 1);
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
    res.json({ print, _bb_received_at: telemetryStale ? Date.now() - 65000 : receivedAt });
  });
  app.get('/api/status', (_req, res) => res.json({ printer: { type: printerType } }));
  app.get('/toolpath-view-fixture', (_req, res) => res.send('<iframe title="Toolpath test" src="/widgets/gcode-viz/?debug=1&mode=preview&view=front&zoom=125" width="640" height="640"></iframe>'));
  app.get('/api/gcode/current', async (req, res, next) => {
    if (!['packed', 'packed-held', 'packed-window', 'packed-deposition', 'packed-pace'].includes(mode)) return next();
    count++;
    // Stream one generated layer at a time. Neither the test server nor the
    // browser automation client holds or copies the whole synthetic source.
    const controller = new AbortController();
    const { signal } = controller;
    const hold = mode === 'packed-held' ? (packedHold = { blocked: false, closed: false }) : null;
    res.once('close', () => {
      if (hold) hold.closed = true;
      controller.abort();
    });
    const windowed = mode === 'packed-window';
    const fixture = mode === 'packed-deposition' ? depositionToolpath : mode === 'packed-pace' ? pacedToolpath : null;
    const length = fixture ? fixture.length : windowed ? windowByteLength() : compactByteLength(packedFixture);
    res.set({ 'Content-Type': 'text/plain', 'Content-Length': String(length), 'X-Gcode-Job': encodeURIComponent(req.query.job) });
    try {
      let chunks = 0;
      const toolpath = fixture ? [fixture] : windowed ? windowToolpath() : compactToolpath(packedFixture);
      for (const chunk of toolpath) {
        signal.throwIfAborted();
        if (!res.write(chunk)) await once(res, 'drain', { signal });
        if (hold && ++chunks === 88) {
          hold.blocked = true;
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          return;
        }
      }
      res.end();
    } catch (error) {
      if (!signal.aborted) next(error);
    }
  });
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

    async function attachPackedBrowserProbes(target, { virtualClock = false, holdFirstRead = false } = {}) {
      await target.addInitScript(({ virtualClock, holdFirstRead }) => {
        if (virtualClock) {
          window.__motionClockOffset = 0;
          const actualNow = performance.now.bind(performance);
          performance.now = () => actualNow() + window.__motionClockOffset;
        }
        window.__packedHeartbeat = { loading: 0, maximumGapMs: 0 };
        const gate = window.__packedLayerGate = { armed: holdFirstRead, blocked: false, release: null, reads: 0, canceled: 0 };
        const stream = Blob.prototype.stream;
        Blob.prototype.stream = function () {
          const original = stream.call(this);
          gate.reads++;
          if (!gate.armed) return original;
          gate.armed = false;
          gate.blocked = true;
          const opened = new Promise(resolve => { gate.release = resolve; });
          const reader = original.getReader();
          let cancelled = false;
          return new ReadableStream({
            async pull(controller) {
              await opened;
              if (cancelled) return;
              const chunk = await reader.read();
              if (cancelled) return;
              if (chunk.done) controller.close();
              else controller.enqueue(chunk.value);
            },
            cancel(reason) {
              cancelled = true;
              gate.canceled++;
              return reader.cancel(reason);
            },
          });
        };
        let last = performance.now();
        let wasBusy = false;
        setInterval(() => {
          const now = performance.now();
          const busy = document.querySelector('.gcode-stage')?.getAttribute('aria-busy') === 'true';
          if (busy) window.__packedHeartbeat.loading++;
          if (busy || wasBusy) {
            window.__packedHeartbeat.maximumGapMs = Math.max(window.__packedHeartbeat.maximumGapMs, now - last);
          }
          wasBusy = busy;
          last = now;
        }, 25);
      }, { virtualClock, holdFirstRead });
    }

    const packedEvidence = [];
    async function checkPackedPlate(plate, name, timeout) {
      await page.goto('about:blank');
      const densePage = await context.newPage();
      await attachPackedBrowserProbes(densePage);
      let requests = 0, lateJoinRequests = 0;
      densePage.on('request', request => { if (new URL(request.url()).pathname === '/api/gcode/current') requests++; });
      const before = count;
      const timing = compactTiming(plate);
      const sumThrough = end => Math.floor(plate.segments / plate.layers) * end + Math.min(end, plate.segments % plate.layers);
      const waitForVisible = (visible, limit = timeout) => densePage.waitForFunction(expected => {
        const packed = window.__diag?.().compact;
        return packed?.visibleSegments === expected && packed.staticReady &&
          packed.staticLines >= expected && getComputedStyle(document.getElementById('gcodeCanvas')).visibility === 'visible';
      }, visible, { timeout: limit });
      const motionSample = target => target.evaluate(() => window.__diag?.().motion);
      async function waitForMotion(target, layer, previous) {
        const handle = await target.waitForFunction(({ layer, surface, previous }) => {
          const motion = window.__diag?.().motion;
          if (motion?.layer !== layer || motion.state !== 'ready' || !motion.visible || !motion.position) return false;
          if (motion.position[2] < surface - 0.001 || motion.position[2] > surface + 24.001) return false;
          if (previous && Math.hypot(...motion.position.map((value, axis) => value - previous[axis])) < 0.04) return false;
          return motion;
        }, { layer, surface: (layer * layerThicknessCenti) / 100, previous }, { timeout });
        const motion = await handle.jsonValue();
        await handle.dispose();
        assert.ok(onRasterMotion(plate, layer, motion.position), `Layer ${layer} nozzle is off the ordered toolpath: ${motion.position}`);
        assert.ok(motion.bytes > 0 && motion.bytes <= 2 * 2048 * 61, `Resident motion bytes: ${motion.bytes}`);
        assert.ok(motion.sourceBytes > 0 && motion.sourceBytes <= motion.rawSourceBytes &&
          motion.rawSourceBytes <= compactByteLength(plate),
          `Replay source must remain within the downloaded byte bound: ${motion.sourceBytes} / ${motion.rawSourceBytes}`);
        assert.ok(motion.layers.length <= 2 && motion.layers.includes(layer), `Unexpected decoded layers: ${motion.layers}`);
        return motion;
      }
      const reportLayer = async layer => {
        await writePacket({ ...print, gcode_state: 'RUNNING', layer_num: layer, mc_percent: timing.progress(layer),
          _bb_layer_elapsed_ms: 500, _bb_layer_advancing: true });
        await waitForVisible(sumThrough(layer - 1));
      };
      const startLayer = async layer => {
        await reportLayer(layer);
        return waitForMotion(densePage, layer);
      };
      try {
        packedFixture = plate;
        mode = 'packed';
        await write(name, 'PAUSED', { layer_num: 1, total_layer_num: plate.layers, mc_percent: timing.progress(1) });
        await densePage.goto(base + '/widgets/gcode-viz/?debug=1&mode=preview');
        await waitForVisible(0);
        const first = await densePage.evaluate(() => ({
          ...window.__diag().compact, nozzle: window.__diag().motion?.visible, startup: window.__diag().startup,
        }));
        assert.equal(first.startup?.reader, 'worker');
        assert.ok(first.startup.responseMs <= first.startup.downloadMs && first.startup.downloadMs <= first.startup.geometryReadyMs,
          JSON.stringify(first.startup));
        assert.ok(first.startup.workerTiming?.batches > 0, JSON.stringify(first.startup));
        assert.equal(first.segments, plate.segments);
        assert.equal(first.layers, plate.layers + 1, 'The model layers and parser preamble are all counted');
        assert.equal(first.nozzle, false, 'Opening on a paused print must not animate the nozzle');
        assert.equal(first.drawCalls, 0, 'A cold first-layer viewer cannot show an unconfirmed deposition');
        assert.ok(first.bytes >= plate.segments * 24 && first.bytes <= plate.segments * 36 + mebibyte, JSON.stringify(first));

        const firstMotion = await startLayer(1);
        await densePage.getByText('Estimated nozzle position', { exact: false }).waitFor();
        const afterFirst = await waitForMotion(densePage, 1, firstMotion.position);
        assert.ok(afterFirst.animationDraws > firstMotion.animationDraws);
        const startup = await densePage.evaluate(() => window.__diag().startup);
        assert.ok(startup.geometryReadyMs <= startup.firstNozzleMs, JSON.stringify(startup));
        const staticBefore = await densePage.evaluate(() => {
          const preview = window.__preview;
          const renderer = preview.renderer;
          const draw = renderer.render.bind(renderer);
          const group = preview.scene.getObjectByName('packed-toolpath');
          window.__packedBaseline = {
            group, draws: 0,
            attributes: group.children.map(object => {
              const position = object.geometry.getAttribute('position');
              return { object, geometry: object.geometry, position, version: position.version };
            }),
          };
          renderer.render = (scene, ...args) => {
            if (scene === preview.scene && renderer.getRenderTarget()) window.__packedBaseline.draws++;
            return draw(scene, ...args);
          };
          return window.__diag().motion;
        });
        const animationOnly = await waitForMotion(densePage, 1, staticBefore.position);
        assert.ok(animationOnly.animationDraws > staticBefore.animationDraws);
        assert.equal(animationOnly.staticDraws, staticBefore.staticDraws, 'Animating the nozzle must not redraw the packed model');
        assert.deepEqual(await densePage.evaluate(() => {
          const saved = window.__packedBaseline;
          const current = window.__preview.scene.getObjectByName('packed-toolpath');
          return {
            draws: saved.draws, sameGroup: current === saved.group,
            sameBuffers: saved.attributes.every(({ object, geometry, position, version }, i) =>
              current.children[i] === object && object.geometry === geometry &&
              geometry.getAttribute('position') === position && position.version === version),
          };
        }), { draws: 0, sameGroup: true, sameBuffers: true });

        const middle = Math.ceil(plate.layers / 2);
        if (plate === compactPlate) {
          await densePage.evaluate(() => { window.__packedLayerGate.armed = true; });
          await reportLayer(middle);
          await densePage.waitForFunction(layer => {
            const motion = window.__diag?.().motion;
            return window.__packedLayerGate.blocked && motion?.layer === layer && motion.state === 'buffering';
          }, middle, { timeout });
          const buffering = await motionSample(densePage);
          assert.equal(buffering.visible, false, 'A cold layer must not show a nozzle on an old layer');
          await densePage.getByText('Buffering nozzle preview', { exact: false }).waitFor();
          await densePage.waitForTimeout(350);
          const stillBuffering = await motionSample(densePage);
          assert.equal(stillBuffering.state, 'buffering');
          assert.equal(stillBuffering.animationDraws, buffering.animationDraws);
          await densePage.evaluate(() => window.__packedLayerGate.release());
        } else {
          await reportLayer(middle);
        }
        const middleMotion = await waitForMotion(densePage, middle);
        const afterMiddle = await waitForMotion(densePage, middle, middleMotion.position);
        await densePage.screenshot({ path: path.join(artifacts, `${name}-animated.png`), timeout });
        let lateJoin;
        if (plate === compactPlate) {
          const latePage = await context.newPage();
          latePage.on('request', request => { if (new URL(request.url()).pathname === '/api/gcode/current') lateJoinRequests++; });
          try {
            await attachPackedBrowserProbes(latePage, { holdFirstRead: true });
            await latePage.goto(base + '/widgets/gcode-viz/?debug=1&mode=preview');
            await latePage.waitForFunction(expected => {
              const diag = window.__diag?.();
              return window.__packedLayerGate.blocked && diag?.compact?.visibleSegments === expected &&
                diag.compact.staticBuiltLines > 0 && diag.motion?.state === 'buffering' && !diag.motion.visible &&
                getComputedStyle(document.getElementById('gcodeCanvas')).visibility === 'visible';
            }, sumThrough(middle - 1), { timeout });
            await latePage.evaluate(() => window.__packedLayerGate.release());
            const joined = await waitForMotion(latePage, middle);
            lateJoin = await waitForMotion(latePage, middle, joined.position);
            assert.equal(lateJoinRequests, 1, 'A late viewer seeks the current layer in its single download');
          } finally {
            await latePage.close();
            await densePage.bringToFront();
          }
        }
        await writePacket({ ...print, gcode_state: 'PAUSED', _bb_layer_advancing: false });
        await densePage.waitForFunction(layer => {
          const motion = window.__diag?.().motion;
          return motion?.layer === layer && ['paused', 'hidden'].includes(motion.state) && !motion.visible;
        }, middle, { timeout });
        const paused = await motionSample(densePage);
        await densePage.waitForTimeout(400);
        const stillPaused = await motionSample(densePage);
        assert.deepEqual(stillPaused.position, paused.position, 'A paused print cannot advance the estimated nozzle');
        assert.equal(stillPaused.animationDraws, paused.animationDraws, 'Pause stops animation frame draws');
        const resumed = await startLayer(middle);
        await waitForMotion(densePage, middle, resumed.position);

        const finalMotion = await startLayer(plate.layers);
        const afterFinal = await waitForMotion(densePage, plate.layers, finalMotion.position);
        await writePacket({ ...print, gcode_state: 'FINISH', layer_num: plate.layers, mc_percent: 100 });
        await waitForVisible(plate.segments);
        await densePage.waitForFunction(() => !window.__diag?.().motion?.visible, null, { timeout });

        const probeLayers = [1, middle, plate.layers];
        const rendered = await densePage.evaluate(({ layers, probeLayers, layerThicknessCenti }) => {
          const preview = window.__preview;
          const group = preview.scene.getObjectByName('packed-toolpath');
          if (!group) return null;
          const counts = new Uint32Array(layers + 1), endpoints = {};
          const selected = new Set(probeLayers);
          let positionBytes = 0, drawnSegments = 0, planar = true, objects = 0;
          window.__packedDisposeCount = 0;
          group.traverse(object => {
            const geometry = object.geometry;
            const positions = geometry?.getAttribute('position');
            if (!positions) return;
            objects++;
            geometry.addEventListener('dispose', () => { window.__packedDisposeCount++; });
            const values = positions.array;
            positionBytes += values.byteLength;
            const start = geometry.drawRange.start;
            const end = Math.min(positions.count, start + geometry.drawRange.count);
            drawnSegments += (end - start) / 2;
            for (let offset = 3 * start; offset < 3 * end; offset += 6) {
              const layer = Math.round(values[offset + 2] * 100 / layerThicknessCenti);
              if (layer < 1 || layer > layers || values[offset + 2] !== values[offset + 5]) { planar = false; continue; }
              counts[layer]++;
              if (!selected.has(layer)) continue;
              const segment = Array.from(values.subarray(offset, offset + 6));
              if (!endpoints[layer]) endpoints[layer] = { first: segment, last: null };
              endpoints[layer].last = segment;
            }
          });
          const compact = window.__diag().compact;
          return { counts: Array.from(counts), endpoints, positionBytes, drawnSegments, planar, objects,
            gpuLines: compact.staticLines, compact, heartbeat: window.__packedHeartbeat,
            nozzle: window.__diag().motion?.visible, busy: document.querySelector('.gcode-stage').getAttribute('aria-busy') };
        }, { layers: plate.layers, probeLayers, layerThicknessCenti });
        assert.ok(rendered?.planar, 'The compact WebGL group contains only exact, planar extrusion moves');
        assert.equal(rendered.positionBytes, plate.segments * 24);
        assert.equal(rendered.drawnSegments, plate.segments);
        assert.ok(rendered.gpuLines >= plate.segments, 'The renderer issued draw calls for the complete final model');
        assert.ok(rendered.objects > 0 && rendered.objects < plate.layers, `Unexpected geometry count ${rendered.objects}`);
        for (let layer = 1; layer <= plate.layers; layer++) assert.equal(rendered.counts[layer], layerShare(plate.segments, plate.layers, layer), `Printed layer ${layer}`);
        const segment = (layer, step) => [...rasterPoint(layer, step - 1), ...rasterPoint(layer, step)].map(coord => Math.fround(coord / 100));
        for (const layer of probeLayers) {
          assert.deepEqual(rendered.endpoints[layer].first, segment(layer, 1), `First endpoint pair of layer ${layer}`);
          assert.deepEqual(rendered.endpoints[layer].last, segment(layer, layerShare(plate.segments, plate.layers, layer)), `Last endpoint pair of layer ${layer}`);
        }
        assert.equal(rendered.nozzle, false);
        assert.equal(rendered.busy, 'false');
        assert.ok(rendered.heartbeat.loading > 2, 'The browser can run UI tasks while the packed preview is loading');
        assert.ok(rendered.heartbeat.maximumGapMs < (plate === stressPlate ? 5000 : 2000), JSON.stringify(rendered.heartbeat));
        assert.equal(requests, 1, 'Layer progression and packed conversion must not repeat the HTTP request');
        assert.equal(count, before + 1 + lateJoinRequests, 'Exactly one preview download is served per viewer');
        await densePage.screenshot({ path: path.join(artifacts, `${name}.png`), timeout });

        let scrub;
        if (plate === compactPlate) {
          await densePage.evaluate(layer => {
            const control = document.getElementById('gcodeScrub');
            control.value = String(layer + 1); // The display prefix includes the preamble.
            control.dispatchEvent(new Event('input', { bubbles: true }));
          }, middle);
          await densePage.getByText('Toolpath replay', { exact: false }).waitFor();
          await densePage.waitForFunction(layer => {
            const motion = window.__diag?.().motion;
            return motion?.layer === layer && motion.state === 'ready' && motion.visible;
          }, middle, { timeout });
          scrub = await densePage.evaluate(async ({ x, y, z }) => {
            const control = document.getElementById('gcodePath');
            async function seek(value) {
              control.value = String(value);
              control.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              return window.__diag().motion.position;
            }
            const start = await seek(0);
            let lift = null;
            for (let value = 5; value <= 150; value += 5) {
              const point = await seek(value);
              if (point && Math.abs(point[0] - x) < 0.002 && Math.abs(point[1] - y) < 0.002 && point[2] > z + 2) {
                lift = point;
                break;
              }
            }
            return { start, lift, end: await seek(1000), back: await seek(0) };
          }, Object.fromEntries(['x', 'y', 'z'].map((axis, i) => [axis, rasterPoint(middle, 1)[i] / 100])));
          assert.ok(scrub.lift && onRasterMotion(plate, middle, scrub.lift), 'Replay must include the exact non-printing Z lift');
          const layerEndpoint = layer => rasterPoint(layer, layerShare(plate.segments, plate.layers, layer)).map(point => point / 100);
          for (const [actual, expected] of [[scrub.start, layerEndpoint(middle - 1)], [scrub.end, layerEndpoint(middle)]]) {
            assert.ok(Math.hypot(...actual.map((point, i) => point - expected[i])) < 0.002,
              `Scrub endpoint ${actual} must match ordered toolpath endpoint ${expected}`);
          }
          assert.deepEqual(scrub.back, scrub.start, 'Seeking backwards must return to the exact same start');
          const coldLayer = middle + 5;
          await densePage.evaluate(layer => {
            Object.assign(window.__packedLayerGate, { armed: true, blocked: false, release: null });
            const control = document.getElementById('gcodeScrub');
            control.value = String(layer + 1);
            control.dispatchEvent(new Event('input', { bubbles: true }));
          }, coldLayer);
          await densePage.waitForFunction(layer => {
            const motion = window.__diag?.().motion;
            return window.__packedLayerGate.blocked && motion?.layer === layer && motion.state === 'buffering';
          }, coldLayer, { timeout });
        }

        mode = 'normal';
        const next = name + ' replacement';
        files[`/${next}.gcode.3mf`] = archive({ 'Metadata/plate_1.gcode': sample });
        await write(next, 'FINISH');
        await densePage.waitForFunction(() => !window.__diag?.().compact && window.__preview?.layers.length === 3
          && window.__log().filter(line => line.includes('loadGcode OK')).length === 2, null, { timeout });
        if (plate === compactPlate) {
          await densePage.evaluate(async () => {
            window.__packedLayerGate.release();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          });
        }
        assert.equal(await densePage.evaluate(() => window.__preview.scene.getObjectByName('packed-toolpath')), undefined);
        assert.equal(await densePage.evaluate(() => window.__packedDisposeCount), rendered.objects, 'A replacement job disposes every packed buffer');
        assert.equal(await densePage.evaluate(() => window.__diag()?.motion), null, 'A replacement clears the old packed motion');
        assert.equal(await densePage.locator('#gcodeDetail').isVisible(), false);
        packedEvidence.push({ fixture: name, initialState: 'PAUSED', ...plate, sourceBytes: compactByteLength(plate), rendered: rendered.compact,
          geometryObjects: rendered.objects, gpuLines: rendered.gpuLines, heartbeat: rendered.heartbeat, httpRequests: 1, lateJoinRequests,
          startup,
          motion: { first: afterFirst, middle: afterMiddle, final: afterFinal, lateJoin, scrub, staticDrawsDuringAnimation: animationOnly.staticDraws - staticBefore.staticDraws } });
      } finally {
        await densePage.close();
      }
    }
    async function checkMarkedDeposition() {
      await page.goto('about:blank');
      mode = 'packed-deposition';
      const before = count;
      const target = await context.newPage();
      const view = base + '/widgets/gcode-viz/?debug=1&view=top';
      const timeout = 45_000;
      const setLayer = async (layer, elapsedMs, advancing = true, state = 'RUNNING') => {
        await writePacket({ ...print, layer_num: layer, gcode_state: state, mc_percent: layer * 25,
          _bb_layer_elapsed_ms: elapsedMs, _bb_layer_advancing: advancing });
      };
      const waitForMotion = async expected => {
        const handle = await target.waitForFunction(expected => {
          const motion = window.__diag?.().motion;
          if (!motion || !motion.depositionReady || motion.markerLayerCount !== 2) return false;
          if (Object.entries(expected).some(([key, value]) => {
            if (key !== 'x') return motion[key] !== value;
            return !(motion.position?.[0] >= value[0] && motion.position[0] < value[1]);
          })) return false;
          return motion;
        }, expected, { timeout }).catch(async error => {
          const snapshot = await target.evaluate(() => ({
            motion: window.__diag?.().motion, log: window.__log?.().slice(-8),
          }));
          error.message += `\nExpected ${JSON.stringify(expected)}; observed ${JSON.stringify(snapshot)}`;
          throw error;
        });
        const result = await handle.jsonValue();
        await handle.dispose();
        return result;
      };
      const checkDetail = async () => {
        const detail = await target.locator('#gcodeDetail').evaluate(element => {
          const own = element.getBoundingClientRect();
          const canvas = document.getElementById('gcodeCanvas').getBoundingClientRect();
          const style = getComputedStyle(element);
          return { align: style.textAlign, outsideCanvas: own.bottom <= canvas.top,
            insideViewport: own.left >= 0 && own.right <= innerWidth, acceptsEvents: style.pointerEvents !== 'none' };
        });
        assert.deepEqual(detail, { align: 'left', outsideCanvas: true, insideViewport: true, acceptsEvents: false });
      };
      const checkPixels = async (name, checks) => {
        const png = await target.locator('#gcodeCanvas').screenshot({ path: path.join(artifacts, name + '.png'), timeout });
        const result = await target.evaluate(async ({ png, checks }) => {
          const image = new Image();
          image.src = 'data:image/png;base64,' + png;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(image, 0, 0);
          const { camera, buildVolume } = window.__preview;
          return checks.map(({ x, y, red, green }) => {
            const point = new camera.position.constructor(x - buildVolume.x / 2, 0.2, buildVolume.y / 2 - y).project(camera);
            const px = Math.round((point.x + 1) * canvas.width / 2);
            const py = Math.round((1 - point.y) * canvas.height / 2);
            const { data } = ctx.getImageData(px - 3, py - 3, 7, 7);
            let hasRed = false, hasGreen = false;
            for (let i = 0; i < data.length; i += 4) {
              const [r, g, b] = data.subarray(i, i + 3);
              hasRed ||= r > 100 && r > 1.45 * g && r > 1.25 * b;
              hasGreen ||= g > 100 && g > 1.45 * r && g > 1.25 * b;
            }
            return { x, y, red: hasRed, green: hasGreen };
          });
        }, { png: png.toString('base64'), checks });
        assert.deepEqual(result, checks, 'Projected real pixels must contain only deposited filament');
      };
      try {
        await write('Marked deposition and travel', 'RUNNING', {
          layer_num: 1, total_layer_num: 2, mc_percent: 25,
          ams: { ams: [{ id: '0', tray: [{ id: '0', tray_color: 'FF2244FF' }, { id: '1', tray_color: '00E040FF' }] }] },
        });
        await target.goto(view);
        await waitForMotion({ visible: false, state: 'waiting', depositionStart: 1, depositedEnd: 1,
          depositedSegments: 0, partialDeposited: false, reportedLayer: 1 });
        await target.getByText('Waiting for layer timing', { exact: true }).waitFor();
        await checkDetail();

        await setLayer(1, 31_250);
        const red = await waitForMotion({ visible: true, state: 'ready', x: [55, 62], depositionStart: 1, depositedEnd: 1,
          depositedSegments: 0, partialDeposited: true, reportedLayer: 1 });
        await target.getByText('Estimated nozzle position', { exact: true }).waitFor();
        await checkPixels('gcode-deposition-red-partial', [
          { x: 42, y: 70, red: true, green: false },
          { x: 82, y: 70, red: false, green: false },
        ]);
        await target.setViewportSize({ width: 236, height: 248 });
        await checkDetail();
        await target.screenshot({ path: path.join(artifacts, 'gcode-deposition-label-narrow.png'), timeout });
        await target.setViewportSize({ width: 640, height: 640 });

        await setLayer(1, 112_500);
        const travel = await waitForMotion({ visible: true, state: 'ready', x: [120, 130], depositionStart: 1, depositedEnd: 2,
          depositedSegments: 1, partialDeposited: false, reportedLayer: 1 });
        assert.ok(travel.window > red.window, 'Travel crossed a real replay source-window boundary');
        await checkPixels('gcode-deposition-travel', [
          { x: 72, y: 70, red: true, green: false },
          { x: 110, y: 70, red: false, green: false },
        ]);

        await setLayer(1, 193_750);
        const green = await waitForMotion({ visible: true, state: 'ready', x: [183, 190], depositionStart: 1, depositedEnd: 2,
          depositedSegments: 1, partialDeposited: true, reportedLayer: 1 });
        await checkPixels('gcode-deposition-green-partial', [
          { x: 72, y: 70, red: true, green: false },
          { x: 137, y: 70, red: false, green: false },
          { x: 173, y: 70, red: false, green: true },
          { x: 209, y: 70, red: false, green: false },
        ]);
        await setLayer(1, 195_000, false, 'PAUSED');
        await waitForMotion({ visible: false, state: 'paused', depositedEnd: 2, partialDeposited: true });
        await setLayer(1, 200_000);
        const resumed = await waitForMotion({ visible: true, state: 'ready', x: [188, 196], depositedEnd: 2, partialDeposited: true });
        assert.ok(resumed.position[0] > green.position[0]);

        await setLayer(1, 340_000);
        const ended = await waitForMotion({ visible: false, state: 'awaiting-layer', depositionStart: 1, depositedEnd: 3,
          depositedSegments: 2, partialDeposited: false });
        await target.getByText('Waiting for next layer', { exact: true }).waitFor();
        await target.waitForResponse(response => new URL(response.url()).pathname === '/data.json' && response.ok(), { timeout });
        await target.waitForResponse(response => new URL(response.url()).pathname === '/data.json' && response.ok(), { timeout });
        assert.equal((await waitForMotion({ state: 'awaiting-layer', visible: false })).animationDraws, ended.animationDraws);

        await setLayer(2, 17_500);
        await waitForMotion({ visible: true, state: 'ready', x: [229.99, 230.01], depositionStart: 3, depositedEnd: 3,
          partialDeposited: true, reportedLayer: 2 });
        await setLayer(1, 9_000);
        await waitForMotion({ visible: false, state: 'waiting', depositedEnd: 3, reportedLayer: 2 });
        await setLayer(2, 22_500);
        await waitForMotion({ visible: true, state: 'ready', depositedEnd: 3, partialDeposited: true, reportedLayer: 2 });
        assert.equal(count, before + 1, 'Live marker progression, layer timing and viewport reuse one G-code download');
      } finally {
        await target.close();
      }
    }
    await checkMarkedDeposition();
    passed.push('Exact model-layer markers separate same-Z setup and keep two-color partial deposition, travel, pause and late telemetry synchronized');

    async function checkLearnedLayerPace() {
      await page.goto('about:blank');
      mode = 'packed-pace';
      const before = count;
      const target = await context.newPage();
      const view = base + '/widgets/gcode-viz/?debug=1&view=top';
      const timeout = 20_000;
      const priorLayers = [
        { layer: 1, durationMs: 47_900 },
        { layer: 2, durationMs: 48_060 },
        { layer: 3, durationMs: 48_000 },
      ];
      const pace = samples => ({ speedPercent: 100, layerSpeedStable: true, samples });
      const atAge = async (layer, elapsedMs, samples = priorLayers) => {
        await writePacket({ ...print, layer_num: layer,
          _bb_layer_elapsed_ms: elapsedMs, _bb_layer_pace: pace(samples) });
      };
      const waitForPose = async ({ layer, x, y, complete }) => {
        const expectation = { layer, x, y, complete, totalLayers: pacedLayerCount };
        const handle = await target.waitForFunction(({ layer, x, y, complete, totalLayers }) => {
          const motion = window.__diag?.().motion;
          const xyz = motion?.position;
          if (motion?.reportedLayer !== layer || motion.markerLayerCount !== totalLayers ||
              !xyz || !motion.visible || motion.state !== 'ready' || !motion.depositionReady ||
              !motion.partialDeposited || motion.depositedEnd !== complete ||
              Math.abs(xyz[2] - layer * 0.2) > 0.002 ||
              Math.abs(xyz[1] - y) > 0.01 ||
              xyz[0] < x[0] || xyz[0] > x[1]) return false;
          return motion;
        }, expectation, { timeout }).catch(async error => {
          const motion = await target.evaluate(() => window.__diag?.().motion);
          throw new Error(`Expected ${JSON.stringify(expectation)}; observed ${JSON.stringify(motion)}`, { cause: error });
        });
        const motion = await handle.jsonValue();
        await handle.dispose();
        return motion;
      };
      try {
        await attachPackedBrowserProbes(target, { virtualClock: true });
        // The old playback had already exhausted the 16-second nominal
        // motion here. A cold viewer starts on the correct ordered return.
        await write('Measured layer pace', 'RUNNING', { layer_num: 4, total_layer_num: pacedLayerCount,
          _bb_layer_elapsed_ms: 30_000, _bb_layer_advancing: true, _bb_layer_pace: pace(priorLayers) });
        await target.goto(view);
        const middle = await waitForPose({ layer: 4, x: [92, 104], y: 90, complete: 12 });
        assert.equal(middle.depositionStart, 10, 'The setup and three known completed layers are preserved');
        assert.equal(middle.depositedSegments, 2);
        assert.ok(Math.abs(middle.paceFactor - 3) < 0.05, JSON.stringify(middle));
        await target.getByText('Estimated nozzle position', { exact: true }).waitFor();

        // A new packet for the same physical layer arrives well beyond the
        // nominal duration. Preserve ordered motion without looping or
        // adding an arbitrary line that is absent from the file.
        await atAge(4, 36_500);
        const later = await waitForPose({ layer: 4, x: [73, 81], y: 90, complete: 12 });
        assert.ok(later.position[0] < middle.position[0] - 10, 'The third extrusion keeps growing on the actual path');
        assert.equal(later.depositionStart, middle.depositionStart);
        assert.equal(later.depositedSegments, middle.depositedSegments);
        await target.screenshot({ path: path.join(artifacts, 'gcode-measured-layer-pace.png'), timeout });

        // A fresh MQTT snapshot can be newer than the last snapshot and
        // still be behind the display's extrapolation across HTTP polls.
        await target.evaluate(() => { window.__motionClockOffset += 1_800; });
        const extrapolated = await waitForPose({ layer: 4, x: [65, 75], y: 90, complete: 12 });
        const receipt = target.waitForResponse(async response =>
          new URL(response.url()).pathname === '/data.json' && response.ok() &&
          (await response.json()).print._bb_layer_elapsed_ms === 36_600, { timeout });
        await atAge(4, 36_600);
        await receipt;
        await target.waitForTimeout(100);
        const refreshed = await target.evaluate(() => window.__diag().motion);
        assert.ok(refreshed.partialDeposited && refreshed.position[0] <= extrapolated.position[0] + 0.1,
          `A fresh report must not rewind visible deposition: ${extrapolated.position} → ${refreshed.position}`);

        // When even the learned duration and its bounded tail are behind
        // the print, retain the deposited layer without looping the nozzle
        // or showing the next physical layer early.
        await atAge(4, 68_000);
        const exhaustedHandle = await target.waitForFunction(() => {
          const motion = window.__diag?.().motion;
          return motion?.reportedLayer === 4 && motion.state === 'awaiting-layer' &&
            motion.depositedEnd === 13 && motion.depositionReady && motion;
        }, null, { timeout });
        const exhausted = await exhaustedHandle.jsonValue();
        await exhaustedHandle.dispose();
        assert.equal(exhausted.position, null);
        assert.equal(exhausted.partialDeposited, false);
        await target.getByText('Waiting for next layer', { exact: true }).waitFor();

        await atAge(5, 9_000, [...priorLayers, { layer: 4, durationMs: 68_100 }]);
        const next = await waitForPose({ layer: 5, x: [88, 98], y: 70, complete: 13 });
        assert.equal(next.depositionStart, 13, 'Only the actual layer report moves the completed prefix to layer 5');
        assert.equal(next.depositedSegments, 0);
        assert.equal(count, before + 1, 'Pace and actual layer changes reuse the downloaded plate');
        await fs.writeFile(path.join(artifacts, 'gcode-layer-pace-results.json'),
          JSON.stringify({ nominalSeconds: 16, priorLayers, middle, later, extrapolated, refreshed, exhausted, next, httpDownloads: count - before }, null, 2));
      } finally {
        await target.close();
      }
    }
    await checkLearnedLayerPace();
    passed.push('Prior measured physical layers guide late estimated motion and deposition until the actual telemetry layer transition');

    await checkPackedPlate(compactPlate, 'gcode-compact-plate', 45000);
    passed.push('Packed preview animates the estimated nozzle through first, middle and final layers, honors pause and resume, and preserves static geometry over one HTTP transfer');
    if (process.env.BAMBUBOARD_TEST_DENSE_PLATE === '1') {
      await checkPackedPlate(stressPlate, 'gcode-full-dense-plate', 180000);
      passed.push('A 4.2-million-line dense plate renders all 3.44 million exact extrusion segments and 1,475 layers');
    }
    await fs.writeFile(path.join(artifacts, 'gcode-compact-results.json'), JSON.stringify(packedEvidence, null, 2));

    // Disable just the packed parser worker. The worker-independent bounded
    // pipeline must still render exact geometry and decode the chosen path.
    mode = 'packed';
    packedFixture = compactPlate;
    await write('Packed worker unavailable', 'RUNNING', { layer_num: 50, total_layer_num: compactPlate.layers,
      _bb_layer_elapsed_ms: 0, _bb_layer_advancing: true });
    const packedFallback = await context.newPage();
    try {
      await packedFallback.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.__packedWorkerDenied = 0;
        window.Worker = class extends NativeWorker {
          constructor(url, ...args) {
            if (String(url).endsWith('/packed-preview-worker.js')) {
              window.__packedWorkerDenied++;
              throw new Error('Packed worker blocked in fixture');
            }
            super(url, ...args);
          }
        };
      });
      const expected = Math.floor(compactPlate.segments / compactPlate.layers) * 49 + Math.min(49, compactPlate.segments % compactPlate.layers);
      await packedFallback.goto(base + '/widgets/gcode-viz/?debug=1&mode=preview');
      await packedFallback.waitForFunction(expected => {
        const diag = window.__diag?.();
        return diag?.compact?.visibleSegments === expected && diag.compact.staticReady &&
          diag.compact.staticLines >= expected && diag.motion?.layer === 50 &&
          diag.motion.state === 'ready' && diag.motion.visible && diag.motion.position;
      }, expected, { timeout: 45_000 });
      const fallbackMotion = await packedFallback.evaluate(() => window.__diag().motion);
      assert.ok(onRasterMotion(compactPlate, 50, fallbackMotion.position), JSON.stringify(fallbackMotion));
      assert.deepEqual(await packedFallback.evaluate(() => ({
        attempts: window.__packedWorkerDenied, reader: window.__diag().startup?.reader,
      })), { attempts: 1, reader: 'cooperative' });
      assert.equal(await packedFallback.getByText('Estimated nozzle position', { exact: false }).isVisible(), true);
      passed.push('Packed geometry and selected motion remain usable when the packed parser worker is blocked');
    } finally {
      await packedFallback.close();
    }

    async function checkWindowedLayer() {
      await page.goto('about:blank');
      const livePage = await context.newPage();
      let latePage;
      try {
        const timeout = 60_000;
        const job = 'Windowed single layer';
        const viewer = base + '/widgets/gcode-viz/?debug=1&mode=preview';
        const before = count;
        const waitForPlate = target => target.waitForFunction(segments => {
          const packed = window.__diag?.().compact;
          return packed?.visibleSegments === segments && packed.staticReady && packed.staticLines >= segments;
        }, 0, { timeout });
        const waitForPose = async (target, move, exact = false) => {
          const handle = await target.waitForFunction(({ point, exact }) => {
            const motion = window.__diag?.().motion;
            const pos = motion?.position;
            if (motion?.state !== 'ready' || !motion.visible || motion.layer !== 1 || !pos) return false;
            const matchesX = exact ? Math.abs(pos[0] - point[0]) < 0.002 : pos[0] >= 9.998 && pos[0] <= 11.002;
            return matchesX && Math.abs(pos[1] - point[1]) < 0.002 && Math.abs(pos[2] - point[2]) < 0.002 && motion;
          }, { point: windowPoint(move), exact }, { timeout });
          const motion = await handle.jsonValue();
          await handle.dispose();
          assert.equal(motion.layerMoves, windowLayer.moves, 'Travel and extrusion must all contribute actual indexed moves');
          assert.ok(motion.windowMoves > 0 && motion.windowMoves <= 2048, JSON.stringify(motion));
          assert.ok(motion.windows.length > 0 && motion.windows.length <= 2 && motion.windows.includes(motion.window), JSON.stringify(motion));
          assert.ok(motion.bytes > 0 && motion.bytes <= 2 * 2048 * 61, JSON.stringify(motion));
          return motion;
        };
        const finishLookahead = target => target.waitForFunction(() => {
          const motion = window.__diag?.().motion;
          return motion?.windows.length === 2 && motion.pendingWindow === null;
        }, null, { timeout });
        const advanceClock = (target, move) => target.evaluate(move => {
          window.__motionClockOffset = move * 1000;
        }, move);
        const seek = (target, fraction) => target.evaluate(fraction => {
          const slider = document.getElementById('gcodePath');
          slider.value = String(fraction);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }, fraction);

        await attachPackedBrowserProbes(livePage, { virtualClock: true });
        mode = 'packed-window';
        await write(job, 'PAUSED', { layer_num: 1, total_layer_num: 1, mc_percent: 10 });
        const loadingStarted = performance.now();
        await livePage.goto(viewer);
        await waitForPlate(livePage);
        const initialLoadMs = performance.now() - loadingStarted;
        assert.ok(initialLoadMs < 45_000, `Preparing the windowed plate took ${initialLoadMs} ms`);
        const liveStatic = await livePage.evaluate(() => {
          const { motion, compact } = window.__diag();
          const group = window.__preview.scene.getObjectByName('packed-toolpath');
          window.__windowedGeometry = group.children.map(object => ({
            geometry: object.geometry,
            attribute: object.geometry.getAttribute('position'),
            version: object.geometry.getAttribute('position').version,
          }));
          return { staticDraws: motion.staticDraws, visible: motion.visible, layers: compact.layers };
        });
        assert.deepEqual({ visible: liveStatic.visible, layers: liveStatic.layers }, { visible: false, layers: 2 });

        await writePacket({ ...print, gcode_state: 'RUNNING', _bb_layer_elapsed_ms: 0, _bb_layer_advancing: true });
        await waitForPose(livePage, 5);
        const initialHeartbeat = await livePage.evaluate(() => window.__packedHeartbeat);
        assert.ok(initialHeartbeat.loading > 0 && initialHeartbeat.maximumGapMs < 5000, JSON.stringify(initialHeartbeat));
        await advanceClock(livePage, 249800);
        const beforeCeiling = await waitForPose(livePage, 249800);
        await advanceClock(livePage, 250200);
        const afterCeiling = await waitForPose(livePage, 250200);
        assert.ok(afterCeiling.window > beforeCeiling.window, 'A running print must continue into later windows in the same layer');
        await finishLookahead(livePage);

        // Hold a cold window while both the wall-clock playhead and the
        // ordinary printer telemetry continue. Release after it has moved.
        await livePage.evaluate(() => {
          window.__packedLayerGate.armed = true;
          window.__motionClockOffset = 263500 * 1000;
        });
        await livePage.waitForFunction(() => window.__packedLayerGate.blocked &&
          window.__diag()?.motion?.state === 'buffering' && !window.__diag().motion.visible, null, { timeout });
        await livePage.getByText('Buffering nozzle preview', { exact: false }).waitFor();
        const telemetry = await livePage.waitForResponse(response => new URL(response.url()).pathname === '/data.json' && response.ok(), { timeout });
        assert.equal((await telemetry.json()).print._bb_job_id, job);
        await advanceClock(livePage, 264100);
        await livePage.evaluate(() => window.__packedLayerGate.release());
        const recovered = await waitForPose(livePage, 264100);
        assert.ok(recovered.window > afterCeiling.window);
        assert.equal(recovered.staticDraws, liveStatic.staticDraws, 'Motion-only frames must not redraw the plate');
        assert.ok(await livePage.evaluate(() => {
          const group = window.__preview.scene.getObjectByName('packed-toolpath');
          const saved = window.__windowedGeometry;
          return group.children.length === saved.length && group.children.every(({ geometry }, index) =>
            geometry === saved[index].geometry && geometry.getAttribute('position') === saved[index].attribute &&
            geometry.getAttribute('position').version === saved[index].version);
        }), 'The same packed GPU geometry stays resident throughout playback and buffering');
        assert.equal(count, before + 1);

        // A new paused viewer jumps directly to a late window. Its first
        // decode should read only a few source blocks, not walk from zero.
        await writePacket({ ...print, gcode_state: 'PAUSED', _bb_layer_elapsed_ms: undefined, _bb_layer_advancing: false });
        latePage = await context.newPage();
        await attachPackedBrowserProbes(latePage);
        await latePage.goto(viewer);
        await waitForPlate(latePage);
        const readsBeforeSeek = await latePage.evaluate(() => window.__packedLayerGate.reads);
        assert.deepEqual(await latePage.evaluate(() => window.__diag().motion.windows), []);
        const seekingStarted = performance.now();
        await seek(latePage, 980);
        const directSeek = await waitForPose(latePage, 264600, true);
        const directSeekMs = performance.now() - seekingStarted;
        assert.ok(directSeekMs < 10_000, `Direct seeking took ${directSeekMs} ms`);
        await finishLookahead(latePage);
        const readsAfterSeek = await latePage.evaluate(() => window.__packedLayerGate.reads);
        assert.ok(readsAfterSeek - readsBeforeSeek >= 1 && readsAfterSeek - readsBeforeSeek <= 6, 'A late seek may only read the requested window and lookahead');
        assert.ok(directSeek.window >= recovered.window);

        // Supersede an in-flight rewind with a second rewind. The old
        // response is released afterwards to check it cannot publish.
        await latePage.evaluate(() => { window.__packedLayerGate.armed = true; });
        await seek(latePage, 500);
        await latePage.waitForFunction(() => window.__packedLayerGate.blocked &&
          window.__diag()?.motion?.state === 'buffering', null, { timeout });
        await seek(latePage, 47);
        const backwardSeek = await waitForPose(latePage, 12690, true);
        assert.ok(backwardSeek.window < directSeek.window);
        await latePage.waitForFunction(() => window.__packedLayerGate.canceled === 1, null, { timeout });
        await latePage.evaluate(() => window.__packedLayerGate.release());
        await latePage.waitForTimeout(150);
        assert.deepEqual(await latePage.evaluate(() => window.__diag().motion.position), backwardSeek.position);
        await latePage.getByText('Toolpath replay', { exact: true }).waitFor();
        assert.equal(count, before + 2, 'Each viewer downloads the plate once across all windows and seeks');

        const evidence = {
          moves: windowLayer.moves, extrusionSegments: windowLayerSegments, sourceBytes: windowByteLength(),
          beforeCeiling, afterCeiling, recovered, directSeek, backwardSeek,
          initialLoadMs, initialHeartbeat, directSeekMs, lateSourceReads: readsAfterSeek - readsBeforeSeek,
          httpDownloads: count - before, staticDrawsDuringLivePlayback: recovered.staticDraws - liveStatic.staticDraws,
        };
        await fs.writeFile(path.join(artifacts, 'gcode-motion-window-results.json'), JSON.stringify(evidence, null, 2));
      } finally {
        await latePage?.close();
        await livePage.close();
      }
    }
    await checkWindowedLayer();
    passed.push('Intra-layer motion windows animate a 270,000-move layer across the old ceiling and recover cold live and backward seeks without redrawing the plate');

    packedFixture = compactPlate;
    mode = 'packed-held';
    await write('Canceled packed job', 'RUNNING', { layer_num: 1, total_layer_num: compactPlate.layers });
    const canceledPackedPage = await context.newPage();
    try {
      await canceledPackedPage.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.__packedWorkers = { started: 0, terminated: 0 };
        window.Worker = class extends NativeWorker {
          constructor(url, ...args) {
            super(url, ...args);
            this.packedPreviewWorker = String(url).endsWith('/packed-preview-worker.js');
            if (this.packedPreviewWorker) window.__packedWorkers.started++;
          }
          terminate() {
            if (this.packedPreviewWorker) window.__packedWorkers.terminated++;
            return super.terminate();
          }
        };
      });
      await canceledPackedPage.goto(base + '/widgets/gcode-viz/?debug=1&mode=preview');
      await until(() => packedHold?.blocked, 45000);
      await canceledPackedPage.waitForFunction(() => window.__packedWorkers.started === 1);
      await canceledPackedPage.locator('#gcodeCancel').click();
      await until(() => packedHold.closed, 45000);
      await canceledPackedPage.getByText(/Toolpath loading canceled/).waitFor();
      assert.deepEqual(await canceledPackedPage.evaluate(() => {
        const { motion, compact } = window.__diag();
        return { motion, compact, nozzle: window.__nozzle.visible, workers: window.__packedWorkers };
      }), { motion: null, compact: null, nozzle: false, workers: { started: 1, terminated: 1 } });
      passed.push('Cancel during dense streaming closes the download without installing stale geometry or moving the nozzle');
    } finally {
      await canceledPackedPage.close();
    }

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
