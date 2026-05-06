const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const configMod = require('./config');
const { createPrinterClient } = require('./mqtt');
const { buildApiRouter } = require('./routes/api');
const { buildPagesRouter } = require('./routes/pages');
const { buildAuthRouter } = require('./routes/auth');
const { buildObsSceneRouter } = require('./routes/obsScene');
const { buildVideoRouter } = require('./routes/video');

const ROOT = path.resolve(__dirname, '..');
const paths = {
  root: ROOT,
  views: path.join(ROOT, 'views'),
  public: path.join(ROOT, 'public'),
  data: path.join(ROOT, 'data'),
};
const DATA_FILE = path.join(paths.data, 'data.json');

let config = configMod.load();
function getConfig() { return config; }
async function saveConfig(next) {
  config = next;
  await configMod.save(next);
}

function log(...args) { if (config.BambuBoard_logging) console.log('[bambuboard]', ...args); }

// When MQTT auto-detects a different printer model than what's in config,
// persist the new value so /api/status surfaces it correctly and so widget
// cap-gating (PRINTER_CAPS) reflects reality. We only update `printer.type`;
// the user's name/url/serialNumber/accessCode are left alone.
async function onPrinterDetected({ type, model }) {
  if (!type) return;
  const wasManual = !config.printer.detectedFrom || config.printer.detectedFrom === 'config';
  if (config.printer.type === type && config.printer.model === model && !wasManual) return;
  const next = {
    ...config,
    printer: { ...config.printer, type, model, detectedFrom: 'mqtt' },
  };
  await saveConfig(next);
  console.log(`[bambuboard] saved auto-detected printer type: ${model} → ${type}`);
}

let printer = createPrinterClient({
  printer: config.printer,
  dataPath: DATA_FILE,
  log,
  onPrinterDetected,
});

function reloadPrinter() {
  try { printer.stop(); } catch (_) {}
  printer = createPrinterClient({
    printer: config.printer,
    dataPath: DATA_FILE,
    log,
    onPrinterDetected,
  });
  printer.connect();
  console.log(`[bambuboard] reloaded printer client for ${config.printer.name} (${config.printer.type})`);
}

function getStatus() {
  return {
    connection: printer.status,
    lastUpdate: printer.lastUpdate,
    detectedType: printer.detectedType,
    detectedModel: printer.detectedModel,
  };
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
process.env.UV_THREADPOOL_SIZE = 128;

// Static asset mounts (these come BEFORE the page router so /css/foo.css etc. resolve)
app.use('/css',     express.static(path.join(paths.public, 'css')));
app.use('/js',      express.static(path.join(paths.public, 'js')));
app.use('/assets',  express.static(path.join(paths.public, 'assets')));
app.use('/widgets', express.static(path.join(paths.public, 'widgets')));

// /data.json — backed by data/data.json (kept at root path for OBS widget compatibility)
app.get('/data.json', (req, res) => {
  res.sendFile(DATA_FILE, (err) => {
    if (err) {
      // No data yet — return an empty shape so widgets don't error.
      res.setHeader('Content-Type', 'application/json');
      res.send('{}');
    }
  });
});

app.use('/api', buildApiRouter({ getConfig, saveConfig, reloadPrinter, getStatus, paths }));
app.use('/api/obs', buildObsSceneRouter({ paths }));
app.use('/', buildAuthRouter({ getConfig, saveConfig, paths }));

// Legacy /note endpoints — used by the notes widget (public/widgets/notes/*.html).
// The widget expects { content: string } shape; the new /api/note returns
// { text, manual, updatedAt }. Map between the two so existing widget HTML
// doesn't need editing (and keeps OBS scene URLs stable).
const fsp = fs.promises;
app.get('/note', async (req, res) => {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(paths.data, 'note.json'), 'utf-8'));
    const content = typeof raw.text === 'string' ? raw.text
                  : typeof raw.content === 'string' ? raw.content
                  : '';
    res.json({ content });
  } catch (e) {
    if (e.code === 'ENOENT') return res.json({ content: '' });
    res.status(500).json({ error: e.message });
  }
});
app.put('/note', async (req, res) => {
  try {
    const content = (req.body && typeof req.body.content === 'string') ? req.body.content
                  : (req.body && typeof req.body.text === 'string')    ? req.body.text
                  : '';
    await fsp.writeFile(path.join(paths.data, 'note.json'),
      JSON.stringify({ text: content, manual: true, updatedAt: Date.now() }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Legacy widget endpoints — multiple OBS browser-source widgets fetch these
// directly. Keep them here so we don't have to edit every widget HTML/JS.
app.get('/version', (req, res) => {
  res.json({ version: require('../package.json').version });
});

app.get('/settings', (req, res) => {
  // Several widgets read this and just check the temperature unit string.
  // Return a flat shape that's compatible: c.BambuBoard_tempSetting is what
  // the widgets look for.
  res.json(getConfig());
});

app.get('/preference-fan-icons', (req, res) => {
  res.json(getConfig().BambuBoard_displayFanIcons !== false);
});
app.get('/preference-fan-percentages', (req, res) => {
  res.json(!!getConfig().BambuBoard_displayFanPercentages);
});

app.get('/status', (req, res) => {
  // Some widgets (e.g. profile-info) check this. Mirror /api/status but at
  // the legacy path.
  const c = getConfig();
  res.json({
    connection: printer.status,
    lastUpdate: printer.lastUpdate,
    printer: { name: c.printer.name, type: c.printer.type },
  });
});

// /profile-info is handled by the auth router (mounted above) — it fetches
// real MakerWorld profile data when cloud auth is enabled and signed in.

// RTSP video relay — must be mounted before the page router catch-all.
// Uses express-ws under the hood, so this augments the app with ws() support.
buildVideoRouter({ app, getConfig, dataPath: DATA_FILE });

app.use('/', buildPagesRouter({ paths, getConfig }));

// Fallback for unknown routes → hub
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/');
  res.status(404).json({ error: 'not found' });
});

const port = config.BambuBoard_httpPort || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`╔════════════════════════════════════════════════════╗`);
  console.log(`║  BambuBoard v${require('../package.json').version}                              ║`);
  console.log(`║  Listening on http://0.0.0.0:${port}                  ║`);
  console.log(`║  Printer: ${(config.printer.name || '?').padEnd(40)} ║`);
  console.log(`║  Type: ${(config.printer.type || '?').padEnd(43)} ║`);
  console.log(`╚════════════════════════════════════════════════════╝`);
  if (configMod.isFirstRun(config)) {
    console.log('First-run: open the URL above and the setup wizard will appear.');
  }
  printer.connect();
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log(`\n[bambuboard] received ${sig}, shutting down`);
  try { printer.stop(); } catch (_) {}
  process.exit(0);
}));
