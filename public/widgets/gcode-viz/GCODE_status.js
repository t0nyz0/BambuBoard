// Loaded before the renderer so WebGL/module failures cannot leave "Loading" forever.
(function () {
  const overlay = document.getElementById('gcodeOverlay');
  const tools = document.getElementById('gcodeRecovery');
  const log = [];
  let retry = () => location.reload();
  const fileButton = document.getElementById('gcodeFileButton');
  window.BBGcodeUI = {
    log,
    message(text, kind) {
      document.querySelector('.gcode-stage').classList.toggle('error-state', kind === 'error');
      overlay.textContent = text;
      for (const name of ['loading', 'error', 'waiting']) overlay.classList.toggle(name, kind === name);
      overlay.style.display = text ? (kind === 'waiting' ? 'flex' : 'block') : 'none';
      tools.hidden = kind !== 'error';
    },
    bindRetry(callback) { retry = callback; },
    allowFile(value) { fileButton.disabled = !value; },
    fail(error) {
      const detail = error?.message || String(error);
      log.push({ at: new Date().toISOString(), stage: 'renderer', detail });
      this.message('3D preview could not start. Enable WebGL 2 / hardware acceleration in your browser or OBS, then retry. Download diagnostics for the exact error.', 'error');
    },
  };
  document.getElementById('gcodeRetry').addEventListener('click', () => retry());
  const fileInput = document.getElementById('gcodeFile');
  fileButton.addEventListener('click', () => fileInput.click());
  document.getElementById('gcodeDownloadLog').addEventListener('click', async () => {
    let server;
    try { server = await fetch('/api/gcode/diagnostics', { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(r => r.json()); }
    catch (_) { server = { result: 'unreachable', detail: 'BambuBoard diagnostic endpoint could not be reached.' }; }
    const report = { capturedAt: new Date().toISOString(), browser: navigator.userAgent, renderer: log.slice(-30), widget: window.__log?.() || [], server };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'bambuboard-gcode-diagnostics.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
