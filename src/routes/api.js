const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { PRINTER_TYPES, PRINTER_CAPS, capsFor } = require('../lib/caps');
const { printerConnection, samePrinterConnection, hasSavedAccessCode } = require('../lib/printerConnection');
const { testConnection } = require('../mqtt');
const { probePrinterFiles, GcodeError } = require('../services/printerFiles');
const { isFirstRun, publicSnapshot, needsRecovery } = require('../config');

function readTokenSync(paths) {
  try {
    const txt = fs.readFileSync(path.join(paths.data, 'accessToken.json'), 'utf-8');
    const t = JSON.parse(txt);
    return { signedIn: !!(t && t.accessToken), email: t?.email || null };
  } catch (_) { return { signedIn: false, email: null }; }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = value => typeof value === 'string';
const isBoolean = value => typeof value === 'boolean';
const isPort = value => (typeof value === 'number' || (isString(value) && /^\d+$/.test(value)))
  && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535;

function isPrinterHost(value) {
  if (!isString(value) || /[/?#@\\\s]/.test(value)) return false;
  if (value === '') return true;
  if (value.includes(':') && !(value.startsWith('[') && value.endsWith(']'))) return false;
  try { return !!new URL(`http://${value}`).hostname; }
  catch (_) { return false; }
}

function invalidSettings(message) {
  return Object.assign(new Error(message), { code: 'INVALID_SETTINGS' });
}

function checkSettings(value, checks, label) {
  if (!isRecord(value)) throw invalidSettings(`${label} must be an object.`);
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(checks, key) || !checks[key](field)) throw invalidSettings(`Invalid ${label} field: ${key}.`);
  }
}

const printerChecks = {
  name: isString,
  url: isPrinterHost,
  port: value => value === '' || isPort(value),
  serialNumber: isString,
  accessCode: isString,
  type: value => PRINTER_TYPES.includes(value),
  model: value => value === null || isString(value),
  detectedFrom: value => ['config', 'mqtt'].includes(value),
};

function buildApiRouter({
  getConfig, saveConfig, reloadPrinter, getStatus, paths,
  checkPrinterConnection = testConnection, checkGcodeConnection = probePrinterFiles,
}) {
  const router = express.Router();
  let checkingGcode = false;

  router.get('/settings', (req, res) => {
    const c = getConfig();
    res.json({ ...publicSnapshot(c), _meta: { firstRun: isFirstRun(c), configRecovery: needsRecovery() } });
  });

  // Older clients can keep reading the response shape. The code stays on the server.
  router.get('/printer-credentials', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      accessCode: '',
      accessCodeSet: hasSavedAccessCode(getConfig().printer),
    });
  });

  router.put('/settings', async (req, res) => {
    try {
      const incoming = req.body;
      checkSettings(incoming, {
        BambuBoard_httpPort: isPort,
        BambuBoard_tempSetting: value => ['Both', 'Celsius', 'Fahrenheit', 'C', 'F'].includes(value),
        BambuBoard_displayFanPercentages: isBoolean,
        BambuBoard_displayFanIcons: isBoolean,
        BambuBoard_logging: isBoolean,
        printer: isRecord,
        cloudAuth: isRecord,
      }, 'Settings');
      if (incoming.printer) checkSettings(incoming.printer, printerChecks, 'printer');
      if (incoming.cloudAuth) checkSettings(incoming.cloudAuth, { enabled: isBoolean }, 'cloud');

      let reconnect = false;
      await saveConfig(current => {
        const merged = { ...current, ...incoming };
        if (Object.hasOwn(incoming, 'BambuBoard_httpPort')) merged.BambuBoard_httpPort = Number(incoming.BambuBoard_httpPort);
        if (incoming.cloudAuth) merged.cloudAuth = { ...current.cloudAuth, ...incoming.cloudAuth };
        if (incoming.printer) {
          const previous = current.printer;
          const replacement = Object.hasOwn(incoming.printer, 'serialNumber')
            && incoming.printer.serialNumber !== previous.serialNumber;
          const next = replacement
            ? { ...previous, type: 'X1', model: null, detectedFrom: 'config', ...incoming.printer }
            : { ...previous, ...incoming.printer };
          const samePrinter = samePrinterConnection(previous, next);
          if (hasSavedAccessCode(incoming.printer)) next.accessCode = incoming.printer.accessCode.trim();
          else if (samePrinter) next.accessCode = previous.accessCode;
          else if (hasSavedAccessCode(previous)) throw invalidSettings('Enter the LAN access code for the new printer connection.');
          else next.accessCode = '';
          merged.printer = next;
          reconnect = !samePrinter || next.accessCode !== previous.accessCode || next.type !== previous.type
            || getStatus().connection !== 'online';
        }
        return merged;
      });
      if (reconnect) reloadPrinter();
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'INVALID_SETTINGS') return res.status(400).json({ ok: false, error: e.message });
      console.error(`PUT /api/settings failed (${e.code || 'error'}).`);
      res.status(500).json({ ok: false, error: 'Could not save settings. Check that the BambuBoard data directory is writable.' });
    }
  });

  router.post('/test-connection', async (req, res) => {
    const incoming = req.body || {};
    const connection = printerConnection(incoming);
    if (!connection) {
      return res.status(400).json({ ok: false, code: 'INVALID_CONNECTION', error: 'Enter the printer address, serial number, and a valid MQTT port.' });
    }
    if (hasSavedAccessCode(incoming)) {
      return res.json(await checkPrinterConnection({ ...connection, accessCode: incoming.accessCode.trim() }));
    }
    const saved = getConfig().printer;
    if ((incoming.accessCode != null && (typeof incoming.accessCode !== 'string' || incoming.accessCode.trim()))
      || !hasSavedAccessCode(saved) || !samePrinterConnection(connection, saved)) {
      return res.status(400).json({ ok: false, code: 'ACCESS_CODE_REQUIRED', error: 'Enter the LAN access code for this printer connection.' });
    }
    // Use the saved destination itself whenever the saved code is used.
    return res.json(await checkPrinterConnection({ ...printerConnection(saved), accessCode: saved.accessCode }));
  });

  router.post('/test-gcode-connection', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    // This is an explicit check of the saved printer. Unlike the Setup MQTT
    // check it never accepts a connection target or credentials from a form.
    if (!isRecord(req.body) || Object.keys(req.body).length || Object.keys(req.query).length) {
      return res.status(400).json({ ok: false, code: 'INVALID_GCODE_CHECK', error: 'Run the G-code check for the saved printer from Setup.' });
    }
    const saved = getConfig().printer;
    const connection = printerConnection(saved);
    if (!connection || !isPrinterHost(connection.url) || !hasSavedAccessCode(saved) || needsRecovery()) {
      return res.status(422).json({ ok: false, code: 'PRINTER_NOT_CONFIGURED', error: 'Save the printer address, serial number, and LAN access code before testing G-code access.' });
    }
    if (checkingGcode) {
      return res.status(409).json({ ok: false, code: 'GCODE_CHECK_ACTIVE', error: 'A G-code connection check is already running. Wait for it to finish.' });
    }

    checkingGcode = true;
    let failure;
    try {
      await checkGcodeConnection({ host: connection.url, accessCode: saved.accessCode, model: saved.model || saved.type });
    } catch (err) {
      failure = err instanceof GcodeError ? err : new GcodeError('GCODE_CHECK_FAILED', 'Could not check printer file access. Try again.', { status: 502 });
    } finally {
      checkingGcode = false;
    }
    const current = getConfig().printer;
    if (!samePrinterConnection(saved, current) || saved.accessCode !== current.accessCode) {
      return res.status(409).json({ ok: false, code: 'PRINTER_CHANGED', error: 'The saved printer changed during the check. Test the new connection.' });
    }
    if (failure) return res.status(failure.status).json({ ok: false, code: failure.code, error: failure.message });
    return res.json({ ok: true, message: 'Secure G-code file access is available.' });
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
