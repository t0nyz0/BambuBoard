// Full browser flow against temporary data, accessed over loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { devDependencies } = require('../package.json');
const { mergePrint } = require('../src/lib/printTelemetry');
const { h3cAmsPrint } = require('./fixtures/h3c-ams');
const { checkCameraRecovery } = require('./camera-browser-fixture');
const root = path.resolve(__dirname, '..');
const fixtureGcode = 'G90\nM82\n;LAYER:0\nG1 X10 Y10 Z0.2 E1\nG1 X80 Y10 E2\nG1 X80 Y80 E3\nG1 X10 Y80 E4\nG1 X10 Y10 E5\n;LAYER:1\nG1 Z0.4\nG1 X80 Y10 E6\nG1 X80 Y80 E7\nG1 X10 Y80 E8\n';

async function checkLiveWidgetReuse(context, base) {
  const page = await context.newPage();
  const toolpath = { name: 'Live toolpath fixture', id: 'browser_source', settings: { url: `${base}/widgets/gcode-viz/?debug=1&mode=preview&layers=1&view=front&zoom=110`, width: 280, height: 240 } };
  const status = { name: 'Live status fixture', id: 'browser_source', settings: { url: `${base}/version?v=1`, width: 100, height: 100 } };
  const camera = { name: 'Live camera fixture', id: 'ffmpeg_source', settings: { width: 320, height: 180 } };
  const items = [toolpath, status, camera].map((src, id) => ({ id, name: src.name, pos: { x: 0, y: 0 }, align: 5 }));
  const scene = { id: 'scene', name: 'Live fixture', settings: { items } };
  const publication = { resolution: { x: 640, y: 480 }, sources: [toolpath, status, camera, scene] };
  let revision = 1;
  let toolpathRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/gcode/current') toolpathRequests++;
  });
  try {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const fetchNormally = window.fetch.bind(window);
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = ms => timeout(Math.min(ms, 300));
      window.fetch = (url, options) => {
        if (url !== window.stalledPublicationFixture) return fetchNormally(url, options);
        window.stalledPublicationFixture = null;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            window.timedOutPublicationFixture = url;
            reject(options.signal.reason);
          }, { once: true });
        });
      };
    });
    await page.route(`${base}/api/obs/active`, route => route.fulfill({ json: { slug: 'live-fixture', updatedAt: revision } }));
    await page.route(`${base}/api/obs/published`, route => route.fulfill({ json: publication }));
    await page.goto(base + '/live');
    await page.locator('iframe').nth(2).waitFor({ state: 'attached' });
    const toolpathElement = await page.locator('iframe[title="Live toolpath fixture"]').elementHandle();
    const toolpathFrame = await toolpathElement.contentFrame();
    await toolpathFrame.waitForFunction(() => window.__log?.().some(line => line.includes('loadGcode OK')));
    assert.equal(new URL(toolpathFrame.url()).searchParams.has('mode'), false, 'Live cannot inherit a preview-only URL option');
    assert.equal(new URL(toolpathFrame.url()).searchParams.has('layers'), false, 'Live must display the complete printable job');
    assert.equal(await toolpathFrame.locator('#gcodeDebug').isVisible(), false);
    assert.equal(await toolpathFrame.evaluate(() => window.__diag().orbit.view), 'front');
    assert.equal(toolpathRequests, 1);
    await page.waitForFunction(() => [...document.querySelectorAll('#stage iframe')].every(frame =>
      frame.contentDocument?.readyState === 'complete' && frame.contentDocument.URL === frame.src));
    await page.evaluate(() => {
      window.liveFixtureDocuments = Object.fromEntries([...document.querySelectorAll('#stage iframe')].map(frame => [frame.title, frame.contentDocument]));
    });

    const toolpathItem = items[0];
    toolpathItem.pos.x = 35;
    toolpathItem.scale = { x: 1.5, y: 1 };
    items.push(items.shift());
    toolpath.settings.width = 360;
    toolpath.settings.url = `${base}/widgets/gcode-viz/?debug=1&view=top&zoom=130`;
    toolpath.settings.css = 'body { --bb-live-fixture: applied; }';
    status.settings.url = `${base}/version?v=2`;
    const statusReloaded = page.waitForResponse(`${base}/version?v=2`);
    revision++;
    await statusReloaded;
    await toolpathFrame.waitForFunction(() => window.__diag()?.orbit.view === 'top' && window.__diag()?.orbit.zoom === 130);
    assert.equal(await toolpathFrame.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bb-live-fixture').trim()), 'applied');
    assert.deepEqual(await toolpathElement.evaluate(frame => ({ left: frame.parentElement.style.left, width: frame.parentElement.style.width, zIndex: frame.parentElement.style.zIndex })), { left: '35px', width: '540px', zIndex: '2' });
    assert.equal(await page.evaluate(() => {
      const rect = document.getElementById('stage').getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width * 0.1, rect.top + rect.height * 0.1)?.title;
    }), 'Live toolpath fixture', 'OBS order must be preserved when stable frames stay in place');
    assert.deepEqual(await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#stage iframe')].map(frame => [frame.title, window.liveFixtureDocuments[frame.title] === frame.contentDocument]))), {
      'Live toolpath fixture': true, 'Live camera': true, 'Live status fixture': false,
    });
    assert.equal(toolpathRequests, 1, 'Publishing another widget must not request the unchanged toolpath again');

    toolpath.settings.url = `${base}/widgets/gcode-viz/?debug=1`;
    delete toolpath.settings.css;
    revision++;
    await toolpathFrame.waitForFunction(() => window.__diag()?.orbit.view === 'angled' && window.__diag()?.orbit.zoom === 100);
    assert.equal(await toolpathFrame.evaluate(() => document.getElementById('bb-live-obs-css')), null);
    assert.equal(toolpathRequests, 1, 'Resetting camera options must keep the rendered toolpath');

    for (const endpoint of ['/api/obs/active', '/api/obs/published']) {
      await page.evaluate(path => { window.stalledPublicationFixture = path; }, endpoint);
      toolpathItem.pos.x += 10;
      revision++;
      await page.waitForFunction(path => window.timedOutPublicationFixture === path, endpoint);
      assert.equal(await page.locator('#live-msg').isVisible(), false, 'A stalled refresh must leave the last render visible');
      await page.waitForFunction(left => document.querySelector('iframe[title="Live toolpath fixture"]')?.parentElement.style.left === left, `${toolpathItem.pos.x}px`);
      assert.equal(await toolpathElement.evaluate(frame => window.liveFixtureDocuments[frame.title] === frame.contentDocument), true);
      assert.equal(toolpathRequests, 1, 'Recovery must keep the existing toolpath');
    }
  } finally {
    await page.close();
  }
}

