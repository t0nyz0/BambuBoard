const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('node:crypto');

const SAFE_NAME = /^[a-zA-Z0-9_\-. ]{1,64}$/;
const PKG_VERSION = require('../../package.json').version;

function buildObsSceneRouter({ paths, getConfig = () => ({}) }) {
  const router = express.Router();
  const TEMPLATES_DIR = path.join(paths.root, 'OBS_settings', 'templates');
  const SCENES_DIR = path.join(paths.data, 'scenes');
  // Pointer to the currently-published scene that `/live` renders by default.
  // Runtime state (data/ is gitignored), so it's a small standalone file rather
  // than part of the committed config.
  const ACTIVE_FILE = path.join(paths.data, 'active-scene.json');

  fs.mkdirSync(SCENES_DIR, { recursive: true });

  async function saveDraft(name, text) {
    const file = path.join(SCENES_DIR, `${name}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await fsp.rename(temporary, file);
    } finally { await fsp.rm(temporary, { force: true }); }
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

  // Freeze legacy active pointers once on startup. The scene files remain
  // unchanged; older versions still understand the slug in this record.
  try {
    const record = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    if (SAFE_NAME.test(record.slug || '') && !record.scene) {
      const file = path.join(SCENES_DIR, `${record.slug}.json`);
      record.scene = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.publishedAt = fs.statSync(file).mtimeMs;
      fs.writeFileSync(ACTIVE_FILE + '.tmp', JSON.stringify(record));
      fs.renameSync(ACTIVE_FILE + '.tmp', ACTIVE_FILE);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[bambuboard] could not snapshot previous published scene:', e.message);
  }
  async function readPublished() {
    try {
      const record = JSON.parse(await fsp.readFile(ACTIVE_FILE, 'utf8'));
      if (!SAFE_NAME.test(record.slug || '')) return null;
      const scene = record.scene || JSON.parse(await fsp.readFile(path.join(SCENES_DIR, `${record.slug}.json`), 'utf8'));
      const updatedAt = record.publishedAt || (await fsp.stat(path.join(SCENES_DIR, `${record.slug}.json`))).mtimeMs;
      return { slug: record.slug, scene, updatedAt };
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
    if (published) return { ...published, resolution: resolutionOf(published.scene) };
    const template = getConfig().printer?.type === 'H2D' ? 'default-h2d' : 'default-x1';
    const scene = JSON.parse(await fsp.readFile(path.join(TEMPLATES_DIR, `${template}.json`), 'utf8'));
    return { slug: null, updatedAt: null, label: 'Default scene', template, scene, resolution: resolutionOf(scene) };
  }


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
      const files = (await fsp.readdir(SCENES_DIR)).filter(f => f.endsWith('.json'));
      const out = [];
      for (const f of files) {
        const slug = f.replace(/\.json$/, '');
        try {
          const stat = await fsp.stat(path.join(SCENES_DIR, f));
          out.push({ slug, name: slug, updatedAt: stat.mtimeMs });
        } catch (_) {}
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/scenes/:slug', async (req, res) => {
    const slug = req.params.slug;
    if (!SAFE_NAME.test(slug)) return res.status(400).json({ error: 'invalid name' });
    try {
      const raw = await fsp.readFile(path.join(SCENES_DIR, `${slug}.json`), 'utf-8');
      const out = substituteHost(raw, hostFromReq(req), originFromReq(req));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.json"`);
      res.send(out);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'scene not found' });
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/scenes', async (req, res) => {
    const { name, json } = req.body || {};
    if (!name || !SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid name' });
    if (!json) return res.status(400).json({ error: 'missing json' });
    try {
      const text = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
      JSON.parse(text); // validate
      await saveDraft(name, text);
      // Return the slug so callers (the scene editor) can auto-select the new
      // entry in their saved-scenes dropdown without a page reload.
      res.json({ ok: true, slug: name });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/scenes/:slug', async (req, res) => {
    const slug = req.params.slug;
    if (!SAFE_NAME.test(slug)) return res.status(400).json({ error: 'invalid name' });
    try {
      await fsp.unlink(path.join(SCENES_DIR, `${slug}.json`));
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      res.status(500).json({ error: e.message });
    }
  });

  // -------- Active ("published") scene --------
  // `/live` renders this scene by default. The editor's "Set as Live" sets it,
  // and /live polls it to auto-update when a new scene is published.

  // Publication identity is a snapshot, so saving or deleting a draft does
  // not alter an already-published output.
  router.get('/active', async (req, res) => {
    try {
      const { scene, ...info } = await outputInfo();
      res.setHeader('Cache-Control', 'no-store');
      res.json(info);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/published', async (req, res) => {
    try {
      const { scene } = await outputInfo();
      res.setHeader('Cache-Control', 'no-store');
      res.type('json').send(substituteHost(JSON.stringify(scene), hostFromReq(req), originFromReq(req)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  let publishing = Promise.resolve();
  router.post('/active', async (req, res) => {
    const { slug } = req.body || {};
    if (!slug || !SAFE_NAME.test(slug)) return res.status(400).json({ error: 'invalid name' });
    const operation = publishing.then(async () => {
      const scene = JSON.parse(await fsp.readFile(path.join(SCENES_DIR, `${slug}.json`), 'utf8'));
      const current = await readPublished();
      const publishedAt = Math.max(Date.now(), (current?.updatedAt || 0) + 1);
      const tmp = ACTIVE_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify({ slug, scene, publishedAt }));
      await fsp.rename(tmp, ACTIVE_FILE);
      return { ok: true, slug, updatedAt: publishedAt };
    });
    publishing = operation.catch(() => {});
    try { res.json(await operation); }
    catch (e) { res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: e.code === 'ENOENT' ? 'scene not found' : e.message }); }
  });

  // -------- One-click OBS helper --------
  // GET /api/obs/single-source — a minimal OBS scene collection containing a
  // single Browser Source pointing at <HOST>/live. This is the entire OBS
  // setup now: import it (or just add one Browser Source to this URL by hand).
  // Mirrors the proven top-level structure of the shipped templates so OBS
  // imports it cleanly.
  router.get('/single-source', async (req, res) => {
    try {
    const liveUrl = `${originFromReq(req)}/live`;
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
