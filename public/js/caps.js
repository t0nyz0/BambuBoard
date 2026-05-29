// Mirror of src/lib/caps.js — keep in sync.
// Browser global: window.PRINTER_CAPS, window.capsFor
window.PRINTER_CAPS = {
  X1:  { hasChamberTemp: true,  hasCameraRtsp: true,  hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'X1'      },
  X1C: { hasChamberTemp: true,  hasCameraRtsp: true,  hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'X1 Carbon' },
  P1P: { hasChamberTemp: false, hasCameraRtsp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'P1P'     },
  P1S: { hasChamberTemp: false, hasCameraRtsp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'P1S'     },
  P2S: { hasChamberTemp: true,  hasCameraRtsp: true,  hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'P2S'     },
  P1:  { hasChamberTemp: false, hasCameraRtsp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 4, bedSize: { x: 256, y: 256, z: 256 }, label: 'P1'      },
  A1:  { hasChamberTemp: false, hasCameraRtsp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 1, bedSize: { x: 256, y: 256, z: 256 }, label: 'A1'      },
  A1M: { hasChamberTemp: false, hasCameraRtsp: false, hasDualNozzle: false, hasDualAMS: false, maxAms: 1, bedSize: { x: 180, y: 180, z: 180 }, label: 'A1 Mini' },
  H2D: { hasChamberTemp: true,  hasCameraRtsp: true,  hasDualNozzle: true,  hasDualAMS: true,  maxAms: 4, bedSize: { x: 350, y: 320, z: 325 }, label: 'H2D'     },
};
window.PRINTER_TYPES = Object.keys(window.PRINTER_CAPS);
window.capsFor = function (type) {
  return window.PRINTER_CAPS[type] || window.PRINTER_CAPS.X1;
};
