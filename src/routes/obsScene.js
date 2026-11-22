const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const SAFE_NAME = /^[a-zA-Z0-9_\-. ]{1,64}$/;
const PKG_VERSION = require('../../package.json').version;
const DRAFT_METADATA = '__bambuboardDraft';
const validName = value => typeof value === 'string' && SAFE_NAME.test(value) && value.trim().length > 0;
const normalizedName = name => name.trim().replace(/ +/g, ' ').toLowerCase();
const revisionOf = raw => createHash('sha256').update(raw).digest('hex');
const isCollection = value => value && typeof value === 'object' && !Array.isArray(value);

function sceneNameOf(collection) {
  const scenes = Array.isArray(collection?.sources)
    ? collection.sources.filter(source => source?.id === 'scene' && typeof source.name === 'string' && source.name)
    : [];
  const requested = collection?.current_program_scene || collection?.current_scene;
  return scenes.find(scene => scene.name === requested)?.name || scenes[0]?.name || null;
}

class SceneError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function handleSceneError(res, error) {
  if (error instanceof SceneError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error.code === 'ENOENT') return res.status(404).json({ error: 'Draft no longer exists.', code: 'DRAFT_NOT_FOUND' });
  return res.status(500).json({ error: error.message });
}

function buildObsSceneRouter({ paths, getConfig = () => ({}) }) {
  const router = express.Router();
  const TEMPLATES_DIR = path.join(paths.root, 'OBS_settings', 'templates');
  const SCENES_DIR = path.join(paths.data, 'scenes');
  // Pointer to the currently-published scene that `/live` renders by default.
  // Runtime state (data/ is gitignored), so it's a small standalone file rather
  // than part of the committed config.
  const ACTIVE_FILE = path.join(paths.data, 'active-scene.json');

  fs.mkdirSync(SCENES_DIR, { recursive: true });

  // Store the metadata and document in the same atomically replaced file.
  // Older installs can still read these files as OBS collections.
  function decodeDraft(slug, raw, updatedAt) {
    const scene = JSON.parse(raw);
    if (!isCollection(scene)) throw new SceneError(400, 'INVALID_DRAFT', 'The draft must be an OBS scene collection.');
    const metadata = scene[DRAFT_METADATA];
    const stored = metadata?.format === 1 && validName(metadata.name) && typeof metadata.writeId === 'string';
    if (stored) delete scene[DRAFT_METADATA];
    return { slug, name: stored ? metadata.name : slug, revision: revisionOf(raw), updatedAt, scene };
  }

  const draftPath = slug => path.join(SCENES_DIR, `${slug}.json`);

  async function readStampedFile(filename) {
    const file = await fsp.open(filename);
    try {
      const [raw, stat] = await Promise.all([file.readFile('utf8'), file.stat()]);
      return { raw, updatedAt: stat.mtimeMs };
    } finally { await file.close(); }
  }

  async function readDraft(slug) {
    const { raw, updatedAt } = await readStampedFile(draftPath(slug));
    return decodeDraft(slug, raw, updatedAt);
  }

  async function writeAtomically(file, text) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await fsp.rename(temporary, file);
    } finally { await fsp.rm(temporary, { force: true }); }
  }

  async function storedDrafts() {
    const files = (await fsp.readdir(SCENES_DIR, { withFileTypes: true }))
      .filter(file => file.isFile() && file.name.endsWith('.json') && validName(file.name.slice(0, -5)));
    return Promise.all(files.map(async file => {
      const slug = file.name.slice(0, -5);
      try {
        const { scene, ...entry } = await readDraft(slug);
        return entry;
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        // Reserve the name of an unreadable legacy draft too.
        if (e instanceof SyntaxError || e instanceof SceneError) return { slug, name: slug, unreadable: true };
        throw e;
      }
    }));
  }

  let mutationQueue = Promise.resolve();
  function mutate(action) {
    const operation = mutationQueue.then(action);
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  function originFromReq(req) {
    if (process.env.BAMBUBOARD_PUBLIC_URL) {
      const configured = new URL(process.env.BAMBUBOARD_PUBLIC_URL);
      if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('Public URL must use HTTP or HTTPS');
      return configured.origin;
    }
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080').split(',')[0].trim();
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = ['http', 'https'].includes(forwarded) ? forwarded : req.protocol;
    return new URL(`${protocol}://${host}`).origin;
  }
  function hostFromReq(req) { return new URL(originFromReq(req)).host; }
  function obsLiveUrl(req) { return `${originFromReq(req)}/live`; }

  // Freeze legacy active pointers once on startup. The scene files remain
  // unchanged; older versions still understand the slug in this record.
  try {
    const record = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    if (validName(record.slug) && !record.scene) {
      const file = draftPath(record.slug);
      const draft = decodeDraft(record.slug, fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs);
      record.scene = draft.scene;
      record.name = draft.name;
      record.revision = draft.revision;
      record.publishedAt = draft.updatedAt;
      const temporary = `${ACTIVE_FILE}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, ACTIVE_FILE);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[bambuboard] could not snapshot previous published scene:', e.message);
  }
  function liveInfo(record, updatedAt) {
    const { slug, scene, previous } = record;
    return {
      slug, name: record.name || slug || 'Default scene', scene, updatedAt,
      sceneName: sceneNameOf(scene), revision: record.revision ?? null,
      canRollback: Boolean(previous?.scene), previous, resolution: resolutionOf(scene),
      ...(slug === null ? { label: 'Default scene', template: record.template } : {}),
    };
  }

  async function readPublished() {
    try {
      const { raw, updatedAt: fileTimestamp } = await readStampedFile(ACTIVE_FILE);
      const record = JSON.parse(raw);
      if (!validName(record.slug) && !(record.slug === null && record.scene)) return null;
      const draft = record.scene ? null : await readDraft(record.slug);
      const updatedAt = record.publishedAt ?? draft?.updatedAt ?? fileTimestamp;
      return liveInfo({ ...draft, ...record, scene: record.scene || draft.scene }, updatedAt);
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  function resolutionOf(scene) {
    const { x, y } = scene?.resolution || {};
    return {
      x: Number.isInteger(x) && x > 0 ? x : 1920,
      y: Number.isInteger(y) && y > 0 ? y : 1080,
    };
  }
  async function outputInfo() {
    const published = await readPublished();
    if (published) return published;
    const template = getConfig().printer?.type === 'H2D' ? 'default-h2d' : 'default-x1';
    const scene = JSON.parse(await fsp.readFile(path.join(TEMPLATES_DIR, `${template}.json`), 'utf8'));
    return {
      slug: null, name: 'Default scene', updatedAt: null, label: 'Default scene', template, scene,
      sceneName: sceneNameOf(scene), revision: null, canRollback: false, resolution: resolutionOf(scene),
    };
  }

  function publicOutputInfo({ scene, previous, ...info }) { return info; }


  // Replace `<HOST>` with the request's host and `<VERSION>` with the current
  // BambuBoard version. Templates use these as placeholders so we don't hard-
  // code stale info like "BambuBoard 1.2.4" — the served scene file always
  // matches what's actually running.
  function substituteTemplate(jsonText, host, origin = `http://${host}`) {
    return jsonText.replace(/https?:\/\/<HOST>/g, origin).replace(/<HOST>/g, host).replace(/<VERSION>/g, PKG_VERSION);
  }
  // Back-compat alias.
  const substituteHost = (jsonText, host, origin) => substituteTemplate(jsonText, host, origin);

  // -------- Templates (read-only, committed) --------

  router.get('/templates', async (req, res) => {
    try {
      const files = (await fsp.readdir(TEMPLATES_DIR))
        .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
      const out = [];
      for (const f of files) {
        const slug = f.replace(/\.json$/, '');
        let meta = { slug, label: slug, description: '', recommendedTypes: [] };
        try {
          // Look for sidecar metadata at templates/<slug>.meta.json
          const metaPath = path.join(TEMPLATES_DIR, `${slug}.meta.json`);
          if (fs.existsSync(metaPath)) {
            meta = { ...meta, ...JSON.parse(await fsp.readFile(metaPath, 'utf-8')) };
          }
        } catch (_) {}
        out.push(meta);
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/templates/:slug', async (req, res) => {
    const slug = req.params.slug;
    if (!SAFE_NAME.test(slug)) return res.status(400).json({ error: 'invalid name' });
    try {
      const full = path.join(TEMPLATES_DIR, `${slug}.json`);
      const raw = await fsp.readFile(full, 'utf-8');
      const out = substituteHost(raw, hostFromReq(req), originFromReq(req));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="bambuboard-${slug}.json"`);
      res.send(out);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'template not found' });
      res.status(500).json({ error: e.message });
    }
  });

  // /raw is what the scene editor fetches when loading a template into
  // the visual editor. Substitute <VERSION> so the scene name shows the
  // current BambuBoard version (e.g. "BambuBoard 3.0.0"); leave <HOST>
  // unsubstituted because the editor binds widget URLs to its own host
  // when iframes are mounted, and we want the raw template to remain
  // editable / portable across hosts.
  router.get('/templates/:slug/raw', async (req, res) => {
    const slug = req.params.slug;
    if (!SAFE_NAME.test(slug)) return res.status(400).json({ error: 'invalid name' });
    try {
      const raw = await fsp.readFile(path.join(TEMPLATES_DIR, `${slug}.json`), 'utf-8');
      const out = raw.replace(/<VERSION>/g, PKG_VERSION);
      res.setHeader('Content-Type', 'application/json');
      res.send(out);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'template not found' });
      res.status(500).json({ error: e.message });
    }
  });

  // -------- Customized scenes (Tier 1: URL params per widget) --------
  // POST /api/obs/customize  { template: "default-x1", customizations: { "ams": { theme: "dark", accent: "51a34f" }, ... }, name: "my-scene" }
  // Returns the scene JSON with each widget URL augmented by `?theme=...&accent=...`.
  router.post('/customize', async (req, res) => {
    try {
      const { template, customizations = {}, name } = req.body || {};
      if (!template || !SAFE_NAME.test(template)) return res.status(400).json({ error: 'invalid template' });
      const raw = await fsp.readFile(path.join(TEMPLATES_DIR, `${template}.json`), 'utf-8');
      const host = hostFromReq(req);
      let text = substituteHost(raw, host, originFromReq(req));

      // Walk the parsed JSON, decorate any source.url that points at /widgets/<slug>/.
      // We append ?theme=...&accent=...&fontSize=... directly without using URL() so we
      // preserve the literal host (it could be raw IPv4, hostname, or our <HOST> placeholder).
      const data = JSON.parse(text);
      const widgetRe = /\/widgets\/([a-zA-Z0-9_\-]+)\//;
      function decorate(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (typeof obj.url === 'string') {
          const m = obj.url.match(widgetRe);
          if (m) {
            const slug = m[1];
            const cust = customizations[slug];
            if (cust && typeof cust === 'object') {
              const allowedKeys = ['theme', 'accent', 'fontSize', 'title', 'pad'];
              const params = [];
              for (const k of allowedKeys) {
                if (cust[k] != null && cust[k] !== '') {
                  params.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(cust[k]))}`);
                }
              }
              if (params.length) {
                // Strip any pre-existing copies of these keys to avoid duplicates
                const stripPattern = new RegExp(`([?&])(${allowedKeys.join('|')})=[^&]*&?`, 'g');
                const base = obj.url.replace(stripPattern, '$1').replace(/[?&]$/, '');
                obj.url = base + (base.includes('?') ? '&' : '?') + params.join('&');
              }
            }
          }
        }
        for (const k of Object.keys(obj)) decorate(obj[k]);
      }
      decorate(data);

      const out = JSON.stringify(data, null, 2);
      if (name) {
        if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid name' });
        await saveDraft(name, out);
        return res.json({ ok: true, savedAs: name });
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="bambuboard-custom.json"`);
      res.send(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // -------- User scenes (mutable, gitignored) --------

  router.get('/scenes', async (req, res) => {
    try {
      const out = (await storedDrafts()).filter(draft => draft && !draft.unreadable);
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/scenes/:slug', async (req, res) => {
    const slug = req.params.slug;
    if (!validName(slug)) return res.status(400).json({ error: 'Invalid draft ID.' });
    try {
      const draft = await readDraft(slug);
      const out = substituteHost(JSON.stringify(draft.scene), hostFromReq(req), originFromReq(req));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${draft.name}.json"`);
      res.setHeader('X-Draft-Revision', draft.revision);
      res.setHeader('X-Draft-Name', draft.name);
      res.setHeader('Cache-Control', 'no-store');
      res.send(out);
    } catch (e) { handleSceneError(res, e); }
  });

  router.post('/scenes', async (req, res) => {
    const { name: enteredName, slug, revision, json } = req.body || {};
    const updating = slug !== undefined;
    if (!validName(enteredName) || (updating && !validName(slug))) {
      return res.status(400).json({ error: 'Enter a valid draft name and ID.' });
    }
    if (updating && typeof revision !== 'string') {
      return res.status(400).json({ error: 'Reload the draft before saving.' });
    }
    const name = enteredName.trim();
    let scene;
    try {
      scene = typeof json === 'string' ? JSON.parse(json) : json;
      if (!isCollection(scene) || !sceneNameOf(scene)) throw new Error('Missing scene');
    } catch (_) {
      return res.status(400).json({ error: 'The draft must contain a valid OBS scene collection.', code: 'INVALID_DRAFT' });
    }
    try {
      res.json(await mutate(async () => {
        const current = updating ? await readDraft(slug) : null;
        if (current && current.revision !== revision) {
          throw new SceneError(409, 'DRAFT_CONFLICT', 'This draft changed in another window. Reload it before saving or save a copy.');
        }
        if (current?.name === name && isDeepStrictEqual(current.scene, scene)) {
          return { ok: true, slug, name, revision: current.revision };
        }
        const normalized = normalizedName(name);
        if (!current || normalized !== normalizedName(current.name)) {
          const exists = (await storedDrafts()).some(draft => draft && draft.slug !== slug && normalizedName(draft.name) === normalized);
          if (exists) throw new SceneError(409, 'DRAFT_NAME_TAKEN', 'A draft with that name already exists. Choose another name.');
        }
        const id = slug || randomUUID();
        const text = JSON.stringify({ ...scene, [DRAFT_METADATA]: { format: 1, name, writeId: randomUUID() } });
        await writeAtomically(draftPath(id), text);
        return { ok: true, slug: id, name, revision: revisionOf(text) };
      }));
    } catch (e) { handleSceneError(res, e); }
  });

  router.delete('/scenes/:slug', async (req, res) => {
    const { slug } = req.params;
    const { revision } = req.body || {};
    if (!validName(slug) || typeof revision !== 'string') {
      return res.status(400).json({ error: 'Reload the draft before deleting it.' });
    }
    try {
      await mutate(async () => {
        const { raw } = await readStampedFile(draftPath(slug));
        if (revisionOf(raw) !== revision) {
          throw new SceneError(409, 'DRAFT_CONFLICT', 'This draft changed in another window. Reload it before deleting.');
        }
        await fsp.unlink(draftPath(slug));
      });
      res.json({ ok: true });
    } catch (e) { handleSceneError(res, e); }
  });

  // -------- Live scene and one-step rollback --------

  // Live output and its previous version are immutable snapshots. Serving
  // either of them never depends on the draft's continued presence.
  router.get('/active', async (req, res) => {
    try {
      const info = publicOutputInfo(await outputInfo());
      let obsUrl = null;
      // A malformed proxy header or public URL should only affect OBS export.
      try { obsUrl = obsLiveUrl(req); } catch (_) {}
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...info, obsUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/published', async (req, res) => {
    try {
      const { scene } = await outputInfo();
      res.setHeader('Cache-Control', 'no-store');
      res.type('json').send(substituteHost(JSON.stringify(scene), hostFromReq(req), originFromReq(req)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  const validLiveVersion = value => value === null || Number.isFinite(value);
  function checkLiveVersion(current, expectedUpdatedAt) {
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new SceneError(409, 'LIVE_CONFLICT', 'Live output changed in another window. Review the current output and try again.');
    }
  }

  function liveSnapshot({ slug, name, revision, scene, template }) {
    return { slug, name, revision, scene, template };
  }

  async function replaceLive(next, current) {
    const publishedAt = Math.max(Date.now(), (current.updatedAt ?? 0) + 1);
    const record = { ...liveSnapshot(next), publishedAt, previous: liveSnapshot(current) };
    await writeAtomically(ACTIVE_FILE, JSON.stringify(record));
    return { ok: true, ...publicOutputInfo(liveInfo(record, publishedAt)) };
  }

  router.post('/active', async (req, res) => {
    const { slug, revision, expectedUpdatedAt } = req.body || {};
    if (!validName(slug) || typeof revision !== 'string' || !validLiveVersion(expectedUpdatedAt)) {
      return res.status(400).json({ error: 'Select a saved draft and check the current live output before applying.' });
    }
    try {
      res.json(await mutate(async () => {
        const current = await outputInfo();
        checkLiveVersion(current, expectedUpdatedAt);
        const draft = await readDraft(slug);
        if (draft.revision !== revision) {
          throw new SceneError(409, 'DRAFT_CONFLICT', 'This draft changed after it was saved in this window. Reload it before applying.');
        }
        if (!sceneNameOf(draft.scene)) {
          throw new SceneError(400, 'INVALID_DRAFT', 'The draft does not contain a scene to apply.');
        }
        if (current.slug === draft.slug && current.revision === draft.revision) {
          return { ok: true, ...publicOutputInfo(current) };
        }
        return replaceLive(draft, current);
      }));
    } catch (e) { handleSceneError(res, e); }
  });

  router.post('/active/rollback', async (req, res) => {
    const { expectedUpdatedAt } = req.body || {};
    if (!validLiveVersion(expectedUpdatedAt)) {
      return res.status(400).json({ error: 'Check the current live output before restoring the previous version.' });
    }
    try {
      res.json(await mutate(async () => {
        const current = await outputInfo();
        checkLiveVersion(current, expectedUpdatedAt);
        if (!current.canRollback) throw new SceneError(409, 'NO_PREVIOUS_LIVE', 'There is no previous live output to restore.');
        return replaceLive(current.previous, current);
      }));
    } catch (e) { handleSceneError(res, e); }
  });

  // -------- One-click OBS helper --------
  // GET /api/obs/single-source — a minimal OBS scene collection containing a
  // single Browser Source pointing at <HOST>/live. This is the entire OBS
  // setup now: import it (or just add one Browser Source to this URL by hand).
  // Mirrors the proven top-level structure of the shipped templates so OBS
  // imports it cleanly.
  router.get('/single-source', async (req, res) => {
    try {
    const liveUrl = obsLiveUrl(req);
    const { resolution } = await outputInfo();
    const collection = {
      name: `BambuBoard ${PKG_VERSION}`,
      groups: [],
      scene_order: [{ name: 'BambuBoard' }],
      current_scene: 'BambuBoard',
      current_program_scene: 'BambuBoard',
      canvases: [],
      current_transition: 'Cut',
      transition_duration: 300,
      transitions: [],
      quick_transitions: [
        { name: 'Cut', duration: 300, hotkeys: [], id: 1, fade_to_black: false },
        { name: 'Fade', duration: 300, hotkeys: [], id: 2, fade_to_black: false },
      ],
      saved_projectors: [],
      preview_locked: false,
      scaling_enabled: false,
      scaling_level: -9,
      scaling_off_x: 0,
      scaling_off_y: 0,
      'virtual-camera': { type2: 3 },
      resolution: { ...resolution },
      migration_resolution: { ...resolution },
      version: 2,
      sources: [
        {
          prev_ver: 503316480,
          name: 'BambuBoard Live',
          id: 'browser_source',
          versioned_id: 'browser_source',
          settings: { url: liveUrl, width: resolution.x, height: resolution.y },
          enabled: true, mixers: 255, sync: 0, flags: 0, volume: 1, balance: 0.5,
          muted: false, monitoring_type: 0, private_settings: {},
        },
        {
          prev_ver: 503316480,
          name: 'BambuBoard',
          id: 'scene',
          versioned_id: 'scene',
          settings: {
            custom_size: false,
            id_counter: 1,
            items: [{
              name: 'BambuBoard Live', visible: true, locked: false, rot: 0,
              align: 5, bounds_type: 0, bounds_align: 0,
              crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0,
              id: 1, pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, bounds: { x: 0, y: 0 },
              scale_filter: 'disable', blend_method: 'default', blend_type: 'normal',
            }],
          },
        },
      ],
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="bambuboard-live.json"');
    res.send(JSON.stringify(collection, null, 2));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { buildObsSceneRouter };
