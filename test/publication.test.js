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
async function setup(t, before) {
  const data = await temporary(t);
  await fs.mkdir(path.join(data, 'scenes'));
  if (before) await before(data);
  const app = express(); app.use(express.json());
  app.use('/api/obs', buildObsSceneRouter({ paths: { root, data }, getConfig: () => ({ printer: { type: 'H2D' } }) }));
  const base = await listen(t, app);
  const request = async (route, body, method = body ? 'POST' : 'GET', headers = {}) => {
    const response = await fetch(base + '/api/obs' + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { data, request };
}
test('draft changes stay isolated until publish; OBS export matches the published canvas', async t => {
  const { request } = await setup(t);
  const original = collection();
  assert.equal((await request('/scenes', { name: 'Studio', json: original })).status, 200);
  assert.equal((await request('/active')).body.slug, null);
  assert.equal((await request('/active', { slug: 'Studio' })).status, 200);
  const before = (await request('/active')).body;
  const changed = collection(3840, 2160, 4294967295);
  await request('/scenes', { name: 'Studio', json: changed });
  assert.deepEqual((await request('/published')).body, original);
  assert.deepEqual((await request('/active')).body, before);
  const exportScene = (await request('/single-source', null, 'GET', { 'X-Forwarded-Host': 'stream.example.test', 'X-Forwarded-Proto': 'https' })).body;
  assert.deepEqual(exportScene.resolution, { x: 2560, y: 1440 });
  assert.deepEqual(exportScene.migration_resolution, exportScene.resolution);
  assert.deepEqual(exportScene.sources[0].settings, { url: 'https://stream.example.test/live', width: 2560, height: 1440 });
  await request('/active', { slug: 'Studio' });
  assert.deepEqual((await request('/published')).body, changed);
  assert.ok((await request('/active')).body.updatedAt > before.updatedAt);
  await request('/scenes/Studio', null, 'DELETE');
  assert.deepEqual((await request('/published')).body, changed);
});
test('legacy active scene is preserved before the first draft save', async t => {
  const original = collection();
  const { request } = await setup(t, async data => {
    await fs.writeFile(path.join(data, 'active-scene.json'), JSON.stringify({ slug: 'Existing' }));
    await fs.writeFile(path.join(data, 'scenes', 'Existing.json'), JSON.stringify(original));
  });
  await request('/scenes', { name: 'Existing', json: collection(1280, 720) });
  assert.deepEqual((await request('/published')).body, original);
  assert.equal((await request('/active')).body.slug, 'Existing');
});
test('unpublished output uses the matching template and rejects invalid publication', async t => {
  const { request } = await setup(t);
  const info = (await request('/active')).body;
  assert.equal(info.slug, null); assert.equal(info.template, 'default-h2d');
  const template = JSON.parse(await fs.readFile(path.join(root, 'OBS_settings/templates/default-h2d.json'), 'utf8'));
  assert.deepEqual(info.resolution, template.resolution);
  assert.ok((await request('/published')).body.sources.length > 0);
  assert.equal((await request('/active', { slug: '../outside' })).status, 400);
  assert.equal((await request('/active', { slug: 'missing' })).status, 404);
  assert.equal((await request('/scenes', { name: 'Bad JSON', json: '{broken' })).status, 400);
});
test('concurrent publications always expose a complete snapshot', async t => {
  const { request } = await setup(t);
  await request('/scenes', { name: 'A', json: collection() });
  await request('/scenes', { name: 'B', json: collection(1280, 720) });
  const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/active', { slug: i % 2 ? 'B' : 'A' })));
  assert.ok(replies.every(r => r.status === 200));
  const times = replies.map(r => r.body.updatedAt); assert.equal(new Set(times).size, 8);
  const active = (await request('/active')).body;
  assert.deepEqual((await request('/published')).body.resolution, active.resolution);
});
test('published output survives damaged drafts, deletion and an application restart', async t => {
  const { data, request } = await setup(t);
  const original = collection();
  await request('/scenes', { name: 'Durable', json: original });
  await request('/active', { slug: 'Durable' });
  await fs.writeFile(path.join(data, 'scenes', 'Durable.json'), '{damaged');
  assert.equal((await request('/active', { slug: 'Durable' })).status, 500);
  assert.deepEqual((await request('/published')).body, original);
  await request('/scenes/Durable', null, 'DELETE');
  const restarted = express(); restarted.use(express.json());
  restarted.use('/api/obs', buildObsSceneRouter({ paths: { root, data }, getConfig: () => ({ printer: { type: 'H2D' } }) }));
  const base = await listen(t, restarted);
  assert.deepEqual(await fetch(base + '/api/obs/published').then(r => r.json()), original);
  await request('/scenes', { name: 'Replacement', json: collection(1280, 720) });
  assert.equal((await request('/active', { slug: 'Replacement' })).status, 200, 'A failed publication does not poison the queue');
});
