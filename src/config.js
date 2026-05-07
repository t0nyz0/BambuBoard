const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
// Config lives inside data/ so it persists when the data directory is
// mounted as a Docker volume. Legacy root-level config.json is migrated
// automatically on first run (see migrateConfigToData below).
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LEGACY_CONFIG_PATH = path.join(ROOT, 'config.json');

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

function backupConfig(reason) {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(DATA_DIR, `config.json.pre-merge-${reason}-${ts}.bak`);
  fs.copyFileSync(CONFIG_PATH, dest);
  return dest;
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
  if (fs.existsSync(LEGACY_CONFIG_PATH) && !fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    fs.unlinkSync(LEGACY_CONFIG_PATH);
    console.log('Migrated config.json → data/config.json');
  }
}

function migrateLegacyDataFiles() {
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
  migrateConfigToData();
  migrateLegacyDataFiles();

  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      console.error(`Could not parse config.json: ${e.message}`);
      raw = {};
    }
  }

  const h2dMigrated = migrateLegacyH2D(raw);
  if (h2dMigrated) {
    const bak = backupConfig('h2d');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(h2dMigrated, null, 2));
    console.log(`Migrated legacy H2D config → v3 schema. Backup: ${bak ? path.basename(bak) : 'n/a'}`);
    raw = h2dMigrated;
  }

  const multiMigrated = migrateLegacyMultiPrinter(raw);
  if (multiMigrated) {
    const bak = backupConfig('multi');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(multiMigrated, null, 2));
    console.warn(`Migrated legacy multi-printer config → v3 single-printer schema. Kept: ${multiMigrated.printer.name} (${multiMigrated.printer.type}). Other printers were dropped. Backup: ${bak ? path.basename(bak) : 'n/a'}`);
    raw = multiMigrated;
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
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
}

function isFirstRun(config) {
  const p = config.printer || {};
  return !p.serialNumber || p.serialNumber === 'FILL_THIS_OUT' || !p.url || !p.accessCode || p.accessCode === 'FILL_THIS_OUT';
}

function publicSnapshot(config) {
  // Strip secrets before sending to clients
  const c = JSON.parse(JSON.stringify(config));
  if (c.printer && c.printer.accessCode) {
    c.printer.accessCodeSet = !!c.printer.accessCode && c.printer.accessCode !== 'FILL_THIS_OUT';
    c.printer.accessCode = '';
  }
  return c;
}

module.exports = { load, save, isFirstRun, publicSnapshot, CONFIG_PATH, DATA_DIR, ROOT };
