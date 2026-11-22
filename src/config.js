const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('node:crypto');
const { printerConnection, hasSavedAccessCode } = require('./lib/printerConnection');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.BAMBUBOARD_DATA_DIR ? path.resolve(process.env.BAMBUBOARD_DATA_DIR) : path.join(ROOT, 'data');
// Config lives inside data/ so it persists when the data directory is
// mounted as a Docker volume. Legacy root-level config.json is migrated
// automatically on first run (see migrateConfigToData below).
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LEGACY_CONFIG_PATH = path.join(ROOT, 'config.json');
const PRIVATE_WRITE = { mode: 0o600, flag: 'wx', flush: true };
let recoveryPending = false;
let recoveryBackup = null;

const DEFAULTS = {
  BambuBoard_httpPort: 8080,
  BambuBoard_tempSetting: 'Both',
  BambuBoard_displayFanPercentages: false,
  BambuBoard_displayFanIcons: true,
  BambuBoard_logging: false,
  cloudAuth: { enabled: false },
  printer: {
    name: 'My Printer',
    url: '',
    port: '8883',
    serialNumber: 'FILL_THIS_OUT',
    accessCode: 'FILL_THIS_OUT',
    type: 'X1',
  },
};

function backupPath(reason) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(DATA_DIR, `config.json.pre-merge-${reason}-${ts}-${randomUUID()}.bak`);
}

