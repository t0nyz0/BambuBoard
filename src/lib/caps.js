// `maxAms` is the maximum number of AMS units the printer can chain via the
// AMS Hub (Bambu firmware caps it at 4). The dual-AMS flag is derived for
// back-compat with the H2D-only widget gating logic; new code should use maxAms.
// `bedSize` is in mm (X = bed left↔right, Y = front↔back, Z = vertical clearance).
const PRINTER_CAPS = {
  X1:  { hasChamberTemp: true,  hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'X1'      },
  X1C: { hasChamberTemp: true,  hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'X1 Carbon' },
  P1P: { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'P1P'     },
  P1S: { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'P1S'     },
  P1:  { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'P1'      },
  A1:  { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 1, bedSize: { x: 256, y: 256, z: 256 }, label: 'A1'      },
  A1M: { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 1, bedSize: { x: 180, y: 180, z: 180 }, label: 'A1 Mini' },
  H2D: { hasChamberTemp: true,  hasDualNozzle: true,  hasDualAMS: true,  maxAms: 4, bedSize: { x: 350, y: 320, z: 325 }, label: 'H2D'     },
};

const PRINTER_TYPES = Object.keys(PRINTER_CAPS);

function capsFor(type) {
  return PRINTER_CAPS[type] || PRINTER_CAPS.X1;
}

// Map ha-bambulab's printer-type identifiers to BambuBoard's.
// Variants we don't yet have explicit caps for fall back to the closest known
// model (e.g. H2D Pro / H2C / H2S → H2D capabilities).
const HA_BAMBULAB_TYPE_MAP = {
  X1: 'X1',
  X1C: 'X1C',
  X1E: 'X1C',     // X1E shares X1C-class capabilities; we don't have a dedicated entry
  P1P: 'P1P',
  P1S: 'P1S',
  P2S: 'P1S',     // no P2 variant; treat as P1S
  A1: 'A1',
  A1MINI: 'A1M',
  H2D: 'H2D',
  H2DPRO: 'H2D',
  H2C: 'H2D',
  H2S: 'H2D',
  X2D: 'H2D',     // dual-nozzle flagship; closest match
};

function search(modules, predicate) {
  for (const m of modules || []) { if (predicate(m)) return m; }
  return null;
}

// Identify printer type from the `module` array of a Bambu MQTT `get_version`
// response. Direct port of ha-bambulab's `pybambu/utils.py:get_printer_type`,
// returning the BambuBoard PRINTER_TYPES key.
//
// Returns { type, model, rawType } or null if undetectable.
//   type    — BambuBoard PRINTER_CAPS key (e.g. "H2D")
//   model   — friendly name from MQTT product_name (e.g. "Bambu Lab H2D Pro")
//   rawType — ha-bambulab key before mapping (e.g. "H2DPRO") — useful for logs
function printerTypeFromMqtt(modules) {
  if (!Array.isArray(modules) || modules.length === 0) return null;

  // 1. Match by product_name (the modern, reliable path). Listed in order;
  //    longer/more-specific names first so "H2D Pro" wins over "H2D".
  const productNames = [
    ['Bambu Lab H2D Pro',  'H2DPRO'],
    ['Bambu Lab A1 mini',  'A1MINI'],
    ['Bambu Lab X2D',      'X2D'],
    ['Bambu Lab P2S',      'P2S'],
    ['Bambu Lab P1S',      'P1S'],
    ['Bambu Lab P1P',      'P1P'],
    ['Bambu Lab H2C',      'H2C'],
    ['Bambu Lab H2D',      'H2D'],
    ['Bambu Lab H2S',      'H2S'],
    ['Bambu Lab X1E',      'X1E'],
    ['Bambu Lab X1C',      'X1C'],
    ['Bambu Lab X1',       'X1'],
    ['Bambu Lab A1',       'A1'],
  ];
  for (const [name, raw] of productNames) {
    const hit = search(modules, m => (m.product_name || '') === name);
    if (hit) return { type: HA_BAMBULAB_TYPE_MAP[raw] || 'X1', model: name, rawType: raw };
  }

  // 2. Fallback: hardware-version + project_name table (older firmware that
  //    doesn't populate product_name).
  const apNode = search(modules, m => (m.hw_ver || '').indexOf('AP0') === 0);
  if (apNode) {
    const hw = apNode.hw_ver || '';
    const proj = apNode.project_name || '';
    let raw = null;
    if (hw === 'AP02') raw = 'X1E';
    else if (proj === 'N1') raw = 'A1MINI';
    else if (hw === 'AP04' && proj === 'C11') raw = 'P1P';
    else if (hw === 'AP04' && proj === 'C12') raw = 'P1S';
    else if (hw === 'AP05' && proj === 'N2S') raw = 'A1';
    else if (hw === 'AP05' && proj === '')    raw = 'X1C';
    if (raw) {
      return { type: HA_BAMBULAB_TYPE_MAP[raw] || 'X1', model: `Bambu Lab ${raw}`, rawType: raw };
    }
  }

  return null;
}

module.exports = { PRINTER_CAPS, PRINTER_TYPES, capsFor, printerTypeFromMqtt };
