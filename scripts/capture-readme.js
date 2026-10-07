// Capture the actual app from an isolated, simulated printer installation.
// Optional reference files must be local, sanitized examples, never credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const { spawn, execFileSync } = require('node:child_process');
const packets = require('mqtt-packet');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const gcode = 'G90\nM82\n;LAYER:0\nG1 X120 Y110 Z0.2 E1\nG1 X220 Y110 E2\nG1 X220 Y210 E3\nG1 X120 Y210 E4\nG1 X120 Y110 E5\n;LAYER:1\nG1 Z0.4\nG1 X220 Y110 E6\nG1 X220 Y210 E7\nG1 X120 Y210 E8\nG1 X120 Y110 E9\n';
(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-readme-'));
  const out = process.env.BB_SCREENSHOTS || path.join(root, 'screenshots');
  await fs.mkdir(out, { recursive: true });
  const name = 'H2D demo';
  const telemetry = process.env.BB_TELEMETRY_REFERENCE
    ? JSON.parse(await fs.readFile(process.env.BB_TELEMETRY_REFERENCE, 'utf8'))
    : { print: { gcode_state: 'FINISH', mc_percent: 100, layer_num: 2, total_layer_num: 2, bed_temper: 28, chamber_temper: 27, nozzle_temper: 28, nozzle_target_temper: 0, bed_target_temper: 0, ams: { ams: [] } } };
  telemetry.print.subtask_name = 'Demo plate';
  telemetry.print.gcode_file = '/data/Metadata/plate_1.gcode';
  telemetry.print.task_id = 'DEMO'; telemetry.print.subtask_id = 'DEMO';
  telemetry.print.ipcam = { rtsp_url: 'disable' };
  let scene = JSON.parse(await fs.readFile(process.env.BB_SCENE_REFERENCE || path.join(root, 'OBS_settings/templates/default-h2d.json'), 'utf8'));
  scene = JSON.parse(JSON.stringify(scene).replace(/<VERSION>/g, require('../package.json').version));
  await fs.mkdir(path.join(data, 'scenes'));
  await fs.writeFile(path.join(data, 'scenes', name + '.json'), JSON.stringify(scene));
  await fs.writeFile(path.join(data, 'active-scene.json'), JSON.stringify({ slug: name }));
  await fs.writeFile(path.join(data, 'data.json'), JSON.stringify(telemetry));
  await fs.writeFile(path.join(data, 'note.json'), JSON.stringify({ text: 'Demo plate', manual: true }));
  const keyFile = path.join(data, 'fixture-key.pem'), certFile = path.join(data, 'fixture-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const sockets = new Set();
  const broker = tls.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const parser = packets.parser(); socket.on('data', chunk => parser.parse(chunk));
    const send = object => socket.write(packets.generate(object));
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      else if (packet.cmd === 'subscribe') {
        send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
        send({ cmd: 'publish', topic: 'device/DEMO/report', payload: JSON.stringify({ info: { command: 'get_version', module: [{ name: 'ota', product_name: 'Bambu Lab H2D' }] } }) });
        send({ cmd: 'publish', topic: 'device/DEMO/report', payload: JSON.stringify(telemetry) });
      } else if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    });
  });
  await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ printer: { name, type: 'H2D', url: '127.0.0.1', port: broker.address().port, serialNumber: 'DEMO', accessCode: 'demo-only', detectedFrom: 'config' }, cloudAuth: { enabled: false } }));
  const portServer = net.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), BAMBUBOARD_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '', serverError;
  const recordOutput = chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-8000); };
  server.stdout.on('data', recordOutput); server.stderr.on('data', recordOutput);
  server.on('error', error => { serverError = error; });
  let browser;
  const timers = new Set();
  const errors = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (serverError || server.exitCode !== null) throw new Error(`Demo server exited: ${serverError?.message || server.exitCode}\n${serverOutput}`);
      try { if ((await fetch(base + '/api/status').then(r => r.json())).connected) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Demo server did not connect to its MQTT fixture:\n${serverOutput}`);
    const camera = process.env.BB_CAMERA_REFERENCE ? await fs.readFile(process.env.BB_CAMERA_REFERENCE) : execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1', '-c:v', 'mpeg1video', '-f', 'mpegts', 'pipe:1']);
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/api/printer/video/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: true, cameraType: 'rtsp', rtspEnabled: true, relayReady: true, hint: null }) }));
    await context.route('**/api/gcode/current*', route => route.fulfill({ contentType: 'text/plain', body: gcode }));
    await context.route('**/profile-info', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ enabled: true, signedIn: true, avatar: '/assets/bambuboard-prism.svg', handle: 'Demo maker', fanCount: 821, followCount: 9, likeCount: 9140, collectionCount: 21683, downloadCount: 17125, boostGained: 733 }) }));
    await context.route('**/login-and-fetch-image', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ imageUrl: '/assets/bambuboard-prism.svg', modelTitle: 'Demo plate', modelWeight: 15.24, totalPrints: 67, deviceName: 'H2D demo', deviceModel: 'H2D', bedType: 'PEI Smooth Plate' }) }));
    await context.routeWebSocket('**/api/printer/video', ws => {
      const timer = setInterval(() => ws.send(camera), 250); timers.add(timer);
      ws.onClose(() => { clearInterval(timer); timers.delete(timer); });
    });
    const page = await context.newPage();
    await page.goto(base + '/');
    await page.waitForFunction(() => document.getElementById('publication-state').textContent === 'Published');
    await page.frameLocator('#live-frame').frameLocator('iframe[src*="/widgets/camera/"]').locator('#camCanvas').waitFor();
    await page.waitForFunction(() => {
      const live = document.getElementById('live-frame').contentDocument;
      const camera = live?.querySelector('iframe[src*="/widgets/camera/"]')?.contentDocument;
      return camera?.getElementById('camCanvas')?.width > 300 && !camera?.getElementById('camOverlay')?.classList.contains('show');
    });
    assert.equal(await page.locator('#youtube-details').getAttribute('open'), null);
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(5500);
    await page.screenshot({ path: path.join(out, 'STUDIO-LIVE.png'), fullPage: true });
    // A viewport capture gives project cards a wide image of the actual app.
    if (process.env.BB_BLOG_HERO) await page.screenshot({ path: process.env.BB_BLOG_HERO, fullPage: false });
    await page.goto(base + '/scene-editor'); await page.waitForSelector('.scene-item');
    await page.locator('.layer-row').filter({ hasText: 'AMS' }).first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.scene-item canvas')].some(canvas => canvas.width > 300));
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(5500);
    await page.mouse.move(1590, 990);
    await page.screenshot({ path: path.join(out, 'STUDIO-LAYOUT.png'), fullPage: true });
    // Save the imported geometry through the real editor and compare it.
    await page.locator('#save-btn').click();
    await page.waitForFunction(() => !document.getElementById('save-btn').disabled);
    const saved = await fetch(base + '/api/obs/scenes/' + encodeURIComponent(name)).then(r => r.json());
    const originalScene = scene.sources.find(s => s.id === 'scene' && s.name === scene.current_scene);
    const savedScene = saved.sources.find(s => s.id === 'scene' && s.name === scene.current_scene);
    assert.deepEqual(savedScene.settings.items, originalScene.settings.items);
    assert.equal(saved.sources.length, scene.sources.length);
    assert.deepEqual(saved.resolution, scene.resolution);
    await page.goto(base + '/setup'); await page.waitForFunction(() => document.getElementById('p-name').value === 'H2D demo');
    await page.waitForFunction(() => document.getElementById('connect-mqtt').textContent.includes('Connected'));
    assert.equal(await page.locator('#p-ac').getAttribute('type'), 'password');
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, 'STUDIO-SETUP.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 }); await page.goto(base + '/');
    await page.waitForFunction(() => document.getElementById('publication-state').textContent === 'Published');
    await page.waitForTimeout(2000); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, 'STUDIO-MOBILE.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const evidence = { source: 'Isolated MQTT demo, sample cloud responses and camera replay', recordedCamera: !!process.env.BB_CAMERA_REFERENCE, canvas: saved.resolution, sources: saved.sources.length, geometryRoundTrip: true, browserErrors: errors, captures: ['STUDIO-LIVE.png', 'STUDIO-LAYOUT.png', 'STUDIO-SETUP.png', 'STUDIO-MOBILE.png'] };
    if (process.env.BB_CAPTURE_EVIDENCE) await fs.writeFile(process.env.BB_CAPTURE_EVIDENCE, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, output: out }));
  } finally {
    for (const timer of timers) clearInterval(timer);
    await browser?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => broker.close(resolve));
    await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
