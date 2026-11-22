const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { buildObsSceneRouter } = require('../src/routes/obsScene');
const { temporary, listen } = require('./helpers');
const root = path.resolve(__dirname, '..');
const collection = (x = 2560, y = 1440, color = 4278190080) => ({
  name: 'Fixture collection', resolution: { x, y }, current_scene: 'Main',
  sources: [{ name: 'Backdrop', id: 'color_source', settings: { color } }, { name: 'Main', id: 'scene', settings: { items: [{ name: 'Backdrop', pos: { x: 0, y: 0 }, align: 5 }] } }],
});

async function start(t, data) {
  const app = express();
  app.use(express.json());
  app.use('/api/obs', buildObsSceneRouter({ paths: { root, data }, getConfig: () => ({ printer: { type: 'H2D' } }) }));
  const base = await listen(t, app);
  return async (route, body, method = body ? 'POST' : 'GET', headers = {}) => {
    const response = await fetch(base + '/api/obs' + route, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}

async function setup(t, before) {
  const data = await temporary(t);
  await fs.mkdir(path.join(data, 'scenes'));
  if (before) await before(data);
  const request = await start(t, data);
  return { data, request };
}

function create(request, name, json) { return request('/scenes', { name, json }); }
function save(request, { slug, revision, name }, json, newName = name) { return request('/scenes', { slug, revision, name: newName, json }); }
function apply(request, { slug, revision }, expectedUpdatedAt = null) { return request('/active', { slug, revision, expectedUpdatedAt }); }
function remove(request, { slug, revision }) { return request('/scenes/' + slug, { revision }, 'DELETE'); }

test('saving or deleting a draft leaves the applied snapshot and OBS export intact', async t => {
  const { request } = await setup(t);
  const original = collection();
  const { status, body: draft } = await create(request, 'Studio', original);
  assert.equal(status, 200);
  assert.match(draft.slug, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal((await request('/active')).body.slug, null);
  assert.equal((await apply(request, draft)).status, 200);
  const before = (await request('/active')).body;
  assert.equal(before.name, 'Studio');
  assert.equal(before.revision, draft.revision);
  const { body: unchanged } = await save(request, draft, original);
  assert.equal(unchanged.revision, draft.revision, 'An exact no-op save remains the applied revision');
  const changed = collection(3840, 2160, 4294967295);
  const { body: latest } = await save(request, draft, changed, 'Studio renamed');
  assert.equal(latest.slug, draft.slug);
  assert.notEqual(latest.revision, draft.revision);
  assert.deepEqual((await request('/published')).body, original);
  assert.deepEqual((await request('/active')).body, before);

  const forwarded = { 'X-Forwarded-Host': 'stream.example.test', 'X-Forwarded-Proto': 'https' };
  const exportScene = (await request('/single-source', null, 'GET', forwarded)).body;
  const obsInfo = (await request('/active', null, 'GET', forwarded)).body;
  assert.equal(obsInfo.obsUrl, exportScene.sources[0].settings.url);
  assert.deepEqual(exportScene.resolution, { x: 2560, y: 1440 });
  assert.deepEqual(exportScene.migration_resolution, exportScene.resolution);
  assert.deepEqual(exportScene.sources[0].settings, { url: 'https://stream.example.test/live', width: 2560, height: 1440 });
  const malformedProxy = { 'X-Forwarded-Host': '[' };
  const malformedActive = await request('/active', null, 'GET', malformedProxy);
  assert.equal(malformedActive.status, 200);
  assert.equal(malformedActive.body.revision, draft.revision);
  assert.equal(malformedActive.body.obsUrl, null);
  assert.equal((await request('/single-source', null, 'GET', malformedProxy)).status, 500);

  const previousPublicUrl = process.env.BAMBUBOARD_PUBLIC_URL;
  process.env.BAMBUBOARD_PUBLIC_URL = 'https://canonical.example.test:8443';
  try {
    const configured = (await request('/active', null, 'GET', forwarded)).body;
    const downloaded = (await request('/single-source', null, 'GET', forwarded)).body;
    assert.equal(configured.obsUrl, 'https://canonical.example.test:8443/live');
    assert.equal(configured.obsUrl, downloaded.sources[0].settings.url);
  } finally {
    if (previousPublicUrl === undefined) delete process.env.BAMBUBOARD_PUBLIC_URL;
    else process.env.BAMBUBOARD_PUBLIC_URL = previousPublicUrl;
  }

  const next = await apply(request, latest, before.updatedAt);
  assert.equal(next.status, 200);
  assert.equal(next.body.name, 'Studio renamed');
  assert.ok(next.body.updatedAt > before.updatedAt);
  assert.equal((await remove(request, latest)).status, 200);
  assert.deepEqual((await request('/published')).body, changed);
});

test('a draft stays readable during a pending or failed save and apply rejects a newer revision', async t => {
  const original = collection(), changed = collection(1280, 720);
  const { data, request } = await setup(t);
  const { body: draft } = await create(request, 'Studio', original);
  const { body: before } = await apply(request, draft);
  const writeFile = fs.writeFile.bind(fs);
  let started, release, fail = false;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'writeFile', async (file, text, options) => {
    if (String(file).includes(path.join(data, 'scenes', draft.slug + '.json'))) {
      await writeFile(file, '', options);
      started();
      await gate;
      if (fail) throw new Error('fixture write failure');
      return writeFile(file, text, { ...options, flag: 'w' });
    }
    return writeFile(file, text, options);
  });
  const pending = save(request, draft, changed);
  let staleApply;
  try {
    await ready;
    const read = await request('/scenes/' + draft.slug);
    assert.deepEqual(read.body, original);
    assert.equal(read.headers.get('X-Draft-Revision'), draft.revision);
    assert.deepEqual((await request('/published')).body, original);
    staleApply = apply(request, draft, before.updatedAt);
  } finally { release(); await pending; }
  const { body: latest } = await pending;
  assert.equal((await staleApply).body.code, 'DRAFT_CONFLICT');
  const current = await request('/scenes/' + draft.slug);
  assert.deepEqual(current.body, changed);
  assert.equal(current.headers.get('X-Draft-Revision'), latest.revision);
  fail = true;
  assert.equal((await save(request, latest, original)).status, 500);
  assert.deepEqual((await request('/scenes/' + draft.slug)).body, changed);
  assert.deepEqual((await request('/published')).body, original);
  assert.deepEqual((await fs.readdir(path.join(data, 'scenes'))).filter(file => file.endsWith('.tmp')), []);
});

test('legacy files keep their IDs and names, with live frozen before the first draft save', async t => {
  const original = collection();
  const { request } = await setup(t, async data => {
    await fs.writeFile(path.join(data, 'active-scene.json'), JSON.stringify({ slug: 'Existing' }));
    await fs.writeFile(path.join(data, 'scenes', 'Existing.json'), JSON.stringify(original));
  });
  const [draft] = (await request('/scenes')).body;
  assert.equal(draft.slug, 'Existing');
  assert.equal(draft.name, 'Existing');
  assert.equal((await request('/scenes/Existing')).headers.get('X-Draft-Revision'), draft.revision);
  assert.equal((await create(request, 'eXiSTing', original)).body.code, 'DRAFT_NAME_TAKEN');
  const changed = collection(1280, 720);
  const saved = await save(request, draft, changed, 'Legacy renamed');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.slug, 'Existing');
  assert.equal((await request('/scenes/Existing')).headers.get('X-Draft-Name'), 'Legacy renamed');
  assert.deepEqual((await request('/published')).body, original);
  assert.equal((await request('/active')).body.name, 'Existing');
});

test('draft names collide atomically and stale writers cannot update or delete the winning draft', async t => {
  const { request } = await setup(t);
  const original = collection();
  const replies = await Promise.all(['My  Draft', 'my draft'].map(name => create(request, name, original)));
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  assert.equal(replies.find(reply => reply.status === 409).body.code, 'DRAFT_NAME_TAKEN');
  const draft = replies.find(reply => reply.status === 200).body;
  assert.equal((await request('/scenes')).body.length, 1);

  const saved = await Promise.all([1280, 3840].map(width => save(request, draft, collection(width, 720))));
  assert.deepEqual(saved.map(reply => reply.status).sort(), [200, 409]);
  assert.equal(saved.find(reply => reply.status === 409).body.code, 'DRAFT_CONFLICT');
  assert.equal((await remove(request, draft)).body.code, 'DRAFT_CONFLICT');
  const copy = await create(request, 'A copy', original);
  assert.notEqual(copy.body.slug, draft.slug, 'A copy has a distinct ID');
  assert.equal((await save(request, copy.body, original, 'MY DRAFT')).body.code, 'DRAFT_NAME_TAKEN');
});

test('default output uses the matching template and apply requires both preconditions', async t => {
  const { request } = await setup(t);
  const info = (await request('/active')).body;
  assert.equal(info.slug, null);
  assert.equal(info.updatedAt, null);
  assert.equal(info.template, 'default-h2d');
  assert.equal(info.canRollback, false);
  const template = JSON.parse(await fs.readFile(path.join(root, 'OBS_settings/templates/default-h2d.json'), 'utf8'));
  assert.deepEqual(info.resolution, template.resolution);
  assert.ok((await request('/published')).body.sources.length > 0);
  const { body: draft } = await create(request, 'Studio', collection());
  assert.equal((await request('/active', { slug: '../outside', revision: draft.revision, expectedUpdatedAt: null })).status, 400);
  assert.equal((await request('/active', { slug: draft.slug, expectedUpdatedAt: null })).status, 400);
  assert.equal((await request('/active', { slug: draft.slug, revision: draft.revision })).status, 400);
  assert.equal((await apply(request, { ...draft, slug: 'missing' })).status, 404);
  assert.equal((await create(request, 'Bad JSON', '{broken')).status, 400);
  assert.equal((await request('/active/rollback', { expectedUpdatedAt: null })).body.code, 'NO_PREVIOUS_LIVE');
});

test('concurrent applications publish one reviewed revision and expose its explicit live scene', async t => {
  const { request } = await setup(t);
  const json = collection();
  json.sources.push({ id: 'scene', name: 'On stream', settings: { items: [] } });
  json.current_program_scene = 'On stream';
  const { body: a } = await create(request, 'A', json);
  const { body: b } = await create(request, 'B', json);
  const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => apply(request, i % 2 ? b : a)));
  assert.equal(replies.filter(reply => reply.status === 200).length, 1);
  assert.ok(replies.filter(reply => reply.status !== 200).every(reply => reply.status === 409 && reply.body.code === 'LIVE_CONFLICT'));
  const { body: active } = await request('/active');
  assert.equal(active.sceneName, 'On stream');
  const published = (await request('/published')).body;
  assert.equal(published.current_program_scene, 'On stream');
  assert.deepEqual(published.resolution, active.resolution);
});