async function checkCalibrationWidgets(context, base, data, telemetry) {
  const pages = await Promise.all(Array.from({ length: 7 }, () => context.newPage()));
  const [info, progress, notes, model, live, obs, operator] = pages;
  const previewPages = [live, obs, operator];
  const url = base + '/widgets/gcode-viz/?debug=1';
  const dataPath = path.join(data, 'data.json'), notePath = path.join(data, 'note.json');
  const originalTelemetry = await fs.readFile(dataPath);
  const originalNote = await fs.readFile(notePath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const autoNote = JSON.stringify({ text: 'Ordinary fixture footer', manual: false });
  let snapshot = telemetry;
  const seed = async print => {
    snapshot = { print, _bb_received_at: Date.now() };
    const pending = dataPath + '.calibration-fixture';
    await fs.writeFile(pending, JSON.stringify(snapshot));
    await fs.rename(pending, dataPath);
  };
  const matches = (page, selector, hasText) => page.locator(selector).filter({ hasText }).waitFor();
  const routeData = route => route.fulfill({ headers: { 'X-BambuBoard-Printer-Connection': 'online' }, json: snapshot });
  const toolpathSource = { name: 'Calibration preview', id: 'browser_source', settings: { url: url + '&mode=preview', width: 400, height: 360 } };
  const scene = { id: 'scene', name: 'Calibration fixture', settings: { items: [{ name: toolpathSource.name, pos: { x: 0, y: 0 }, align: 5 }] } };
  const liveWidget = live.frameLocator('iframe[title="Calibration preview"]');
  const widgetViewers = [liveWidget, obs, operator];
  const publicViewers = [liveWidget, obs];
  const fetchCounts = new Map(previewPages.map(page => [page, 0]));
  const waitForCanvas = () => Promise.all(widgetViewers.map(async viewer => {
    await viewer.locator('#gcodeOverlay').waitFor({ state: 'hidden' });
    await viewer.locator('#gcodeCanvas').waitFor();
  }));
  const assertFetches = (expected, message) => assert.deepEqual([...fetchCounts.values()], [expected, expected, expected], message);

  async function showCalibration(print, fetches) {
    await seed(print);
    await Promise.all([matches(info, '#printModelName', /^Calibrating$/), matches(progress, '#printStatus', /^Calibrating$/),
      matches(notes, '#noteDisplay', /^Calibrating$/), model.locator('#modelImage').waitFor({ state: 'hidden' }),
      ...widgetViewers.map(viewer => viewer.getByText('Calibrating', { exact: true }).waitFor())]);
    for (const selector of ['#printCurrentLayer', '#printRemaining', '#printETA']) assert.equal(await info.locator(selector).textContent(), '—');
    for (const viewer of widgetViewers) {
      assert.equal(await viewer.locator('#gcodeCanvas').isVisible(), false);
      assert.equal(await viewer.locator('#gcodeRecovery').isVisible(), false);
    }
    assert.equal(await model.locator('#modelImage').getAttribute('src'), null);
    assert.equal(await fs.readFile(notePath, 'utf8'), autoNote, 'Calibration is a transient footer label');
    assertFetches(fetches, 'Neither public nor operator viewers fetch built-in calibration jobs');
  }

  try {
    await seed(telemetry.print);
    await fs.writeFile(notePath, autoNote);
    await Promise.all([info, progress, model, ...previewPages].map(page => page.route(base + '/data.json', routeData)));
    await model.route(base + '/login-and-fetch-image', route => route.fulfill({ json: { imageUrl: base + '/assets/logo-h2d.png' } }));
    await live.route(base + '/api/obs/active', route => route.fulfill({ json: { slug: 'calibration-fixture', updatedAt: 1 } }));
    await live.route(base + '/api/obs/published', route => route.fulfill({ json: { resolution: { x: 640, y: 480 }, sources: [toolpathSource, scene] } }));
    for (const page of previewPages) page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/gcode/current') fetchCounts.set(page, fetchCounts.get(page) + 1);
    });
    await Promise.all([info.goto(base + '/widgets/print-info/'), progress.goto(base + '/widgets/progress-info/'),
      notes.goto(base + '/widgets/notes/'), model.goto(base + '/widgets/model-image/'), live.goto(base + '/live'),
      obs.goto(url), operator.goto(url + '&mode=preview')]);
    await matches(info, '#printModelName', /^Fixture print$/);
    await matches(progress, '#printStatus', /47%/);
    await matches(notes, '#noteDisplay', /^Ordinary fixture footer$/);
    await model.locator('#modelImage[src$="/assets/logo-h2d.png"]').waitFor();
    await waitForCanvas();
    assertFetches(1);

    await seed({ ...telemetry.print, stg_cur: 25 });
    await matches(progress, '#printStatus', /^Calibrating motor noise.*47%$/);
    await matches(info, '#printModelName', /^Fixture print$/);
    await waitForCanvas();
    assertFetches(1, 'A normal print keeps its existing toolpath while it calibrates inline');

    const name = 'auto_cali_for_user_param.gcode';
    const calibration = { ...telemetry.print, subtask_name: name, layer_num: 0, stg_cur: 25, mc_percent: 16 };
    await showCalibration({ ...calibration, _bb_job_id: 'H2D built-in fixture', gcode_file: '/usr/etc/print/' + name }, 1);
    await seed({ ...telemetry.print, _bb_job_id: 'ordinary after H2D calibration' });
    await waitForCanvas();
    await model.locator('#modelImage[src$="/assets/logo-h2d.png"]').waitFor();
    assertFetches(2);
    await showCalibration(mergePrint({}, { ...calibration, print_type: 'system', gcode_file: name }), 2);

    await fs.writeFile(notePath, JSON.stringify({ text: 'My manual footer', manual: true }));
    await matches(notes, '#noteDisplay', /^My manual footer$/);
    await Promise.all(previewPages.map(page => page.route('**/api/gcode/current*', route => route.fulfill({
      status: 502, json: { code: 'FILE_NOT_FOUND', retryable: false },
    }))));
    await seed(mergePrint(snapshot.print, { ...telemetry.print, subtask_name: name,
      print_type: 'local', gcode_file: name, gcode_state: 'FINISH', mc_percent: 100 }));
    await matches(info, '#printModelName', /^auto_cali_for_user_param\.gcode$/);
    await matches(progress, '#printStatus', /Print Complete/);
    await model.locator('#modelImage[src$="/assets/logo-h2d.png"]').waitFor();
    await Promise.all(publicViewers.map(viewer => viewer.getByText('Print preview unavailable.', { exact: true }).waitFor()));
    for (const viewer of publicViewers) {
      assert.equal(await viewer.locator('#gcodeRecovery').isVisible(), false);
      assert.equal(await viewer.locator('#gcodeLog').isVisible(), false);
      assert.equal(await viewer.locator('#gcodeDebug').isVisible(), false);
    }
    await operator.getByRole('button', { name: 'Retry now', exact: true }).waitFor();
    assert.equal(await operator.getByRole('button', { name: 'Download diagnostics', exact: true }).isVisible(), true);
    assert.equal(await operator.getByRole('button', { name: 'Load sliced file', exact: true }).isEnabled(), true);
    assertFetches(3, 'An identically named bare user file still follows the ordinary transfer path');
    await matches(notes, '#noteDisplay', /^My manual footer$/);
  } finally {
    await Promise.all(pages.map(page => page.close()));
    await fs.writeFile(dataPath, originalTelemetry);
    if (originalNote) await fs.writeFile(notePath, originalNote);
    else await fs.rm(notePath, { force: true });
  }
}

