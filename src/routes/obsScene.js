const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SAFE_NAME = /^[a-zA-Z0-9_\-. ]{1,64}$/;
const PKG_VERSION = require('../../package.json').version;

function buildObsSceneRouter({ paths }) {
  const router = express.Router();
  const TEMPLATES_DIR = path.join(paths.root, 'OBS_settings', 'templates');
  const SCENES_DIR = path.join(paths.data, 'scenes');

  fs.mkdirSync(SCENES_DIR, { recursive: true });

  function hostFromReq(req) {
    return req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080';
  }

  // Replace `<HOST>` with the request's host and `<VERSION>` with the current
  // BambuBoard version. Templates use these as placeholders so we don't hard-
  // code stale info like "BambuBoard 1.2.4" — the served scene file always
  // matches what's actually running.
  function substituteTemplate(jsonText, host) {
    return jsonText.replace(/<HOST>/g, host).replace(/<VERSION>/g, PKG_VERSION);
  }
  // Back-compat alias.
  const substituteHost = (jsonText, host) => substituteTemplate(jsonText, host);

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
      const out = substituteHost(raw, hostFromReq(req));
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
      let text = substituteHost(raw, host);

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
        await fsp.writeFile(path.join(SCENES_DIR, `${name}.json`), out);
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
      const out = substituteHost(raw, hostFromReq(req));
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
      await fsp.writeFile(path.join(SCENES_DIR, `${name}.json`), text);
      res.json({ ok: true });
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

  return router;
}

module.exports = { buildObsSceneRouter };
