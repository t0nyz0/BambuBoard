// Mirror of src/lib/caps.js — keep in sync.
// Browser global: window.PRINTER_CAPS, window.capsFor
window.PRINTER_CAPS = {
  X1:  { hasChamberTemp: true,  hasDualNozzle: false, hasDualAMS: false, maxAms: 4, label: 'X1'      },
  X1C: { hasChamberTemp: true,  hasDualNozzle: false, hasDualAMS: false, maxAms: 4, label: 'X1 Carbon' },
  P1P: { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, label: 'P1P'     },
  P1S: { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, label: 'P1S'     },
  P1:  { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, label: 'P1'      },
  A1:  { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 1, label: 'A1'      },
  A1M: { hasChamberTemp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 1, label: 'A1 Mini' },
  H2D: { hasChamberTemp: true,  hasDualNozzle: true,  hasDualAMS: true,  maxAms: 4, label: 'H2D'     },
};
window.PRINTER_TYPES = Object.keys(window.PRINTER_CAPS);
window.capsFor = function (type) {
  return window.PRINTER_CAPS[type] || window.PRINTER_CAPS.X1;
};