async function checkTelemetryFreshness(context, base, telemetry) {
  const progress = await context.newPage();
  const bed = await context.newPage();
  const legacyAms = await context.newPage();
  const originalAms = { id: '0', temp: '28', humidity: '4', tray: [
    { id: '0', tray_type: 'PLA', tray_sub_brands: 'Original PLA', tray_color: '51A34FFF', remain: 41 },
  ] };
  const fullPrint = { ...telemetry.print, ams: { ams: [originalAms] } };
  const firstResponse = Promise.withResolvers();
  let connection = 'online';
  let snapshot = { print: fullPrint, _bb_received_at: Date.now() };
  const respond = async route => {
    await firstResponse.promise;
    await route.fulfill({ headers: { 'X-BambuBoard-Printer-Connection': connection }, json: snapshot });
  };
  const progressStatus = progress.locator('#printStatus');
  const bedStatus = bed.getByRole('status');
  const amsStatus = legacyAms.getByRole('status');
  const bar = progress.locator('#printProgressBar');
  const temperature = bed.locator('#bedCurrentTempC');
  const amsMaterial = legacyAms.locator('#tray1Material');
  try {
    await progress.route(base + '/data.json', respond);
    await bed.route(base + '/data.json', respond);
    await legacyAms.route(base + '/data.json', respond);
    await progress.goto(base + '/widgets/progress-info/', { waitUntil: 'domcontentloaded' });
    await progressStatus.filter({ hasText: 'Loading printer data' }).waitFor();
    firstResponse.resolve();
    await progressStatus.filter({ hasText: '47%' }).waitFor();
    await bed.goto(base + '/widgets/bed-temp/');
    await temperature.filter({ hasText: /^60$/ }).waitFor();
    await legacyAms.goto(base + '/widgets/ams2/');
    await amsMaterial.filter({ hasText: /^Original PLA$/ }).waitFor();

    connection = 'offline';
    await progressStatus.filter({ hasText: 'Printer offline' }).waitFor();
    await bedStatus.filter({ hasText: 'Printer offline' }).waitFor();
    await amsStatus.filter({ hasText: 'Printer offline' }).waitFor();
    assert.equal(await temperature.isVisible(), false);
    assert.equal(await amsMaterial.isVisible(), false);
    assert.equal(await bar.evaluate(node => node.style.width), '0px');

    connection = 'online';
    snapshot = { print: { gcode_state: 'RUNNING' }, _bb_received_at: Date.now() };
    await progressStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    await bedStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    await amsStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    assert.equal(await temperature.isVisible(), false);
    assert.equal(await amsMaterial.isVisible(), false);
    assert.equal(await bar.evaluate(node => node.style.width), '0px');

    snapshot = { print: { ...snapshot.print, bed_temper: 62 }, _bb_received_at: Date.now() };
    await temperature.filter({ hasText: /^62$/ }).waitFor();
    assert.equal(await bed.locator('#bedTargetTempC').innerText(), '—');
    assert.equal(await amsMaterial.isVisible(), false);
    assert.match(await progressStatus.innerText(), /Waiting for printer data/);

    const currentAms = { ...originalAms, tray: [{ ...originalAms.tray[0], tray_sub_brands: 'Current PLA' }] };
    snapshot = { print: { ...fullPrint, mc_percent: 0, bed_temper: 62, ams: { ams: [currentAms] } }, _bb_received_at: Date.now() };
    await progressStatus.filter({ hasText: '0%' }).waitFor();
    await amsMaterial.filter({ hasText: /^Current PLA$/ }).waitFor();

    connection = 'waiting';
    await progressStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    await bedStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    await amsStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    assert.equal(await amsMaterial.isVisible(), false);

    connection = 'online';
    const otherAms = { ...originalAms, id: '1', tray: [{ ...originalAms.tray[0], tray_sub_brands: 'Different AMS' }] };
    snapshot = { ...snapshot, print: { ...snapshot.print, mc_percent: 53, ams: { ams: [otherAms] } }, _bb_received_at: Date.now() };
    await progressStatus.filter({ hasText: '53%' }).waitFor();
    await temperature.filter({ hasText: /^62$/ }).waitFor();
    assert.equal(await amsMaterial.isVisible(), false);

    snapshot = { ...snapshot, _bb_received_at: Date.now() - 61_000 };
    await progressStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    await bedStatus.filter({ hasText: 'Waiting for printer data' }).waitFor();
    assert.equal(await temperature.isVisible(), false);
  } finally {
    firstResponse.resolve();
    await progress.close();
    await bed.close();
    await legacyAms.close();
  }
}

