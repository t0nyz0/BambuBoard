const assert = require('node:assert/strict');
const test = require('node:test');
const { activeTray, targetTray, trayAt, ams3hUnit } = require('../public/widgets/_amsActive');
const { mergePrint } = require('../src/lib/printTelemetry');
const { h3cAmsPrint } = require('./fixtures/h3c-ams');

test('AMS 3H decodes all nine slots and virtual spool addresses without using legacy tray_now', () => {
  const print = h3cAmsPrint();
  const unit = ams3hUnit(print);
  assert.equal(unit.id, '32');
  assert.equal(trayAt(print, unit, 8).tray_sub_brands, 'PLA Matte');
  assert.deepEqual(activeTray(print), { amsIndex: 32, trayIndex: 8 });
  assert.deepEqual(targetTray(print), { amsIndex: 32, trayIndex: 7 });
  assert.equal(trayAt(print, unit, 7).tray_type, 'TPU');
  assert.equal(trayAt(print, unit, 0), null, 'virtual external spool 255 must stay external');
  print.device.extruder.info[0].snow = 248 << 8;
  assert.deepEqual(activeTray(print), { amsIndex: 32, trayIndex: 7 });
  delete print.device;
  assert.deepEqual(activeTray(print), { amsIndex: 255, trayIndex: 255 });
});

test('AMS 3H keeps both drying zones and clears virtual and physical material on unload', () => {
  const initial = mergePrint({}, h3cAmsPrint());
  const partial = mergePrint(initial, {
    ams: { ams: [{ id: '32', tray: [{ id: '7', state: 160 }], zone_info: [{ zone_id: 0, dry_time: 0 }] }] },
  });
  const unit = ams3hUnit(partial);
  assert.deepEqual(unit.zone_info.map(zone => zone.dry_time), [0, 73]);
  assert.deepEqual(unit.zone_info[0].zone_slots, [5, 7]);
  assert.equal(unit.zone_info[1].humidity_raw, '33');
  assert.equal(trayAt(partial, unit, 7).tray_type, 'TPU', 'pure physical status delta retains virtual spool');

  const loaded = mergePrint(partial, { ams: { ams: [{ id: '32', tray: [{ id: '7', state: 283, tray_type: 'ASA' }] }] } });
  assert.equal(trayAt(loaded, ams3hUnit(loaded), 7).tray_type, 'ASA', 'physical spool outranks a virtual one');
  const cleared = mergePrint(loaded, {
    ams: { ams: [{ id: '32', tray: [{ id: '7', state: 160, print_status: 0 }, { id: '8' }] }] },
    vir_slot: [{ id: '248', state: 1 }],
  });
  assert.equal(trayAt(cleared, ams3hUnit(cleared), 7), null);
  assert.equal(trayAt(cleared, ams3hUnit(cleared), 8), null);
  assert.equal(cleared.vir_slot.find(slot => slot.id === '255').tray_type, 'ABS');
  assert.equal(cleared.ams.ams.find(ams => ams.id === '0').tray[0].tray_type, 'PETG');
});

test('classic AMS, HT and H2D nozzle selection retain their existing addresses', () => {
  assert.deepEqual(activeTray({ ams: { tray_now: '7' } }), { amsIndex: 1, trayIndex: 3 });
  assert.deepEqual(activeTray({ ams: { tray_now: '128' } }), { amsIndex: 128, trayIndex: 0 });
  assert.deepEqual(activeTray({ ams: { tray_now: '254' } }), { amsIndex: 254, trayIndex: 0 });
  const print = { device: { extruder: { state: 16, info: [{ id: 0, snow: 0 }, { id: 1, snow: (2 << 8) | 3 }] } } };
  assert.deepEqual(activeTray(print), { amsIndex: 2, trayIndex: 3 });
});
