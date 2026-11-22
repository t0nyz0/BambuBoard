// Shared AMS addressing and spool lookup, based on ha-bambulab's AMS model.
(function (root) {
  const AMS_3H_ID = 32;
  const NO_TRAY = Object.freeze({ amsIndex: 255, trayIndex: 255 });

  function number(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function unitId(unit) { return number(unit?.id); }

  function ams3hUnit(print) {
    const units = print?.ams?.ams;
    return Array.isArray(units) ? units.find(unit => unitId(unit) === AMS_3H_ID) : undefined;
  }

  function loaded(tray) {
    if (!tray) return false;
    const state = number(tray.state);
    if (Number.isInteger(state) && state >= 0) {
      // Legacy 3 means loaded. Newer reports need both SPOOL and STEADY,
      // so trays still loading or scanning RFID do not show stale metadata.
      return state <= 3 ? state === 3 : (state & 0x09) === 0x09;
    }
    return Boolean(tray.tray_info_idx || (tray.tray_type && tray.tray_type !== 'Empty'));
  }

  function trayAt(print, unit, trayIndex) {
    const tray = Array.isArray(unit?.tray)
      ? unit.tray.find(tray => number(tray?.id) === trayIndex)
      : undefined;
    if (unitId(unit) !== AMS_3H_ID) return tray || null;
    if (!Number.isInteger(trayIndex) || trayIndex < 0 || trayIndex > 8) return null;
    if (loaded(tray)) return tray;
    // 2.85 mm spools may be reported in vir_slot while the physical bay is
    // reported empty. IDs 254 and 255 are reserved for external spools.
    const virtualId = 255 - trayIndex;
    if (virtualId < 247 || virtualId > 253 || !Array.isArray(print?.vir_slot)) return null;
    const virtualTray = print.vir_slot.find(entry => number(entry?.id) === virtualId);
    return loaded(virtualTray) ? virtualTray : null;
  }

  function decodeAddress(print, value) {
    const address = number(value);
    if (!Number.isInteger(address) || address < 0 || address > 0xFFFF) return NO_TRAY;
    const amsIndex = address >> 8;
    if (amsIndex >= 247 && amsIndex <= 253 && ams3hUnit(print)) {
      return { amsIndex: AMS_3H_ID, trayIndex: 255 - amsIndex };
    }
    return { amsIndex, trayIndex: address & 0xFF };
  }

  function decodeSlot(print, modernKey, legacyKey) {
    const extruder = print?.device?.extruder;
    if (Array.isArray(extruder?.info) && extruder.info.length) {
      const activeNozzle = (number(extruder.state) >> 4) & 0x0F;
      const entry = extruder.info.find(e => number(e?.id) === activeNozzle) || extruder.info[0];
      return decodeAddress(print, entry?.[modernKey]);
    }

    // Legacy firmware packs four trays per AMS and reports HT units
    // separately. The packed value alone cannot identify AMS 3H's slots.
    const address = number(print?.ams?.[legacyKey]);
    if (!Number.isInteger(address) || address < 0 || address >= 255 || ams3hUnit(print)) return NO_TRAY;
    if (address >= 80) return { amsIndex: address, trayIndex: 0 };
    return { amsIndex: address >> 2, trayIndex: address & 0x03 };
  }

  const activeTray = print => decodeSlot(print, 'snow', 'tray_now');
  const targetTray = print => decodeSlot(print, 'star', 'tray_tar');
  const api = { AMS_3H_ID, number, unitId, ams3hUnit, loaded, trayAt, decodeAddress, activeTray, targetTray };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.BBAms = api;
    root.getActiveAmsTray = telemetry => activeTray(telemetry?.print);
  }
})(globalThis);