async function checkAms3h(context, base, artifactDir) {
  const page = await context.newPage();
  let print = mergePrint({}, h3cAmsPrint());
  try {
    await page.setViewportSize({ width: 400, height: 460 });
    await page.route(base + '/data.json', route => route.fulfill({ json: { print } }));
    await page.goto(base + '/widgets/ams/');
    await page.getByRole('heading', { name: 'AMS 3H' }).waitFor();
    const trays = page.locator('.ams-3h-tray');
    const zones = page.locator('.ams-3h-zone');
    assert.equal(await trays.count(), 9);
    assert.equal(await trays.nth(8).locator('.ams-3h-tray-state').innerText(), 'Active');
    assert.equal(await trays.nth(7).locator('.ams-3h-tray-state').innerText(), 'Next');
    assert.equal(await trays.nth(7).locator('.ams-3h-material').innerText(), 'TPU 2.85 mm');
    assert.match(await zones.first().innerText(), /28\.2°C[\s\S]*24% RH[\s\S]*Trays 6, 8[\s\S]*Drying · 1h 13m/);
    assert.match(await zones.last().innerText(), /27\.7°C[\s\S]*33% RH[\s\S]*Trays 1, 2, 3, 4, 5, 7, 9/);
    assert.equal(await zones.last().locator('.ams-3h-zone-time').count(), 0);
    await page.evaluate(() => document.fonts.ready);
    const bounds = await trays.last().boundingBox();
    assert.ok(bounds && bounds.y + bounds.height <= 460 && bounds.x + bounds.width <= 400,
      `all nine trays fit in the widget’s 400×460 viewport: ${JSON.stringify(bounds)}`);
    await page.screenshot({ path: path.join(artifactDir, 'ams-3h-400.png') });

    print = mergePrint(print, {
      ams: { ams: [{ id: '32', zone_info: [{ zone_id: 0, dry_time: 0 }] }] },
      device: { extruder: { info: [{ id: 0, snow: 248 << 8, star: 248 << 8 }] } },
    });
    await page.waitForFunction(() => document.querySelector('.ams-3h-tray.is-active .ams-3h-slot-number')?.textContent === '#8'
      && document.querySelector('.ams-3h-zone-time').hidden);
    assert.match(await zones.last().innerText(), /33% RH/);
    print = mergePrint(print, { vir_slot: [{ id: '248', state: 1 }] });
    await page.waitForFunction(() => document.querySelectorAll('.ams-3h-material')[7]?.textContent === 'Empty');
    assert.equal(await page.locator('.ams-3h-tray.is-active').count(), 0);

    await page.goto(base + '/widgets/ams/?ams=0');
    await page.locator('#tray1Material').filter({ hasText: /^PETG$/ }).waitFor();
    assert.equal(await page.locator('.ams-3h').isVisible(), false);
    assert.equal(await page.locator('.ams-container .element:visible').count(), 4);

    const first = print.ams.ams.find(unit => unit.id === '0');
    const second = { ...first, id: '1', tray: [{ ...first.tray[0], tray_sub_brands: 'Second unit PLA' }] };
    print = { gcode_state: 'RUNNING', ams: { ams: [first] } };
    await page.goto(base + '/widgets/ams/');
    await page.locator('#tray1Material').filter({ hasText: /^PETG$/ }).waitFor();
    assert.equal(await page.locator('#ams-unavailable').isVisible(), false);

    print = { ...print, ams: { ams: [first, second] } };
    await page.locator('#tray1Material').filter({ hasText: /^Second unit PLA$/ }).waitFor();
    await page.goto(base + '/widgets/ams/?ams=0');
    await page.locator('#tray1Material').filter({ hasText: /^PETG$/ }).waitFor();

    await page.goto(base + '/widgets/ams/?ams=7');
    await page.getByRole('status').filter({ hasText: 'Selected AMS unit unavailable' }).waitFor();
    assert.equal(await page.locator('#amsCurrentTempC').isVisible(), false);
    assert.equal(await page.locator('#tray1Material').isVisible(), false);
  } finally {
    await page.close();
  }
}

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
    // Credential status is visible locally without exposing the saved value.
    const localCredentials = await fetch(base + '/api/printer-credentials', { headers: { Origin: base } });
    assert.equal(localCredentials.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await localCredentials.json(), { accessCode: '', accessCodeSet: true });
    for (const pathname of ['/settings', '/api/settings']) {
      const settings = await fetch(base + pathname).then(res => res.json());
      assert.equal(settings.printer.accessCode, '');
      assert.equal(settings.printer.accessCodeSet, true);
    }
    const unrelatedOrigin = { Origin: 'https://unrelated.example.test' };
    for (const pathname of ['/api/printer-credentials', '/auth/token']) {
      const result = await fetch(base + pathname, { headers: unrelatedOrigin });
      assert.equal(result.status, 403);
      assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
    }
    const unrelatedNote = await fetch(base + '/api/note', { method: 'PUT', headers: unrelatedOrigin });
    assert.equal(unrelatedNote.status, 403);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' });
    // Toolpath data is a sample, never a request to a physical printer.
    await context.route('**/api/gcode/current*', route => route.fulfill({ contentType: 'text/plain', body: fixtureGcode }));
    // This suite seeds an isolated snapshot in lieu of an MQTT printer.
    await context.route(base + '/data.json', route => route.fulfill({ json: telemetry }));
    const errors = [], external = new Set();
    let credentialReads = 0;
    context.on('page', page => page.on('pageerror', e => errors.push(e.stack || e.message)));
    context.on('request', request => {
      if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.add(request.url());
      if (new URL(request.url()).pathname === '/api/printer-credentials') credentialReads++;
    });
    const cameraSample = execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '1', '-c:v', 'mpeg1video', '-f', 'mpegts', 'pipe:1'], { timeout: 10000 });
    await context.route('**/assets/camera-fixture.ts*', route => route.fulfill({ contentType: 'video/mp2t', headers: { 'Content-Length': String(cameraSample.length) }, body: cameraSample }));
    const page = await context.newPage();
    await page.goto(base + '/scene-editor');
    await page.waitForSelector('.scene-item');
    await page.evaluate(() => document.fonts.ready);
    const templates = await fetch(base + '/api/obs/templates').then(r => r.json());
    assert.ok(templates.length > 0, 'Built-in layouts are available');
    for (const { slug } of templates) {
      await Promise.all([
        page.waitForResponse(base + '/api/obs/templates/' + slug + '/raw'),
        page.locator('#loader').selectOption('tpl:' + slug),
      ]);
      await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'New draft');
      await page.locator('#canvas iframe[src*="/widgets/"]').first().waitFor({ state: 'attached' });
      assert.equal(await page.getByText('Unsupported browser source URL', { exact: true }).count(), 0, slug);
    }
    await page.reload();
    await page.waitForSelector('.scene-item');
    assert.equal(await page.locator('.bb-logo').getAttribute('src'), '/assets/bambuboard-prism.svg');
    assert.equal(await page.locator('#bb-stepper').isVisible(), false);
    assert.equal(await page.locator('#draft-state').innerText(), 'New draft');
    await page.locator('#draft-name').fill('Studio fixture');
    await page.locator('#save-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved');
    const studioDraft = (await fetch(base + '/api/obs/scenes').then(r => r.json())).find(scene => scene.name === 'Studio fixture');
    assert.ok(studioDraft?.slug && studioDraft.slug !== studioDraft.name);
    assert.equal((await fetch(base + '/api/obs/active').then(r => r.json())).slug, null);
    await page.locator('#golive-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved · Live');
    const published = await fetch(base + '/api/obs/published').then(r => r.json());
    const publishedLayout = await context.newPage();
    await publishedLayout.goto(base + '/live');
    await publishedLayout.locator('.live-item iframe[src*="/widgets/"]').first().waitFor({ state: 'attached' });
    await publishedLayout.close();
    // Change geometry using the real inspector and save without publishing.
    await page.locator('.layer-row .lr-name').first().click();
    await page.locator('#insp-x').fill('42');
    await page.locator('#insp-x').dispatchEvent('change');
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes');
    await page.locator('#save-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved');
    assert.deepEqual(await fetch(base + '/api/obs/published').then(r => r.json()), published);
    await page.reload(); await page.waitForSelector('.scene-item');
    assert.equal(await page.locator('#loader').inputValue(), `scn:${studioDraft.slug}`);
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
    const obsRoutes = /\/api\/obs\/(active|single-source)$/;
    const publicHost = 'obs-fixture.example.test';
    const publicUrl = `https://${publicHost}`;
    await page.route(obsRoutes, route => route.continue({
      headers: { ...route.request().headers(), 'x-forwarded-host': publicHost, 'x-forwarded-proto': 'https' },
    }));
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(base + '/');
    await page.waitForFunction(() => document.getElementById('publication-state').textContent === 'Published');
    assert.equal(await page.locator('#youtube-details').getAttribute('open'), null);
    const order = await page.evaluate(() => document.querySelector('.preview-card').getBoundingClientRect().top < document.querySelector('.obs-card').getBoundingClientRect().top && document.querySelector('.obs-card').getBoundingClientRect().top < document.querySelector('.youtube-section').getBoundingClientRect().top);
    assert.ok(order);
    const iframe = page.frameLocator('#live-frame');
    await iframe.locator('.live-item').first().waitFor();
    assert.equal(await page.locator('#live-frame').getAttribute('src'), '/live');
    assert.equal(await page.locator('#live-url').inputValue(), publicUrl + '/live');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await page.locator('#copy-url').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), publicUrl + '/live');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-obs').click()]);
    const sceneExport = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(sceneExport.sources[0].settings.url, publicUrl + '/live');
    assert.equal(sceneExport.sources[0].settings.width, published.resolution.x);
    await page.unroute(obsRoutes);
    // Test HTTP LAN feature detection with the real document, without capture.
    await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
    await page.reload(); await page.locator('#youtube-details').evaluate(node => { node.open = true; });
    await page.waitForFunction(() => !document.getElementById('yt-mode').disabled);
    await page.locator('#yt-mode').selectOption('browser');
    assert.match(await page.locator('#yt-support').innerText(), /HTTPS or localhost/);
    assert.equal(await page.locator('#yt-start').isEnabled(), false);
    await page.goto(base + '/setup'); await page.waitForFunction(() => document.getElementById('p-name').value === 'Demo H2D');
    const access = page.locator('#p-ac'), reveal = page.locator('#show-ac');
    assert.equal(await access.inputValue(), '');
    assert.equal(await reveal.isDisabled(), true);
    assert.match(await page.locator('#p-ac-status').innerText(), /Saved/);
    await access.fill('typed-fixture');
    await reveal.click();
    assert.equal(await access.getAttribute('type'), 'text');
    await access.fill('');
    assert.equal(await access.getAttribute('type'), 'password');

    const connectionChecks = [];
    const testConnectionUrl = base + '/api/test-connection';
    await page.route(testConnectionUrl, route => {
      connectionChecks.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    const gcodeChecks = [];
    const testGcodeUrl = base + '/api/test-gcode-connection';
    const testGcode = page.getByRole('button', { name: 'Test G-code connection' });
    const gcodeResult = page.locator('#test-gcode-result');
    await page.route(testGcodeUrl, route => {
      gcodeChecks.push({ method: route.request().method(), body: route.request().postDataJSON() });
      return gcodeChecks.length === 1 ? route.fulfill({ json: { ok: true, message: 'Secure G-code file access is available.' } })
        : route.fulfill({ status: 503, json: { ok: false, error: 'The printer reports that file access is busy.' } });
    });
    assert.equal(gcodeChecks.length, 0, 'Setup must not test FTPS automatically');
    const address = page.locator('#p-url'), savedAddress = await address.inputValue();
    await address.fill('printer-replacement.test');
    assert.equal(await testGcode.isDisabled(), true, 'Save changed printer settings before probing FTPS');
    assert.match(await page.locator('#test-gcode-hint').innerText(), /Save the printer changes/);
    await page.locator('#test-btn').click();
    assert.match(await page.locator('#test-result').innerText(), /Enter the LAN access code/);
    assert.equal(connectionChecks.length, 0);
    await address.fill(savedAddress);
    await page.locator('#test-btn').click();
    await page.waitForFunction(() => document.getElementById('test-result').textContent.includes('Connection test passed'));
    assert.equal(connectionChecks[0].accessCode, '');
    await page.unroute(testConnectionUrl);
    await testGcode.click();
    await gcodeResult.filter({ hasText: 'Secure G-code file access is available.' }).waitFor();
    await testGcode.click();
    await gcodeResult.filter({ hasText: 'The printer reports that file access is busy.' }).waitFor();
    assert.deepEqual(gcodeChecks, [{ method: 'POST', body: {} }, { method: 'POST', body: {} }]);
    await page.unroute(testGcodeUrl);
    assert.equal(credentialReads, 0, 'Setup should not call the legacy credentials endpoint');

    await page.locator('.display-preferences > summary').click();
    const checked = await page.locator('#fan-pct').getAttribute('aria-checked');
    await page.locator('#fan-pct').focus(); await page.keyboard.press('Space');
    assert.notEqual(await page.locator('#fan-pct').getAttribute('aria-checked'), checked);
    await page.locator('#save-btn').click(); await page.waitForSelector('.toast');
    const saved = JSON.parse(await fs.readFile(path.join(data, 'config.json'), 'utf8'));
    assert.equal(saved.BambuBoard_displayFanPercentages, checked !== 'true');
    assert.equal(saved.printer.accessCode, 'fixture-only');
    await page.locator('#cloud-email-form').waitFor({ state: 'visible' });
    const relayPage = await context.newPage();
    await relayPage.addInitScript(() => {
      const tracks = [{ stopped: false, stop() { this.stopped = true; }, addEventListener() {} }];
      window.captureFixture = { tracks, recorderStopped: false, socketClosed: false };
      Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: async () => ({ getTracks: () => tracks, getVideoTracks: () => tracks }) } });
      window.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.state = 'inactive'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; window.captureFixture.recorderStopped = true; } };
      window.WebSocket = class {
        static OPEN = 1;
        constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 10); }
        send() { setTimeout(() => { this.onmessage?.({ data: JSON.stringify({ type: 'ready', id: 'fixture' }) }); this.onmessage?.({ data: JSON.stringify({ type: 'status', id: 'fixture', state: 'sending' }) }); }, 10); }
        close() { this.readyState = 3; window.captureFixture.socketClosed = true; this.onclose?.(); }
      };
    });
    await relayPage.goto(base + '/');
    await relayPage.locator('#youtube-details').evaluate(node => { node.open = true; });
    await relayPage.waitForFunction(() => !document.getElementById('yt-mode').disabled);
    await relayPage.locator('#yt-mode').selectOption('browser');
    await relayPage.locator('#yt-key').fill('fixture-only'); await relayPage.locator('#yt-start').click();
    await relayPage.waitForFunction(() => document.getElementById('yt-active-status').textContent.includes('Sending video'));
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
      if (widget.slug !== 'camera' && widget.slug !== 'gcode-viz') assert.equal(await page.evaluate(() => window.jQuery?.fn.jquery), devDependencies.jquery);
    }
    await checkTelemetryFreshness(context, base, telemetry);
    await checkAms3h(context, base, artifactDir);
    await checkLiveWidgetReuse(context, base);
    await checkCalibrationWidgets(context, base, data, telemetry);
    await checkCameraRecovery(browser, artifactDir);
    // Old hosts, AMS/nozzle selection, custom themes and bindings survive an editor round-trip.
    const parameters = structuredClone(published);
    const ams = parameters.sources.find(source => source.settings?.url?.includes('/widgets/ams/'));
    const secondAms = structuredClone(ams); secondAms.name = 'AMS duplicate'; secondAms.uuid = 'fixture-duplicate'; secondAms.settings.url = 'http://old-board.invalid/widgets/ams/?ams=3&theme=dark&accent=51a34f'; parameters.sources.push(secondAms);
    parameters.sources.find(source => source.id === 'scene').settings.items.push({ name: secondAms.name, pos: { x: 300, y: 300 }, scale: { x: 1, y: 1 }, align: 5 });
    ams.settings.url = 'https://old-board.invalid/widgets/ams/?ams=2&nozzle=1&theme=light&accent=8c7ae6&bind.temp=%24.print.bed_temper';
    const parameterDraft = await fetch(base + '/api/obs/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Parameter fixture', json: parameters }) }).then(r => r.json());
    assert.ok(parameterDraft.slug);
    await page.goto(base + '/scene-editor'); await page.waitForSelector('.scene-item');
    await page.locator('#loader').selectOption(`scn:${parameterDraft.slug}`);
    await page.waitForFunction(() => document.getElementById('draft-name').value === 'Parameter fixture');
    assert.match(await page.locator('iframe[src*="/widgets/ams/"][src*="ams=2"]').getAttribute('src'), /ams=2/);
    await page.locator('#save-btn').click(); await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved');
    const roundTrip = await fetch(base + '/api/obs/scenes/' + encodeURIComponent(parameterDraft.slug)).then(r => r.json());
    const query = new URL(roundTrip.sources.find(source => source.name === ams.name).settings.url).searchParams;
    for (const [key, value] of Object.entries({ ams: '2', nozzle: '1', theme: 'light', accent: '8c7ae6', 'bind.temp': '$.print.bed_temper' })) assert.equal(query.get(key), value);
    const duplicateQuery = new URL(roundTrip.sources.find(source => source.name === 'AMS duplicate').settings.url).searchParams;
    assert.equal(duplicateQuery.get('ams'), '3'); assert.equal(duplicateQuery.get('theme'), 'dark'); assert.equal(duplicateQuery.get('accent'), '51a34f');
    const browserSources = structuredClone(parameters);
    const browserSourceItems = browserSources.sources.find(source => source.id === 'scene').settings.items;
    for (const [name, url] of [['Local browser fixture', '/version'], ['Unsupported browser fixture', 'about:blank']]) {
      browserSources.sources.push({ name, id: 'browser_source', settings: { url, width: 200, height: 200 } });
      browserSourceItems.push({ name, pos: { x: 200, y: 200 }, scale: { x: 1, y: 1 }, align: 5 });
    }
    const browserSourceDraft = await fetch(base + '/api/obs/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Browser source fixture', json: browserSources }) }).then(res => res.json());
    await page.locator('#loader').selectOption(`scn:${parameterDraft.slug}`);
    await page.reload();
    await page.locator('#loader').selectOption(`scn:${browserSourceDraft.slug}`);
    await page.getByText('Unsupported browser source URL').waitFor();
    await page.locator('iframe[title="Local browser fixture"]').waitFor();
    assert.equal(await page.locator('iframe[title="Unsupported browser fixture"]').count(), 0);
    await page.locator('#golive-btn').click();
    await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved · Live');
    const livePage = await context.newPage();
    await livePage.goto(base + '/live');
    await livePage.locator('iframe[title="Local browser fixture"]').waitFor();
    assert.equal(await livePage.locator('iframe[title="Unsupported browser fixture"]').count(), 0);
    await livePage.close();
    // Inspect the docked controls and expanded optional settings on a narrow screen.
    await page.setViewportSize({ width: 320, height: 1100 });
    await page.locator('.layer-row .lr-name').first().click();
    assert.equal(await page.locator('#inspector-fields').isVisible(), true);
    await page.locator('#widget-drawer-btn').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#widget-drawer-close').click(); assert.equal(await page.locator('#layers-panel').isVisible(), true);
    await page.goto(base + '/setup?firstRun=1'); await page.waitForFunction(() => !document.getElementById('bb-stepper').hidden);
    await page.locator('.display-preferences > summary').click(); await page.locator('#cloud-email-form').waitFor({ state: 'visible' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, [], 'browser JavaScript errors');
    assert.deepEqual([...external], [], 'LAN operation must not request CDN assets');
    await fs.writeFile(path.join(artifactDir, 'browser-results.json'), JSON.stringify({ layouts: layoutResults, widgets: widgets.length, calibrationWidgets: true, cameraRecovery: true, errors, externalRequests: [...external] }, null, 2));
    console.log(`Browser passed: ${layoutResults.length} responsive layouts, ${widgets.length} widgets, save/publish isolation, setup keyboard controls, HTTP capture detection, calibration and camera recovery, no external requests. Screenshots: ${artifactDir}`);
  } catch (error) { console.error(logs); throw error; }
  finally {
    await browser?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
    if (!process.env.BB_SCREENSHOTS) console.log(`Test evidence retained at ${data}`);
    else await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
