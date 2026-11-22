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
    { name: 'First AMS', uuid: 'qa-ams-one', id: 'browser_source', settings: { width: 400, height: 58, url: 'http://old-host.invalid/widgets/ams/?ams=2&title=Before' } },
    { name: 'Second AMS', uuid: 'qa-ams-two', id: 'browser_source', settings: { width: 400, height: 460, url: 'http://old-host.invalid/widgets/ams/?ams=3&title=Keep&theme=light' } },
    { name: 'Progress', uuid: 'qa-progress', id: 'browser_source', settings: { width: 600, height: 80, url: 'http://old-host.invalid/widgets/progress-info/' } },
    { name: 'Main', id: 'scene', settings: { items: [item('Backdrop', 0, 0), item('First AMS', 20, 120), { ...item('Second AMS', 900, 500), align: 0, scale: { x: 0.9, y: 1 } }] } },
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
    browser = await engines[name].launch({ headless: true, ...(name === 'chromium' && process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.add(request.url()); });
    const page = await context.newPage();
    const request = async (route, body) => {
      const response = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      const text = await response.text();
      assert.ok(response.ok, `${route} returned HTTP ${response.status}`);
      try { return JSON.parse(text); }
      catch (cause) { throw new Error(`${route} returned invalid JSON (${text.length} bytes)`, { cause }); }
    };
    const saved = () => request('/api/obs/scenes/Upgrade');
    const edit = async (id, value) => { await page.locator(id).fill(String(value)); await page.locator(id).dispatchEvent('change'); };
    const save = async () => {
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === '/api/obs/scenes' && r.request().method() === 'POST'),
        page.locator('#save-btn').click(),
      ]);
      assert.equal((await response.json()).ok, true);
      await page.waitForFunction(() => ['Draft saved', 'Draft saved · Live'].includes(document.getElementById('draft-state').textContent));
    };
    const select = async layer => page.getByText(layer, { exact: true }).and(page.locator('.lr-name')).click();
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
    await page.locator('#bindings-block').evaluate(node => {
      node.open = true;
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      }
    });
    await audit('Telemetry bindings');
    await page.locator('#widget-drawer-btn').click(); await audit('Widget library'); await page.locator('#widget-drawer-close').click();
    for (const route of ['/', '/setup', '/login']) {
      if (route === '/setup') {
        await page.route('**/auth/status', request => request.fulfill({ json: { enabled: true, signedIn: true, email: 'demo@example.test' } }));
        await page.route('**/auth/token', request => request.fulfill({ json: { token: 'fixture-saved-cloud-token', email: 'demo@example.test' } }));
      }
      await page.goto(base + route); await page.waitForSelector('.nav-brand'); await page.evaluate(() => document.fonts.ready);
      if (route === '/setup') {
        await page.waitForFunction(() => document.getElementById('cloud-status-pill').textContent !== 'Checking…');
        assert.equal(await page.locator('#cloud-token').isVisible(), true, 'Cloud settings are visible without opening an accordion');
        assert.equal(await page.locator('#cloud-token').getAttribute('type'), 'password');
        assert.equal(await page.locator('#cloud-token').inputValue(), 'fixture-saved-cloud-token');
        assert.match(await page.locator('#cloud-status-pill').innerText(), /Signed in as demo@example.test/);
        await page.locator('#cloud-token').fill('fixture-cloud-token');
        await page.locator('#cloud-token-show').click();
        assert.equal(await page.locator('#cloud-token').getAttribute('type'), 'text');
        assert.equal(await page.locator('#cloud-token').inputValue(), 'fixture-cloud-token');
        await page.locator('#cloud-token-show').click();
        assert.equal(await page.locator('#cloud-token').getAttribute('type'), 'password');
        await page.locator('#cloud-token-clear').click();
        assert.equal(await page.locator('#cloud-token').inputValue(), '');
        await page.locator('.display-preferences > summary').click();
      }
      await audit(route);
      if (route === '/setup') { await page.unroute('**/auth/status'); await page.unroute('**/auth/token'); }
    }
    await fs.writeFile(path.join(artifactDir, `accessibility-${name}.json`), JSON.stringify(accessibility, null, 2));
    assert.deepEqual(accessibility.flatMap(a => a.violations), [], 'Management UI accessibility violations');
    passed.push('WCAG automated scan on six management states');

    await openEditor(); await select('First AMS');
    const widgetFrame = () => page.frameLocator('.scene-item.selected iframe').locator('body');
    const viewport = () => widgetFrame().evaluate(body => ({
      height: window.innerHeight,
      contentHeight: Math.max(body.scrollHeight, document.documentElement.scrollHeight),
    }));
    const waitForWidgetHeight = expected => page.waitForFunction(height => {
      const iframe = document.querySelector('.scene-item.selected iframe');
      return iframe?.contentWindow?.innerHeight === height;
    }, expected);
    await waitForWidgetHeight(58);
    const clipped = await viewport();
    assert.ok(clipped.contentHeight > clipped.height, 'AMS content should overflow the intentionally small fixture');
    await edit('#insp-h', 220); await waitForWidgetHeight(220);
    assert.equal(await page.locator('.scene-item.selected iframe').evaluate(frame => new DOMMatrix(getComputedStyle(frame).transform).d), 1);
    await page.locator('#autosize-btn').click();
    await page.waitForFunction(() => {
      const frame = document.querySelector('.scene-item.selected iframe');
      const height = Number(document.querySelector('#insp-h').value);
      return height > 220 && frame?.contentWindow?.innerHeight === height;
    });
    const fitted = await viewport();
    assert.ok(fitted.height >= fitted.contentHeight);
    await page.locator('#undo-btn').click(); await waitForWidgetHeight(220);
    await page.locator('#undo-btn').click(); await waitForWidgetHeight(58);
    passed.push('Widget dimensions reflow clipped AMS content without stretching; Fit to content grows the viewport and is undoable');

    await page.evaluate(() => {
      window.changedPreviewSources = [];
      new MutationObserver(records => {
        for (const { target } of records) window.changedPreviewSources.push(target.title);
      }).observe(document.getElementById('canvas'), { subtree: true, attributes: true, attributeFilter: ['src'] });
    });
    const title = page.locator('#cust-title');
    await title.fill('Pending title');
    await page.frameLocator('.scene-item.selected iframe').locator('body').evaluate(() => {
      parent.postMessage({ type: 'bambuboard:size', slug: 'ams', w: 493, h: 376 }, location.origin);
    });
    await page.waitForFunction(() => !document.querySelector('#autosize-btn').disabled);
    assert.equal(await title.inputValue(), 'Pending title', 'Preview measurements must preserve the field being edited');
    assert.equal(await page.evaluate(() => window.changedPreviewSources.length), 0, 'Typing in an appearance field must not reload the preview');
    await title.press('Enter');
    await page.waitForFunction(() => window.changedPreviewSources.length === 1);
    assert.deepEqual(await page.evaluate(() => window.changedPreviewSources), ['First AMS']);
    await title.fill('');
    await title.press('Enter');
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes', 'Removing the final styling parameter is an edit');
    await save();
    let scene = await saved();
    let query = new URL(scene.sources.find(s => s.name === 'First AMS').settings.url).searchParams;
    assert.equal(query.has('title'), false); assert.equal(query.get('ams'), '2');
    assert.equal(new URL(scene.sources.find(s => s.name === 'Second AMS').settings.url).searchParams.get('title'), 'Keep');
    assert.deepEqual(await request('/api/obs/published'), original, 'Upgrade snapshots survive draft saves');
    passed.push('Legacy upgrade, committed widget edits reload only the affected iframe, and duplicate widget styling stays independent');

    await select('Second AMS');
    const scale = () => page.locator('.scene-item.selected iframe').evaluate(frame => {
      const matrix = new DOMMatrix(frame.style.transform);
      return [matrix.a, matrix.d].map(value => Math.round(value * 10000) / 10000);
    });
    assert.deepEqual(await scale(), [0.9, 1]);
    await page.getByRole('button', { name: 'Remove stretching' }).click();
    await page.locator('#reset-stretch').waitFor({ state: 'hidden' });
    assert.deepEqual(await scale(), [0.9, 0.9]);
    await page.locator('#undo-btn').click();
    assert.deepEqual(await scale(), [0.9, 1]);
    await edit('#insp-x', 950);
    const beforeReload = await page.locator('.scene-item.selected').boundingBox();
    await save(); await page.reload(); await page.waitForSelector('.scene-item'); await select('Second AMS');
    const afterReload = await page.locator('.scene-item.selected').boundingBox();
    assert.ok(Math.abs(beforeReload.x - afterReload.x) < 1, 'Anchor-aligned sources must stay in the same place after saving and reloading');
    passed.push('Anchor-aligned geometry is stable before and after reload');

    await page.locator('#scene-picker').selectOption('Second scene');
    assert.equal(await page.locator('#draft-state').innerText(), 'Draft saved', 'Browsing scenes must not dirty the draft');
    assert.equal(await page.locator('#live-scene-picker').inputValue(), 'Main', 'Browsing must not choose a new live scene');
    await page.locator('#scene-picker').selectOption('Main'); await select('First AMS'); await edit('#insp-x', 321);
    await page.locator('#scene-picker').selectOption('Second scene');
    await select('Progress'); await edit('#insp-y', 234);
    await page.locator('#scene-picker').selectOption('Main'); await select('First AMS');
    assert.equal(await page.locator('#insp-x').inputValue(), '321', 'Switching scenes must retain pending geometry');
    await page.locator('#undo-btn').click();
    assert.notEqual(await page.locator('#insp-x').inputValue(), '321');
    await page.locator('#redo-btn').click();
    assert.equal(await page.locator('#insp-x').inputValue(), '321');
    await save(); scene = await saved();
    assert.equal(scene.sources.find(s => s.name === 'Second scene').settings.items[0].pos.y, 234);
    assert.equal(scene.fixtureMarker, original.fixtureMarker); assert.deepEqual(scene.transitions, original.transitions);
    passed.push('Multi-scene edits and unrelated OBS metadata survive round-trip');

    await page.locator('#insp-locked').check();
    assert.equal(await page.locator('#insp-x').isEnabled(), false, 'Inspector geometry must respect layer lock');
    assert.equal(await page.locator('#cust-title').isEnabled(), false, 'Appearance must respect layer lock');
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
    assert.equal(await page.locator('#golive-btn').isEnabled(), false, 'Apply to Live requires a separately saved revision');
    await save();
    await page.route('**/api/obs/active', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture failure"}' }) : route.continue());
    await page.locator('#golive-btn').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(t => /apply.+failed|fixture failure/i.test(t.textContent)));
    assert.equal(await page.locator('#draft-state').innerText(), 'Draft saved');
    assert.deepEqual(await request('/api/obs/published'), original);
    assert.equal(await page.locator('#golive-btn').isEnabled(), true);
    await page.unroute('**/api/obs/active');
    passed.push('Publish failure keeps saved draft and earlier live output');

    const live = await context.newPage(); await live.goto(base + '/live'); await live.waitForSelector('.live-item');
    await live.locator('.live-item').first().evaluate(node => { node.dataset.qaIdentity = 'stable'; });
    await save(); await live.waitForTimeout(2200);
    assert.equal(await live.locator('[data-qa-identity="stable"]').count(), 1, 'Draft save must not remount the live output');
    await page.locator('#golive-btn').click(); await page.waitForFunction(() => document.getElementById('draft-state').textContent === 'Draft saved · Live');
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
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#reset-btn').click(); assert.equal(await page.locator('#insp-x').inputValue(), '999');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#reset-btn').click(); await select('First AMS'); assert.equal(await page.locator('#insp-x').inputValue(), '430');
    await page.locator('#undo-btn').click(); await select('First AMS'); assert.equal(await page.locator('#insp-x').inputValue(), '999');
    await page.locator('#redo-btn').click(); await select('First AMS'); assert.equal(await page.locator('#insp-x').inputValue(), '430');
    passed.push('Discard and reset can be cancelled; reset has an undo and redo');

    const draftName = page.locator('#draft-name');
    await draftName.fill('Renamed fixture');
    await draftName.press('Tab');
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes');
    await page.locator('#undo-btn').click();
    assert.equal(await draftName.inputValue(), 'Upgrade');
    await page.locator('#redo-btn').click();
    await page.locator('#live-scene-picker').selectOption('Second scene');
    await save();
    assert.ok((await request('/api/obs/scenes')).some(draft => draft.slug === 'Upgrade' && draft.name === 'Renamed fixture'));
    assert.deepEqual(await request('/api/obs/published'), published);
    await page.locator('#golive-btn').click();
    await page.waitForFunction(() => document.querySelector('#live-state').textContent.includes('Renamed fixture / Second scene'));
    assert.equal((await request('/api/obs/published')).current_program_scene, 'Second scene');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#restore-live-btn').click();
    assert.equal((await request('/api/obs/published')).current_program_scene, 'Second scene');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#restore-live-btn').click();
    await page.waitForFunction(() => document.querySelector('#live-state').textContent.includes('Upgrade / Main'));
    assert.deepEqual(await request('/api/obs/published'), published);
    passed.push('Renaming retains draft ID and participates in history; Apply chooses the saved scene and Restore reinstates the previous output');

    const layouts = [];
    for (const width of [1440, 1024, 736, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ['/', '/scene-editor', '/setup']) {
        await page.goto(base + route); await page.waitForSelector('.nav-brand');
        if (route === '/scene-editor') { await page.waitForSelector('.scene-item'); await page.locator('#widget-drawer-btn').click(); }
        if (route === '/setup') {
          await page.waitForFunction(() => document.getElementById('p-name').value === 'QA H2D');
          assert.equal(await page.locator('#cloud-email').isVisible(), true, 'Email sign-in is visible for a new account');
          if (width >= 1000) {
            const printer = await page.locator('.setup-main').boundingBox(), cloud = await page.locator('#cloud-section').boundingBox();
            assert.ok(Math.abs(printer.y - cloud.y) < 2 && cloud.x > printer.x + printer.width, 'Cloud sits alongside the printer at the top');
          } else {
            await page.locator('a[href="#cloud-section"]').click();
            await page.waitForFunction(() => { const box = document.getElementById('cloud-heading').getBoundingClientRect(); return box.top >= 0 && box.bottom < innerHeight; });
          }
          await page.locator('#cloud-tab-email').click();
        }
        await page.evaluate(() => document.fonts.ready);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: ${route} overflows at ${width}`);
        layouts.push({ width, route });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await openEditor();
    const preview = await page.locator('#canvas-shell').boundingBox();
    assert.ok(preview.y < 844, 'The canvas should be visible before scrolling on a 390 × 844 phone');
    const phoneLayer = page.getByRole('button', { name: 'Select First AMS', exact: true });
    await phoneLayer.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'inspector-heading');
    assert.equal(await page.locator('#inspector').isVisible(), true);
    assert.equal(await page.locator('#layers-panel').isVisible(), false);
    assert.equal(await page.locator('#inspector-advanced').getAttribute('open'), null);
    const geometryInput = await page.locator('#insp-x').boundingBox();
    assert.ok(geometryInput.height >= 44, 'Phone inspector controls should be usable touch targets');
    if (name === 'chromium') await page.screenshot({ path: path.join(artifactDir, 'editor-inspector-phone.png') });
    await audit('Phone inspector');
    await page.locator('#inspector-close').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'layers-panel-btn');
    assert.equal(await page.locator('#layers-panel').isVisible(), true);
    passed.push('Phone canvas starts in view, keyboard selection reaches the Inspector and closing restores focus');
    assert.deepEqual(accessibility.flatMap(a => a.violations), [], 'Management UI accessibility violations');
    await fs.writeFile(path.join(artifactDir, `accessibility-${name}.json`), JSON.stringify(accessibility, null, 2));
    await page.setViewportSize({ width: 1440, height: 1000 });
    let catalogAvailable = false;
    await page.route('**/api/widgets', route => catalogAvailable ? route.continue() : route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } }));
    await openEditor();
    await page.locator('#widget-drawer-btn').click();
    const retryCatalog = page.getByRole('button', { name: 'Retry loading widgets' });
    await retryCatalog.waitFor();
    assert.match(await page.locator('#widget-drawer-list').innerText(), /Could not load the widget catalog/);
    catalogAvailable = true;
    await retryCatalog.click();
    await page.locator('#widget-drawer-list .drawer-widget').first().waitFor();
    await page.unroute('**/api/widgets');
    passed.push('Widget catalog shows an error and Retry recovers without reloading the editor');

    const removalFixture = fixture();
    const removalSlug = 'Removal fixture';
    const main = collection => collection.sources.find(source => source.name === 'Main').settings.items;
    const second = collection => collection.sources.find(source => source.name === 'Second scene').settings.items;
    const namesOf = items => items.map(layer => layer.name);
    const initialLayerOrder = () => namesOf(main(removalFixture)).reverse();
    main(removalFixture).find(layer => layer.name === 'Second AMS').locked = true;
    second(removalFixture).splice(0, 1, item('First AMS', 220, 110));
    removalFixture.sources = removalFixture.sources.filter(source => source.name !== 'Progress');
    for (const [label, slug] of [['Printer camera', 'camera'], ['Toolpath preview', 'gcode-viz']]) {
      removalFixture.sources.push({ name: label, id: 'browser_source', settings: { width: 640, height: 360, url: `${base}/widgets/${slug}/` } });
      main(removalFixture).push(item(label, 550, 100));
    }
    const mediaFixture = url => url.origin === base && ['/widgets/camera/', '/widgets/gcode-viz/'].includes(url.pathname);
    await page.route(mediaFixture, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local widget fixture</title>' }));
    await fs.writeFile(path.join(data, 'scenes', removalSlug + '.json'), JSON.stringify(removalFixture));
    const readRemovalDraft = () => request('/api/obs/scenes/' + encodeURIComponent(removalSlug));
    const liveBeforeRemoval = await request('/api/obs/published');
    await openEditor();
    await page.locator('#loader').selectOption('scn:' + removalSlug);
    await page.getByRole('button', { name: 'Select Toolpath preview', exact: true }).waitFor();

    const remove = label => page.getByRole('button', { name: 'Remove widget: ' + label, exact: true });
    const layers = () => page.locator('#layers-panel-list .lr-name').allTextContents();
    const selectedLayer = () => page.locator('.layer-row.selected .lr-name').innerText({ timeout: 2000 });
    const undoRemoval = () => page.locator('#undo-btn').click();
    const redoRemoval = () => page.locator('#redo-btn').click();
    const expectLayers = (excluded = [], message) => layers().then(order => assert.deepEqual(order, initialLayerOrder().filter(layer => !excluded.includes(layer)), message));
    const sceneKeys = page.locator('#canvas');
    await sceneKeys.press('Delete');
    await page.keyboard.down('Backspace');
    await page.keyboard.down('Backspace');
    await page.keyboard.up('Backspace');
    await expectLayers([], 'A shortcut without a selection must leave the scene intact');
    await select('First AMS');
    assert.equal(await remove('Printer camera').innerText(), 'Remove widget');
    await remove('Printer camera').click();
    await expectLayers(['Printer camera'], 'The row action removes its own widget rather than the selection');
    assert.equal(await selectedLayer(), 'First AMS');
    assert.equal(await page.locator('.scene-item iframe[title="Printer camera"]').count(), 0);
    await undoRemoval();
    await expectLayers();
    await redoRemoval();
    await expectLayers(['Printer camera']);
    await undoRemoval();
    await expectLayers();
    passed.push('A labeled row action removes its own widget, preserves another selection and round-trips through Undo/Redo');

    assert.equal(await remove('Second AMS').isDisabled(), true, 'A locked row must offer no actionable removal');
    await select('Second AMS');
    await sceneKeys.press('Delete');
    await sceneKeys.press('Backspace');
    await expectLayers([], 'Neither removal key should affect a locked item');
    await select('First AMS');
    const layerKeys = page.getByRole('button', { name: 'Select First AMS', exact: true });
    for (const key of ['Delete', 'Backspace']) {
      for (const modifier of ['Control', 'Meta', 'Alt', 'Shift']) await layerKeys.press(`${modifier}+${key}`);
      for (const state of [{ repeat: true }, { isComposing: true }]) {
        await layerKeys.dispatchEvent('keydown', { key, bubbles: true, cancelable: true, ...state });
      }
    }
    await expectLayers([], 'Modified, repeating and composing keys should not remove a widget');
    await page.locator('#save-btn').press('Delete');
    const editingProbe = page.locator('#removal-keyboard-probe');
    await page.locator('#inspector').evaluate(inspector => {
      const probe = document.createElement('div');
      probe.id = 'removal-keyboard-probe';
      probe.innerHTML = '<input aria-label="Fixture input"><textarea aria-label="Fixture textarea"></textarea><select aria-label="Fixture select"><option>Value</option></select><div contenteditable="true"><span>Text edit</span></div><dialog aria-label="Fixture modal"><button type="button">Modal action</button></dialog>';
      inspector.append(probe);
    });
    await editingProbe.locator('[contenteditable] span').dispatchEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    for (const tag of ['input', 'textarea', '[contenteditable]']) {
      const control = editingProbe.locator(tag);
      await control.fill('AB');
      await control.press('Backspace');
      await control.press('Delete');
      assert.equal(tag === '[contenteditable]' ? await control.innerText() : await control.inputValue(), 'A', `${tag} retains native Backspace behavior`);
    }
    // WebKit can navigate back for trusted Backspace on non-text controls.
    for (const key of ['Delete', 'Backspace']) {
      await editingProbe.locator('select').dispatchEvent('keydown', { key, bubbles: true, cancelable: true });
    }
    await editingProbe.locator('dialog').evaluate(dialog => dialog.showModal());
    await editingProbe.locator('button').press('Delete');
    await editingProbe.locator('button').dispatchEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    await editingProbe.evaluate(probe => probe.remove());
    await expectLayers([], 'Editing fields, unrelated toolbar focus and modal actions should not remove a widget');
    assert.equal(await page.locator('#draft-state').innerText(), 'Draft saved');

    await layerKeys.press('Delete');
    await expectLayers(['First AMS']);
    assert.equal(await page.locator('.layer-row.selected').count(), 0, 'Removing the selection should clear it');
    assert.equal(await page.locator('#draft-state').innerText(), 'Unsaved changes');
    assert.equal(await page.locator('#golive-btn').isDisabled(), true);
    await undoRemoval();
    await expectLayers();
    assert.equal(await selectedLayer(), 'First AMS', 'Undo should restore the removed selection');
    assert.equal(await page.locator('#insp-x').inputValue(), '20');
    assert.equal(await page.locator('#cust-title').inputValue(), 'Before');
    await redoRemoval();
    await expectLayers(['First AMS']);
    assert.equal(await page.locator('.layer-row.selected').count(), 0);
    await select('Toolpath preview');
    await page.keyboard.press('Delete');
    await expectLayers(['First AMS', 'Toolpath preview']);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Printer camera', 'Removing the top Layers row moves focus to its neighbor');
    await page.keyboard.press('Control+z');
    await expectLayers(['First AMS']);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Toolpath preview', 'Keyboard Undo focuses the restored selection');
    await page.keyboard.press('Delete');
    await expectLayers(['First AMS', 'Toolpath preview']);
    await undoRemoval();
    await sceneKeys.press('Backspace');
    await expectLayers(['First AMS', 'Toolpath preview']);
    passed.push('Delete and Backspace remove unlocked items with shortcut guards and preserve Layers focus through keyboard Undo');

    await page.setViewportSize({ width: 390, height: 844 });
    if (!await page.locator('#layers-panel').isVisible()) await page.locator('#layers-panel-btn').click();
    assert.equal(await remove('Backdrop').isVisible(), true, 'An imported color source has a visible phone removal action');
    await remove('Backdrop').click();
    await expectLayers(['First AMS', 'Toolpath preview', 'Backdrop']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.deepEqual(namesOf(main(await readRemovalDraft())), namesOf(main(removalFixture)), 'Removal must remain local until Save draft');
    assert.deepEqual(await request('/api/obs/published'), liveBeforeRemoval);
    await save();
    const afterRemoval = await readRemovalDraft();
    assert.deepEqual(namesOf(main(afterRemoval)), ['Second AMS', 'Printer camera']);
    assert.deepEqual(second(afterRemoval), second(removalFixture), 'Removing an instance preserves a shared source in another scene');
    assert.deepEqual(await request('/api/obs/published'), liveBeforeRemoval, 'Saving removals must not change live output');
    await page.locator('#golive-btn').click();
    await page.waitForFunction(() => document.querySelector('#draft-state').textContent === 'Draft saved · Live');
    const publishedRemoval = await request('/api/obs/published');
    assert.deepEqual(main(publishedRemoval), main(afterRemoval), 'Apply to Live publishes the saved removals');
    assert.deepEqual(second(publishedRemoval), second(removalFixture));
    passed.push('Phone removal of an imported source affects neither the saved draft nor live output until the corresponding explicit action');

    await page.locator('#scene-picker').selectOption('Second scene');
    await expectLayers(['Backdrop', 'Second AMS', 'Printer camera', 'Toolpath preview']);
    await remove('First AMS').click();
    assert.deepEqual(await layers(), [], 'The final widget can be removed');
    assert.equal(await page.locator('.scene-item').count(), 0);
    assert.equal(await page.locator('#layers-panel-list .empty-hint').innerText(), 'No widgets in this scene. Open Widgets to add one.');
    await page.locator('#widget-drawer-btn').click();
    await page.locator('#widget-drawer-list').getByRole('button', { name: /^Progress/ }).press('Enter');
    assert.deepEqual(await layers(), ['Progress']);
    await undoRemoval();
    assert.deepEqual(await layers(), []);
    await undoRemoval();
    assert.deepEqual(await layers(), ['First AMS']);
    await redoRemoval();
    assert.deepEqual(await layers(), []);
    await redoRemoval();
    assert.deepEqual(await layers(), ['Progress']);
    assert.deepEqual(await request('/api/obs/published'), publishedRemoval);
    await undoRemoval();
    await undoRemoval();
    assert.equal(await page.locator('#draft-state').innerText(), 'Draft saved · Live');
    await page.unroute(mediaFixture);
    passed.push('Removing the last widget leaves a usable empty scene and adding again works through two Undo/Redo steps');

    await page.goto(base + '/setup');
    await page.waitForFunction(() => document.getElementById('p-name').value === 'QA H2D');
    await page.locator('#p-sn').fill(''); await page.locator('#save-btn').click();
    await page.waitForFunction(() => document.getElementById('test-result').textContent.includes('Enter the printer'));
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
