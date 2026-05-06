// Shared helper: which AMS unit + tray is currently feeding filament?
// Logic ported from ha-bambulab/pybambu/models.py (the AMS class). Handles:
//   - H2D dual-nozzle case: each extruder.info[i].snow encodes per-nozzle AMS/tray
//     (ams = snow >> 8, tray = snow & 0x3). Active nozzle is extruder.state >> 4 & 0xF.
//   - Legacy single-nozzle case: ams.tray_now is a packed combined value.
//     255 = nothing active, 254 = external spool, 80+ = AMS HT (idx 128–135),
//     otherwise tray_now >> 2 = AMS index, tray_now & 0x3 = tray index.
//
// Returns { amsIndex, trayIndex } where:
//   amsIndex = the AMS unit index that's feeding (or 255 if none / 254 if external spool)
//   trayIndex = the tray index within that AMS (0–3)
window.getActiveAmsTray = function (telemetry) {
  if (!telemetry || !telemetry.print) return { amsIndex: 255, trayIndex: 255 };
  const p = telemetry.print;

  const ext = p.device && p.device.extruder;
  if (ext && Array.isArray(ext.info) && ext.info.length > 0) {
    const activeNozzle = typeof ext.state === 'number' ? (ext.state >> 4) & 0xF : 0;
    const entry = ext.info.find(e => e && e.id === activeNozzle) || ext.info[0];
    const snow = entry && typeof entry.snow === 'number' ? entry.snow : null;
    if (snow == null) return { amsIndex: 255, trayIndex: 255 };
    return { amsIndex: snow >> 8, trayIndex: snow & 0x3 };
  }

  const trayNow = p.ams && p.ams.tray_now != null ? parseInt(p.ams.tray_now, 10) : null;
  if (trayNow == null || isNaN(trayNow) || trayNow === 255) return { amsIndex: 255, trayIndex: 255 };
  if (trayNow === 254) return { amsIndex: 254, trayIndex: 0 };
  if (trayNow >= 80) return { amsIndex: trayNow, trayIndex: 0 }; // AMS HT range
  return { amsIndex: trayNow >> 2, trayIndex: trayNow & 0x3 };
};
