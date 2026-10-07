// Management UI regressions in real browser engines, with isolated runtime data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const engines = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const root = path.resolve(__dirname, '..');
const item = (name, x, y) => ({ name, pos: { x, y }, scale: { x: 1, y: 1 }, align: 5, visible: true, locked: false });
const fixture = () => ({
  name: 'Upgrade fixture', resolution: { x: 2560, y: 1440 }, current_scene: 'Main', current_program_scene: 'Main',
  transitions: [{ name: 'Cut', id: 'cut_transition', settings: {} }], fixtureMarker: 'preserve unknown metadata',
  sources: [
    { name: 'Backdrop', id: 'color_source', settings: { width: 2560, height: 1440, color: 4278190080 } },
    { name: 'First AMS', uuid: 'qa-ams-one', id: 'browser_source', settings: { width: 400, height: 460, url: 'http://old-host.invalid/widgets/ams/?ams=2&title=Before' } },
    { name: 'Second AMS', uuid: 'qa-ams-two', id: 'browser_source', settings: { width: 400, height: 460, url: 'http://old-host.invalid/widgets/ams/?ams=3&title=Keep&theme=light' } },
    { name: 'Progress', uuid: 'qa-progress', id: 'browser_source', settings: { width: 600, height: 80, url: 'http://old-host.invalid/widgets/progress-info/' } },
    { name: 'Main', id: 'scene', settings: { items: [item('Backdrop', 0, 0), item('First AMS', 20, 120), { ...item('Second AMS', 900, 500), align: 0 }] } },
    { name: 'Second scene', id: 'scene', settings: { items: [item('Progress', 100, 100)] } },
  ],
});
async function runEngine(name, artifactDir) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-ui-'));
  await fs.mkdir(path.join(data, 'scenes'));
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ printer: { name: 'QA H2D', type: 'H2D', url: '127.0.0.1', port: 9, serialNumber: 'QA', accessCode: 'fixture-only' }, cloudAuth: { enabled: false } }));
  await fs.writeFile(path.join(data, 'data.json'), JSON.stringify({ print: { gcode_state: 'RUNNING', mc_percent: 47, bed_temper: 60, ams: { ams: [] } } }));
  const original = fixture();
  await fs.writeFile(path.join(data, 'scenes', 'Upgrade.json'), JSON.stringify(original));
  await fs.writeFile(path.join(data, 'active-scene.json'), JSON.stringify({ slug: 'Upgrade' }));
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), BAMBUBOARD_DATA_DIR: data }, stdio: 'ignore' });
  let browser;
  const passed = [], accessibility = [], errors = [], external = new Set();
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(base + '/api/status')).ok) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await engines[name].launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.add(request.url()); });
    const page = await context.newPage();
    const request = async (route, body) => fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(r => r.json());
    const saved = () => request('/api/obs/scenes/Upgrade');
    const edit = async (id, value) => { await page.locator(id).fill(String(value)); await page.locator(id).dispatchEvent('change'); };
    const save = async () => { await page.locator('#save-btn').click(); await page.waitForFunction(() => ['Draft saved', 'Published to /live'].includes(document.getElementById('draft-state').textContent)); };
    const select = async layer => page.locator('.layer-row').filter({ hasText: layer }).click();
    const openEditor = async () => { await page.goto(base + '/scene-editor'); await page.waitForSelector('.scene-item'); await page.evaluate(() => document.fonts.ready); };
    const audit = async label => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('#canvas').exclude('#live-frame').analyze();
      accessibility.push({ label, violations: results.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })) });
    };
    await openEditor();
    await select('First AMS');
    const output = await context.newPage(); await output.goto(base + '/live'); await output.waitForSelector('.live-item');
    await page.waitForTimeout(800); await output.waitForTimeout(800);
    const editorPixels = await page.locator('.scene-item iframe[src*="ams=2"]').screenshot();
    const outputPixels = await output.locator('.live-item iframe[src*="ams=2"]').screenshot();
    const samplePixels = await page.evaluate(async pictures => {
      const samples = [];
      for (const picture of pictures) {
        const image = new Image(); image.src = 'data:image/png;base64,' + picture;
        await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        samples.push([...context.getImageData(2, 2, 1, 1).data]);
      }
      return samples;
    }, [editorPixels.toString('base64'), outputPixels.toString('base64')]);
    assert.ok(samplePixels[0].every((value, index) => Math.abs(value - samplePixels[1][index]) < 5), `Transparent widget backdrop differs between Layout and /live: ${JSON.stringify(samplePixels)}`);
    await output.close(); passed.push('Transparent widget pixels match between the dark editor and published output');
    await audit('Layout inspector');
    await page.locator('#bindings-block').evaluate(node => { node.open = true; });
    await audit('Telemetry bindings');
    await page.locator('#widget-drawer-btn').click(); await audit('Widget library'); await page.locator('#widget-drawer-close').click();
    for (const route of ['/', '/setup', '/login']) {
      await page.goto(base + route); await page.waitForSelector('.nav-brand'); await page.evaluate(() => document.fonts.ready);
      if (route === '/setup') { await page.locator('.display-preferences > summary').click(); await page.locator('#cloud-section > summary').click(); }
      await audit(route);
    }
    await fs.writeFile(path.join(artifactDir, `accessibility-${name}.json`), JSON.stringify(accessibility, null, 2));
    assert.deepEqual(accessibility.flatMap(a => a.violations), [], 'Management UI accessibility violations');
    passed.push('WCAG automated scan on six management states');

    await openEditor(); await select('First AMS');
    await page.locator('#cust-title').fill('');
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes', 'Removing the final styling parameter is an edit');
    await save();
    let scene = await saved();
    let query = new URL(scene.sources.find(s => s.name === 'First AMS').settings.url).searchParams;
    assert.equal(query.has('title'), false); assert.equal(query.get('ams'), '2');
    assert.equal(new URL(scene.sources.find(s => s.name === 'Second AMS').settings.url).searchParams.get('title'), 'Keep');
    assert.deepEqual(await request('/api/obs/published'), original, 'Upgrade snapshots survive draft saves');
    passed.push('Legacy upgrade and clearing independent duplicate-widget styling');

    await select('Second AMS'); await edit('#insp-x', 950);
    const beforeReload = await page.locator('.scene-item.selected').boundingBox();
    await save(); await page.reload(); await page.waitForSelector('.scene-item'); await select('Second AMS');
    const afterReload = await page.locator('.scene-item.selected').boundingBox();
    assert.ok(Math.abs(beforeReload.x - afterReload.x) < 1, 'Anchor-aligned sources must stay in the same place after saving and reloading');
    passed.push('Anchor-aligned geometry is stable before and after reload');

    await select('First AMS'); await edit('#insp-x', 321);
    await page.locator('#scene-picker').selectOption('Second scene');
    await select('Progress'); await edit('#insp-y', 234);
    await page.locator('#scene-picker').selectOption('Main'); await select('First AMS');
    assert.equal(await page.locator('#insp-x').inputValue(), '321', 'Switching scenes must retain pending geometry');
    await save(); scene = await saved();
    assert.equal(scene.sources.find(s => s.name === 'Second scene').settings.items[0].pos.y, 234);
    assert.equal(scene.fixtureMarker, original.fixtureMarker); assert.deepEqual(scene.transitions, original.transitions);
    passed.push('Multi-scene edits and unrelated OBS metadata survive round-trip');

    await page.locator('#insp-locked').check();
    await page.locator('.layer-row.selected .lr-name').focus(); await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.locator('#insp-x').inputValue(), '321', 'Keyboard movement must respect layer lock');
    await page.locator('#insp-locked').uncheck();
    await page.locator('.layer-row.selected .lr-name').focus(); await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.locator('#insp-x').inputValue(), '331');
    await page.locator('#undo-btn').click(); assert.equal(await page.locator('#insp-x').inputValue(), '321');
    await page.locator('#redo-btn').click(); assert.equal(await page.locator('#insp-x').inputValue(), '331');
    await page.locator('#insp-visible').uncheck(); await save();
    scene = await saved(); assert.equal(scene.sources.find(s => s.name === 'Main').settings.items.find(i => i.name === 'First AMS').visible, false);
    await page.locator('#insp-visible').check(); await save();
    passed.push('Locked keyboard movement, Undo/Redo and layer visibility');

    const beforeInvalid = await saved();
    await page.locator('#file-input').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"sources":[]}') });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(t => /scene|Invalid/i.test(t.textContent)));
    await save(); assert.deepEqual(await saved(), beforeInvalid, 'Invalid upload must retain the current draft');
    passed.push('Invalid import leaves existing draft intact');

    // A delayed save must acknowledge its captured geometry, not later edits.
    await select('First AMS'); await edit('#insp-x', 410);
    let releaseSave, seenSave;
    const saveSeen = new Promise(resolve => { seenSave = resolve; });
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    await page.route('**/api/obs/scenes', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      seenSave(); await saveGate; await route.continue();
    });
    await page.locator('#save-btn').click(); await saveSeen;
    assert.equal(await page.locator('#golive-btn').isEnabled(), false, 'Publishing must wait for a draft save already in progress');
    await edit('#insp-x', 420); releaseSave();
    await page.waitForFunction(() => !document.getElementById('save-btn').disabled);
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes');
    assert.equal((await saved()).sources.find(s => s.name === 'Main').settings.items.find(i => i.name === 'First AMS').pos.x, 410);
    await page.unroute('**/api/obs/scenes'); await save();
    passed.push('In-flight save preserves newer edits and prevents overlapping publish');

    await edit('#insp-x', 430);
    await page.route('**/api/obs/active', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture failure"}' }) : route.continue());
    await page.locator('#golive-btn').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Publish failed')));
    assert.equal(await page.locator('#draft-state').innerText(), 'Draft saved');
    assert.deepEqual(await request('/api/obs/published'), original);
    assert.equal(await page.locator('#golive-btn').isEnabled(), true);
    await page.unroute('**/api/obs/active');
    passed.push('Publish failure keeps saved draft and earlier live output');

    const live = await context.newPage(); await live.goto(base + '/live'); await live.waitForSelector('.live-item');
    await live.locator('.live-item').first().evaluate(node => { node.dataset.qaIdentity = 'stable'; });
    await save(); await live.waitForTimeout(2200);
    assert.equal(await live.locator('[data-qa-identity="stable"]').count(), 1, 'Draft save must not remount the live output');
    await page.locator('#golive-btn').click(); await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Published to /live');
    await live.waitForFunction(() => !document.querySelector('[data-qa-identity="stable"]'));
    const published = await request('/api/obs/published');
    const exportScene = await request('/api/obs/single-source');
    assert.deepEqual(exportScene.resolution, published.resolution); assert.equal(exportScene.sources[0].settings.width, 2560);
    await live.close(); passed.push('Live output mounts only on publication and OBS export matches 2K canvas');

    // Reject discarding edits, then reset explicitly to the last saved draft.
    await edit('#insp-x', 999);
    page.once('dialog', dialog => dialog.dismiss()); await page.locator('#loader').selectOption('tpl:default-x1');
    assert.equal(await page.locator('#loader').inputValue(), 'scn:Upgrade');
    assert.equal(await page.locator('#insp-x').inputValue(), '999');
    await page.locator('#reset-btn').click(); await select('First AMS'); assert.equal(await page.locator('#insp-x').inputValue(), '430');
    passed.push('Discard cancellation and reset recover the correct saved draft');

    const layouts = [];
    for (const width of [1440, 1024, 736, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ['/', '/scene-editor', '/setup']) {
        await page.goto(base + route); await page.waitForSelector('.nav-brand');
        if (route === '/scene-editor') { await page.waitForSelector('.scene-item'); await page.locator('#widget-drawer-btn').click(); }
        if (route === '/setup') { await page.waitForFunction(() => document.getElementById('p-name').value === 'QA H2D'); await page.locator('#cloud-section > summary').click(); await page.locator('#cloud-tab-email').click(); }
        await page.evaluate(() => document.fonts.ready);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: ${route} overflows at ${width}`);
        layouts.push({ width, route });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(base + '/setup');
    await page.waitForFunction(() => document.getElementById('p-name').value === 'QA H2D');
    await page.locator('#p-sn').fill(''); await page.locator('#save-btn').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Enter the printer')));
    const config = JSON.parse(await fs.readFile(path.join(data, 'config.json'), 'utf8'));
    assert.equal(config.printer.serialNumber, 'QA');
    passed.push('Expanded responsive controls, reduced motion and incomplete Setup validation');
    assert.deepEqual(errors, [], 'Browser JavaScript errors'); assert.deepEqual([...external], [], 'Management pages must work without external assets');
    const result = { engine: name, passed, layouts, accessibility, errors, externalRequests: [...external] };
    await fs.writeFile(path.join(artifactDir, `ui-${name}.json`), JSON.stringify(result, null, 2));
    console.log(`${name}: ${passed.length} UI groups, ${layouts.length} responsive layouts, no accessibility violations or JavaScript errors`);
    return result;
  } finally {
    await browser?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
    await fs.rm(data, { recursive: true, force: true });
  }
}
(async () => {
  const artifactDir = process.env.BB_SCREENSHOTS || await fs.mkdtemp(path.join(os.tmpdir(), 'bambuboard-ui-evidence-'));
  await fs.mkdir(artifactDir, { recursive: true });
  const names = (process.env.BB_BROWSERS || 'chromium').split(',');
  const results = [], failures = [];
  for (const name of names) {
    if (!['chromium', 'firefox', 'webkit'].includes(name)) throw new Error(`Unknown browser engine: ${name}`);
    try { results.push(await runEngine(name, artifactDir)); } catch (error) { failures.push({ engine: name, error: error.stack }); console.error(`${name}: ${error.stack}`); }
  }
  await fs.writeFile(path.join(artifactDir, 'ui-results.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(`UI evidence: ${artifactDir}`);
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
