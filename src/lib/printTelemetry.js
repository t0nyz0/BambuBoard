const { randomUUID } = require('node:crypto');
const { describe, id } = require('../../public/js/gcode-job');
const { AMS_3H_ID, number, loaded } = require('../../public/widgets/_amsActive');

const JOB_FIELDS = ['task_id', 'subtask_id', 'subtask_name', 'gcode_file', 'param', 'url', 'plate_idx', 'plate_id', 'layer_num', 'total_layer_num', 'mc_percent', 'mc_remaining_time', 'mapping'];
function mergeObjects(previous, delta) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(delta)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const indexField = key === 'zone_info' ? 'zone_id' : 'id';
    if (Array.isArray(value) && value.length && value.every(item => item && typeof item === 'object' && item[indexField] != null)) {
      // Partial AMS reports merge independent units, trays and drying zones.
      const entries = new Map((Array.isArray(previous?.[key]) ? previous[key] : [])
        .filter(item => item?.[indexField] != null).map(item => [String(item[indexField]), item]));
      for (const item of value) {
        const index = String(item[indexField]);
        const slot = number(item.id);
        const h3cTray = key === 'tray' && number(delta.id ?? previous?.id) === AMS_3H_ID;
        const h3cVirtual = key === 'vir_slot' && slot >= 247 && slot <= 253;
        // Empty spool reports clear cached metadata so subsequent deltas
        // cannot bring the old material/color back under a new spool.
        const state = number(item.state);
        const clear = (h3cTray || h3cVirtual) && ((Number.isInteger(state) && state >= 0 && !loaded(item))
          || Object.keys(item).every(field => field === 'id'));
        entries.set(index, mergeObjects(clear ? {} : (entries.get(index) || {}), item));
      }
      result[key] = [...entries.values()].sort((a, b) => String(a[indexField]).localeCompare(String(b[indexField]), undefined, { numeric: true }));
      continue;
    }
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeObjects(previous?.[key] && typeof previous[key] === 'object' ? previous[key] : {}, value)
      : value;
  }
  return result;
}
function startsNewJob(previous, delta) {
  const active = ['RUNNING', 'PREPARE', 'SLICING'].includes(delta.gcode_state || previous.gcode_state);
  return active && (['FINISH', 'FAILED', 'IDLE'].includes(previous.gcode_state)
    || (Number(previous.mc_percent) >= 90 && delta.mc_percent != null && Number(delta.mc_percent) < 50));
}

function reconnectJob(previous, current, waitingForIdentity) {
  if (['IDLE', 'FAILED'].includes(current.gcode_state) || startsNewJob(previous, current)) return 'different';
  const before = describe(previous);
  const after = describe({ ...current, _bb_job_id: previous._bb_job_id });
  if ((after.available || after.calibration) && before.key === after.key) return 'same';
  // This reserved path is conclusive even when an MQTT reconnect supplies it
  // in a different field or arrives before the rest of the identity.
  if (after.calibration) return before.calibration ? 'same' : 'different';
  if (before.calibration && after.available) return 'different';
  const conflict = ['task_id', 'subtask_id'].some(key => id(previous[key]) && id(current[key]) && id(previous[key]) !== id(current[key]))
    || ['name', 'file', 'param', 'url'].some(key => before[key] && after[key] && before[key] !== after[key])
    || (before.plateKnown && after.plateKnown && before.plate !== after.plate);
  // First reports can contain only a generic plate path or a subset of the
  // job metadata. A conflicting report or a usable locator after the grace
  // period is handled normally, even if the firmware never sends every field.
  return conflict || (after.available && !waitingForIdentity) ? 'different' : 'waiting';
}

function mergePrint(previous = {}, delta = {}) {
  const newLifecycle = startsNewJob(previous, delta);
  const before = describe(previous);
  const next = describe(delta);
  const calibrationChanged = before.calibration !== next.calibration
    && (next.calibration || (before.calibration
      && [next.file, next.param, next.url].some(locator => /\.(?:gcode|3mf)$/i.test(locator))));
  const changed = calibrationChanged || ['task_id', 'subtask_id', 'subtask_name', 'gcode_file', 'url'].some(key =>
    Object.hasOwn(delta, key) && id(previous[key]) && id(delta[key]) && id(previous[key]) !== id(delta[key]));
  const base = { ...previous };
  if (newLifecycle || changed) for (const key of JOB_FIELDS) delete base[key];
  const merged = mergeObjects(base, delta);
  // Printer-supplied fields cannot override our locally generated lifecycle ID.
  merged._bb_job_id = newLifecycle || changed || !previous._bb_job_id ? randomUUID() : previous._bb_job_id;
  delete merged._bb_job_pending;
  return merged;
}
module.exports = { mergePrint, reconnectJob };
