const { randomUUID } = require('node:crypto');
const { id } = require('../../public/js/gcode-job');

const JOB_FIELDS = ['task_id', 'subtask_id', 'subtask_name', 'gcode_file', 'param', 'url', 'plate_idx', 'plate_id', 'layer_num', 'total_layer_num', 'mc_percent', 'mc_remaining_time'];
function mergeObjects(previous, delta) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(delta)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (Array.isArray(value) && value.length && value.every(item => item && typeof item === 'object' && item.id != null)) {
      // AMS/tray reports can update a subset of IDs. Keep untouched units and
      // merge nested tray fields instead of erasing their filament metadata.
      const entries = new Map((Array.isArray(previous?.[key]) ? previous[key] : []).filter(item => item?.id != null).map(item => [String(item.id), item]));
      for (const item of value) entries.set(String(item.id), mergeObjects(entries.get(String(item.id)) || {}, item));
      result[key] = [...entries.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
      continue;
    }
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeObjects(previous?.[key] && typeof previous[key] === 'object' ? previous[key] : {}, value)
      : value;
  }
  return result;
}
function mergePrint(previous = {}, delta = {}) {
  const active = ['RUNNING', 'PREPARE', 'SLICING'].includes(delta.gcode_state || previous.gcode_state);
  const newLifecycle = active && (['FINISH', 'FAILED', 'IDLE'].includes(previous.gcode_state)
    || (Number(previous.mc_percent) >= 90 && delta.mc_percent != null && Number(delta.mc_percent) < 50));
  const changed = ['task_id', 'subtask_id', 'subtask_name', 'gcode_file', 'url'].some(key =>
    Object.hasOwn(delta, key) && id(previous[key]) && id(delta[key]) && id(previous[key]) !== id(delta[key]));
  const base = { ...previous };
  if (newLifecycle || changed) for (const key of JOB_FIELDS) delete base[key];
  const merged = mergeObjects(base, delta);
  // Printer-supplied fields cannot override our locally generated lifecycle ID.
  merged._bb_job_id = newLifecycle || changed || !previous._bb_job_id ? randomUUID() : previous._bb_job_id;
  return merged;
}
module.exports = { mergePrint };
