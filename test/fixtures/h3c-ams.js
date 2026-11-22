// Synthetic values in the report shape documented by ha-bambulab's
// tests/pybambu/H3C_AMS3H.json and test_ams_3h_virtual_slot.py (7c740224).
function h3cAmsPrint() {
  return {
    gcode_state: 'RUNNING',
    ams: { tray_now: '0', ams: [
      { id: '0', temp: '23.2', humidity: '4', humidity_raw: '44', tray: [
        { id: '0', tray_type: 'PETG', tray_color: '3366CCFF', remain: 38 },
      ] },
      { id: '32', tray: [
        { id: '8', state: 283, tray_type: 'PLA', tray_sub_brands: 'PLA Matte', tray_color: '99AABBFF', remain: 71 },
        { id: '5', state: 160 },
        { id: '7', state: 160 },
      ], zone_info: [
        { zone_id: 0, zone_slots: [5, 7], temp: '28.2', humidity_raw: '24', dry_time: 73 },
        { zone_id: 1, zone_slots: [0, 1, 2, 3, 4, 6, 8], temp: '27.7', humidity_raw: '33', dry_time: 73 },
      ] },
    ] },
    device: { extruder: { state: 1, info: [{ id: 0, snow: (32 << 8) | 8, star: (32 << 8) | 7 }] } },
    vir_slot: [
      { id: '248', tray_type: 'TPU', tray_sub_brands: 'TPU 2.85 mm', tray_color: 'E4002BFF', remain: 91 },
      { id: '255', state: 267, tray_type: 'ABS', tray_color: '00AA00FF' },
    ],
  };
}

module.exports = { h3cAmsPrint };
