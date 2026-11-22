// Shared by the server and widget so cache and request identities agree.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBGcodeJob = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const calibrationName = 'auto_cali_for_user_param.gcode';
  const calibrationPath = '/usr/etc/print/' + calibrationName;
  const activeStates = new Set(['RUNNING', 'PREPARE', 'SLICING', 'PAUSE', 'PAUSED']);
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
  function hasDifferentPrintFile(print, known) {
    return [print.gcode_file, print.param, print.url].some(value => {
      const source = text(value);
      let locator = filePath(source);
      // A cloud URL is never a download candidate, but an explicit plate
      // path there can contradict a bare calibration filename.
      if (!locator && /^https?:\/\//i.test(source)) {
        try { locator = decodeURIComponent(new URL(source).pathname); } catch (_) {}
      }
      return /\.(?:gcode|3mf)$/i.test(locator) && !known.includes(locator);
    });
  }
  function confirmsBareCalibration(print) {
    return print.print_type === 'system' && print.gcode_file === calibrationName && print.subtask_name === calibrationName
      && !hasDifferentPrintFile(print, [calibrationName, calibrationPath]);
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
    // A bare filename may be a user file. Require the MQTT merger's proof
    // that the printer explicitly reported this system job for this identity.
    const bareCalibration = Boolean(generation && print._bb_system_calibration_job === generation && confirmsBareCalibration(print));
    const calibration = [file, param, url].includes(calibrationPath) || bareCalibration;
    const calibrating = calibration && activeStates.has(print.gcode_state);
    return { key, task, name, file, param, url, plate, plateKnown, calibration, calibrating, bareCalibration,
      available: !calibration && Boolean(name || file || url) };
  }
  function calibrationStatus(print, job = describe(print)) {
    if (!job.calibration) return '';
    if (job.calibrating) return 'Calibrating';
    if (print.gcode_state === 'FINISH') return 'Calibration complete';
    if (print.gcode_state === 'FAILED') return 'Calibration failed';
    return 'Waiting for print';
  }
  return { describe, id, filePath, calibrationStatus, confirmsBareCalibration, hasDifferentPrintFile };
});