function writeConfigSync(contents) {
  const temporary = `${CONFIG_PATH}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, PRIVATE_WRITE);
    fs.renameSync(temporary, CONFIG_PATH);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function migrateLegacyH2D(config) {
  if (config.printer || !config.BambuBoard_printerURL) return null;
  const migrated = {
    BambuBoard_httpPort: config.BambuBoard_httpPort || DEFAULTS.BambuBoard_httpPort,
    BambuBoard_tempSetting: config.BambuBoard_tempSetting || DEFAULTS.BambuBoard_tempSetting,
    BambuBoard_displayFanPercentages: !!config.BambuBoard_displayFanPercentages,
    BambuBoard_displayFanIcons: config.BambuBoard_displayFanIcons !== false,
    BambuBoard_logging: !!config.BambuBoard_logging,
    cloudAuth: { enabled: !!config.BambuBoard_bambuUsername },
    printer: {
      name: 'H2D',
      url: config.BambuBoard_printerURL,
      port: config.BambuBoard_printerPort || '8883',
      serialNumber: config.BambuBoard_printerSN,
      accessCode: config.BambuBoard_printerAccessCode,
      type: config.BambuBoard_printerType || 'H2D',
    },
  };
  return migrated;
}

function migrateLegacyMultiPrinter(config) {
  if (config.printer || !Array.isArray(config.printers)) return null;
  const first = config.printers.find(p => p && p.serialNumber && p.serialNumber !== 'FILL_THIS_OUT')
    || config.printers[0];
  if (!first) return null;
  return {
    BambuBoard_httpPort: config.BambuBoard_httpPort || DEFAULTS.BambuBoard_httpPort,
    BambuBoard_tempSetting: config.BambuBoard_tempSetting || DEFAULTS.BambuBoard_tempSetting,
    BambuBoard_displayFanPercentages: !!config.BambuBoard_displayFanPercentages,
    BambuBoard_displayFanIcons: config.BambuBoard_displayFanIcons !== false,
    BambuBoard_logging: !!config.BambuBoard_logging,
    cloudAuth: { enabled: false },
    printer: {
      name: first.name || 'Printer',
      url: first.url || '',
      port: first.port || '8883',
      serialNumber: first.serialNumber || 'FILL_THIS_OUT',
      accessCode: first.accessCode || 'FILL_THIS_OUT',
      type: first.type || 'X1',
    },
  };
}

function migrateConfigToData() {
  if (!process.env.BAMBUBOARD_DATA_DIR && fs.existsSync(LEGACY_CONFIG_PATH) && !fs.existsSync(CONFIG_PATH)) {
    writeConfigSync(fs.readFileSync(LEGACY_CONFIG_PATH));
    fs.unlinkSync(LEGACY_CONFIG_PATH);
    console.log('Migrated config.json → data/config.json');
  }
}

function migrateLegacyDataFiles() {
  if (process.env.BAMBUBOARD_DATA_DIR) return;
  const candidates = [
    [path.join(ROOT, 'accessToken.json'), path.join(DATA_DIR, 'accessToken.json')],
    [path.join(ROOT, 'note.json'),        path.join(DATA_DIR, 'note.json')],
    [path.join(ROOT, 'public', 'data.json'), path.join(DATA_DIR, 'data.json')],
  ];
  for (const [from, to] of candidates) {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.renameSync(from, to);
        console.log(`Migrated runtime file: ${path.relative(ROOT, from)} → ${path.relative(ROOT, to)}`);
      }
    } catch (e) {
      console.warn(`Could not migrate ${from}: ${e.message}`);
    }
  }
}

function applyEnvOverrides(config) {
  const env = process.env;
  if (env.BAMBUBOARD_HTTP_PORT)         config.BambuBoard_httpPort = Number(env.BAMBUBOARD_HTTP_PORT);
  if (env.BAMBUBOARD_TEMP_SETTING)      config.BambuBoard_tempSetting = env.BAMBUBOARD_TEMP_SETTING;
  if (env.BAMBUBOARD_FAN_PERCENTAGES)   config.BambuBoard_displayFanPercentages = env.BAMBUBOARD_FAN_PERCENTAGES === 'true';
  if (env.BAMBUBOARD_FAN_ICONS)         config.BambuBoard_displayFanIcons = env.BAMBUBOARD_FAN_ICONS !== 'false';
  if (env.BAMBUBOARD_LOGGING)           config.BambuBoard_logging = env.BAMBUBOARD_LOGGING === 'true';
  if (env.BAMBUBOARD_PRINTER_URL)       config.printer.url = env.BAMBUBOARD_PRINTER_URL;
  if (env.BAMBUBOARD_PRINTER_PORT)      config.printer.port = env.BAMBUBOARD_PRINTER_PORT;
  if (env.BAMBUBOARD_PRINTER_SN)        config.printer.serialNumber = env.BAMBUBOARD_PRINTER_SN;
  if (env.BAMBUBOARD_PRINTER_ACCESS_CODE) config.printer.accessCode = env.BAMBUBOARD_PRINTER_ACCESS_CODE;
  if (env.BAMBUBOARD_PRINTER_TYPE)      config.printer.type = env.BAMBUBOARD_PRINTER_TYPE;
  if (env.BAMBUBOARD_PRINTER_NAME)      config.printer.name = env.BAMBUBOARD_PRINTER_NAME;
  return config;
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  recoveryPending = false;
  recoveryBackup = null;
  try { migrateConfigToData(); }
  catch (e) { console.warn(`Could not migrate legacy config.json (${e.code || 'error'}). The original was retained.`); }
  migrateLegacyDataFiles();

  let raw = {};
  let original;
  try {
    original = fs.readFileSync(CONFIG_PATH);
    const decoded = JSON.parse(original.toString('utf8'));
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!record(decoded) || (Object.hasOwn(decoded, 'printer') && !record(decoded.printer)) ||
        (Object.hasOwn(decoded, 'cloudAuth') && decoded.cloudAuth !== null && !record(decoded.cloudAuth))) {
      throw new SyntaxError('Invalid config shape');
    }
    raw = decoded;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      recoveryPending = true;
      console.warn(`Could not load config.json (${e.code || 'invalid format'}). The original was retained. Open Setup to restore settings.`);
    }
  }

  const h2dMigrated = migrateLegacyH2D(raw);
  const migrated = h2dMigrated || migrateLegacyMultiPrinter(raw);
  if (migrated) {
    const backup = backupPath(h2dMigrated ? 'h2d' : 'multi');
    try {
      fs.writeFileSync(backup, original, PRIVATE_WRITE);
      recoveryBackup = backup;
      writeConfigSync(JSON.stringify(migrated, null, 2));
      console.log(`Migrated legacy printer settings. Backup: ${path.basename(backup)}`);
    } catch (e) {
      recoveryPending = true;
      console.warn(`Could not save migrated settings (${e.code || 'error'}). The original was retained.`);
    }
    raw = migrated;
  }

  const merged = {
    ...DEFAULTS,
    ...raw,
    cloudAuth: { ...DEFAULTS.cloudAuth, ...(raw.cloudAuth || {}) },
    printer: { ...DEFAULTS.printer, ...(raw.printer || {}) },
  };
  return applyEnvOverrides(merged);
}

async function save(newConfig) {
  const temporary = `${CONFIG_PATH}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(newConfig, null, 2), PRIVATE_WRITE);
    if (recoveryPending && !recoveryBackup) {
      const original = await fsp.readFile(CONFIG_PATH).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (original) {
        const backup = backupPath('recovery');
        await fsp.writeFile(backup, original, PRIVATE_WRITE);
        recoveryBackup = backup;
        console.log(`Preserved the previous config.json. Backup: ${path.basename(backup)}`);
      }
    }
    await fsp.rename(temporary, CONFIG_PATH);
    recoveryPending = false;
    recoveryBackup = null;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

function needsRecovery() { return recoveryPending; }

function isFirstRun(config) {
  return !printerConnection(config.printer) || !hasSavedAccessCode(config.printer);
}

function publicSnapshot(config) {
  // Include only settings clients use. Old files may keep other credential fields.
  const c = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, config[key]]));
  const p = config.printer;
  c.printer = {
    name: p.name, url: p.url, port: p.port, serialNumber: p.serialNumber, type: p.type,
    model: p.model, detectedFrom: p.detectedFrom, accessCode: '',
    accessCodeSet: hasSavedAccessCode(p),
  };
  c.cloudAuth = { enabled: config.cloudAuth.enabled };
  const legacyTempMap = { C: 'Celsius', F: 'Fahrenheit' };
  if (Object.hasOwn(legacyTempMap, c.BambuBoard_tempSetting)) {
    c.BambuBoard_tempSetting = legacyTempMap[c.BambuBoard_tempSetting];
  }
  return c;
}

module.exports = { load, save, isFirstRun, publicSnapshot, needsRecovery, CONFIG_PATH, DATA_DIR, ROOT };
