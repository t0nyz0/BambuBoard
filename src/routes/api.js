const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { PRINTER_TYPES, PRINTER_CAPS, capsFor } = require('../lib/caps');
const { testConnection } = require('../mqtt');
const { isFirstRun } = require('../config');

function readTokenSync(paths) {
  try {
    const txt = fs.readFileSync(path.join(paths.data, 'accessToken.json'), 'utf-8');
    const t = JSON.parse(txt);
    return { signedIn: !!(t && t.accessToken), email: t?.email || null };
  } catch (_) { return { signedIn: false, email: null }; }
}

function buildApiRouter({ getConfig, saveConfig, reloadPrinter, getStatus, paths }) {
  const router = express.Router();

  router.get('/settings', (req, res) => {
    const c = getConfig();
    const safe = JSON.parse(JSON.stringify(c));
    if (safe.printer) {
      safe.printer.accessCodeSet = !!c.printer.accessCode && c.printer.accessCode !== 'FILL_THIS_OUT';
      safe.printer.accessCode = '';
    }
    res.json({ ...safe, _meta: { firstRun: !c.printer || c.printer.serialNumber === 'FILL_THIS_OUT' } });
  });

  router.put('/settings', async (req, res) => {
    try {
      const incoming = req.body || {};
      const current = getConfig();
      const merged = { ...current, ...incoming };
      // Preserve the existing access code when the client sends a blank one (it never receives the real value).
      if (incoming.printer) {
        merged.printer = { ...current.printer, ...incoming.printer };
        if (!incoming.printer.accessCode) merged.printer.accessCode = current.printer.accessCode;
      }
      merged.cloudAuth = { ...current.cloudAuth, ...(incoming.cloudAuth || {}) };
      await saveConfig(merged);
      reloadPrinter();
      res.json({ ok: true });
    } catch (e) {
      console.error('PUT /api/settings failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/test-connection', async (req, res) => {
    const { url, port, serialNumber, accessCode } = req.body || {};
    let creds = { url, port, serialNumber, accessCode };
    // Allow re-using the saved access code without sending it back from the client.
    if (!accessCode) {
      const c = getConfig();
      if (c.printer && c.printer.accessCode) creds.accessCode = c.printer.accessCode;
    }
    const result = await testConnection(creds);
    res.json(result);
  });

  router.get('/status', (req, res) => {
    const c = getConfig();
    const tok = readTokenSync(paths);
    const st = getStatus();
    // Top-level setupComplete / connected flags drive the workflow stepper UI
    // (Step 1 done if setupComplete, Step 2 done if connected). The
    // printer.detectedFrom field tells the Setup page whether the type came
    // from MQTT auto-detection or from the user's manual selection.
    const detectedFrom = c.printer.detectedFrom || 'config';
    res.json({
      printer: {
        name: c.printer.name,
        type: c.printer.type,
        url: c.printer.url,
        model: c.printer.model || st.detectedModel || null,
        detectedFrom,
      },
      caps: capsFor(c.printer.type),
      status: { connection: st.connection, lastUpdate: st.lastUpdate },
      setupComplete: !isFirstRun(c),
      connected: st.connection === 'online',
      version: require('../../package.json').version,
      cloudAuth: {
        enabled: !!c.cloudAuth?.enabled,
        signedIn: !!c.cloudAuth?.enabled && tok.signedIn,
        email: tok.email,
      },
    });
  });

  router.get('/printer-types', (req, res) => {
    res.json(PRINTER_TYPES.map(t => ({ value: t, label: PRINTER_CAPS[t].label, caps: PRINTER_CAPS[t] })));
  });

  // Widget catalog from public/widgets/*/widget.json (with sensible defaults if missing).
  router.get('/widgets', async (req, res) => {
    try {
      const dir = path.join(paths.public, 'widgets');
      const entries = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
      const out = [];
      for (const name of entries) {
        let manifest = { name, description: '', recommendedSize: { w: 400, h: 200 }, tags: [], requiresCap: null };
        try {
          const m = JSON.parse(await fsp.readFile(path.join(dir, name, 'widget.json'), 'utf-8'));
          manifest = { ...manifest, ...m };
        } catch (_) { /* no manifest, use defaults */ }
        out.push({ slug: name, ...manifest });
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Notes (model-name footer overlay).
  // Tolerates legacy `{ content: "..." }` shape and normalizes to `{ text, manual, updatedAt }`.
  router.get('/note', async (req, res) => {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(paths.data, 'note.json'), 'utf-8'));
      const text = typeof raw.text === 'string' ? raw.text
                 : typeof raw.content === 'string' ? raw.content
                 : '';
      res.json({ text, manual: !!raw.manual, updatedAt: raw.updatedAt || null });
    } catch (e) {
      if (e.code === 'ENOENT') return res.json({ text: '', manual: false });
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/note', async (req, res) => {
    try {
      const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
      const manual = req.body && req.body.manual !== undefined ? !!req.body.manual : true;
      await fsp.writeFile(path.join(paths.data, 'note.json'), JSON.stringify({ text, manual, updatedAt: Date.now() }));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

module.exports = { buildApiRouter };
