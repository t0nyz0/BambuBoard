// Shared by the server and widget so cache and request identities agree.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBGcodeJob = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function text(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 1024) : '';
  }
  function id(value) { const s = text(value); return s === '0' ? '' : s; }
  function filePath(value) {
    const s = text(value);
    if (/^(?:ftp|ftps|file):\/\//i.test(s)) {
      try { return decodeURIComponent(new URL(s).pathname); } catch (_) { return ''; }
    }
    // Cloud URLs may contain credentials/signatures; never use them as FTP paths.
    return /:\/\//.test(s) ? '' : s;
  }
  function describe(print = {}) {
    const param = filePath(print.param);
    const file = filePath(print.gcode_file);
    const url = filePath(print.url);
    const plateFile = [file, param].map(s => s.match(/(?:^|\/)plate_(\d+)\.gcode$/i)).find(Boolean);
    const number = plateFile ? Number(plateFile[1]) : Number(print.plate_idx || print.plate_id);
    const plateKnown = Number.isInteger(number) && number > 0 && number <= 999;
    const plate = plateKnown ? number : 1;
    const name = text(print.subtask_name);
    const task = id(print.subtask_id) || id(print.task_id);
    const generation = text(print._bb_job_id);
    const key = JSON.stringify([generation, id(print.task_id), id(print.subtask_id), name, file, param, url, plate, plateKnown]);
    return { key, task, name, file, param, url, plate, plateKnown, available: Boolean(name || file || url) };
  }
  return { describe, id, filePath };
});