test('rollback survives draft deletion and restart, and can restore the captured default output', async t => {
  const { data, request } = await setup(t);
  const original = collection();
  const defaultOutput = (await request('/published', null, 'GET', { 'x-forwarded-host': 'stream.example.test' })).body;
  const { body: first } = await create(request, 'First', original);
  const { body: second } = await create(request, 'Second', collection(1280, 720));
  const { body: liveA } = await apply(request, first);
  assert.equal(liveA.canRollback, true);
  const repeated = await apply(request, first, liveA.updatedAt);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.updatedAt, liveA.updatedAt, 'Applying the same revision should preserve the rollback target');
  const fallback = await request('/active/rollback', { expectedUpdatedAt: liveA.updatedAt });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.slug, null);
  assert.ok(fallback.body.updatedAt > liveA.updatedAt);
  assert.deepEqual((await request('/published', null, 'GET', { 'x-forwarded-host': 'stream.example.test' })).body, defaultOutput);
  const { body: liveAgain } = await apply(request, first, fallback.body.updatedAt);
  const { body: liveB } = await apply(request, second, liveAgain.updatedAt);
  assert.equal((await remove(request, first)).status, 200);

  const restarted = await start(t, data);
  assert.equal((await restarted('/active/rollback', { expectedUpdatedAt: liveAgain.updatedAt })).body.code, 'LIVE_CONFLICT');
  const rollback = await restarted('/active/rollback', { expectedUpdatedAt: liveB.updatedAt });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.body.name, 'First');
  assert.equal(rollback.body.revision, first.revision);
  assert.ok(rollback.body.updatedAt > liveB.updatedAt);
  assert.deepEqual((await restarted('/published')).body, original);
});

test('a damaged draft cannot alter a frozen legacy live record', async t => {
  const original = collection();
  const { request } = await setup(t, async data => {
    await fs.writeFile(path.join(data, 'active-scene.json'), JSON.stringify({ slug: 'Old name', scene: original, publishedAt: 1234 }));
    await fs.writeFile(path.join(data, 'scenes', 'Old name.json'), '{damaged');
  });
  assert.equal((await request('/active')).body.name, 'Old name');
  assert.equal((await apply(request, { slug: 'Old name', revision: 'old' }, 1234)).status, 500);
  assert.deepEqual((await request('/published')).body, original);
  assert.equal((await create(request, 'old name', original)).status, 409);
  const { body: available } = await create(request, 'Replacement', collection(1280, 720));
  assert.equal((await apply(request, available, 1234)).status, 200, 'A failed publication does not poison the mutation queue');
});
