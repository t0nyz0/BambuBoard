// Loaded before the renderer so WebGL/module failures cannot leave "Loading" forever.
(function () {
  const overlay = document.getElementById('gcodeOverlay');
  const tools = document.getElementById('gcodeRecovery');
  const operator = new URLSearchParams(location.search).get('mode') === 'preview';
  const log = [];
  let retry = () => location.reload();
  let cancel = () => {};
  const fileButton = document.getElementById('gcodeFileButton');
  const cancelButton = document.getElementById('gcodeCancel');
  const downloadButton = document.getElementById('gcodeDownloadLog');
  const connectionLink = document.getElementById('gcodeConnection');
  window.BBGcodeUI = {
    log,
    operator,
    message(text, kind, canCancel = false, connectionIssue = false) {
      const stage = document.querySelector('.gcode-stage');
      stage.classList.toggle('error-state', kind === 'error');
      stage.classList.toggle('calibration-state', kind === 'calibration');
      stage.setAttribute('aria-busy', String(kind === 'loading'));
      overlay.textContent = text;
      connectionLink.hidden = !operator || !connectionIssue;
      const waiting = kind === 'waiting' || kind === 'calibration';
      overlay.classList.toggle('waiting', waiting);
      for (const name of ['loading', 'error']) overlay.classList.toggle(name, kind === name);
      overlay.style.display = text ? (waiting ? 'flex' : 'block') : 'none';
      tools.hidden = !operator || connectionIssue || (kind !== 'error' && !canCancel);
      cancelButton.hidden = !operator || !canCancel;
      downloadButton.hidden = !operator || kind !== 'error';
      this.recovery(kind === 'error');
    },
    recovery(available, canRetry = available) {
      document.getElementById('gcodeRetry').hidden = !operator || !canRetry;
      fileButton.hidden = !operator || !available;
    },
    bindRetry(callback) { retry = callback; },
    bindCancel(callback) { cancel = callback; },
    allowFile(value) { fileButton.disabled = !operator || !value; },
    fail(error) {
      const detail = error?.message || String(error);
      log.push({ at: new Date().toISOString(), stage: 'renderer', detail });
      document.getElementById('gcodeViewControls').hidden = true;
      document.body.classList.remove('gcode-operator');
      this.message(operator
        ? '3D preview could not start. Enable WebGL 2 or hardware acceleration, then retry. Download diagnostics for the exact error.'
        : '3D preview unavailable.', 'error');
    },
  };
  if (!operator) return;
  document.getElementById('gcodeRetry').addEventListener('click', () => retry());
  cancelButton.addEventListener('click', () => cancel());
  const fileInput = document.getElementById('gcodeFile');
  fileButton.addEventListener('click', () => fileInput.click());
  downloadButton.addEventListener('click', async () => {
    let server;
    try { server = await fetch('/api/gcode/diagnostics', { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(r => r.json()); }
    catch (_) { server = { result: 'unreachable', detail: 'BambuBoard diagnostic endpoint could not be reached.' }; }
    const report = { capturedAt: new Date().toISOString(), browser: navigator.userAgent, renderer: log.slice(-30), widget: window.__log?.() || [], server };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'bambuboard-gcode-diagnostics.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
