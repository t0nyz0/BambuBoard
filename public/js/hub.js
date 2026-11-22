// Live workspace: show the published output first; relay is an optional action.
(function () {
  const $ = id => document.getElementById(id);
  const obsUrl = $('live-url');
  const copyUrl = $('copy-url');
  copyUrl.addEventListener('click', async () => {
    if (!obsUrl.value) return;
    try {
      await navigator.clipboard.writeText(obsUrl.value);
      window.toast('Source URL copied');
    } catch (_) {
      obsUrl.focus();
      obsUrl.select();
      window.toast('URL selected. Press ⌘/Ctrl+C to copy.');
    }
  });
  async function refreshActive() {
    try {
      const r = await fetch('/api/obs/active', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const a = await r.json();
      const url = a.obsUrl || '';
      if (obsUrl.value !== url) obsUrl.value = url;
      obsUrl.placeholder = 'Source URL unavailable';
      copyUrl.disabled = !obsUrl.value;
      $('active-line').textContent = a.name || a.label || a.slug || 'Default scene';
      $('publication-state').textContent = a.slug ? 'Published' : 'Default layout';
      $('publication-state').className = 'pill' + (a.slug ? ' pill-ok' : '');
      $('output-label').textContent = a.slug ? 'Published output' : 'Default output · nothing published yet';
      const { x = 1920, y = 1080 } = a.resolution || {};
      $('preview-viewport').style.aspectRatio = `${x} / ${y}`;
      $('preview-dimensions').textContent = `${x} × ${y}`;
      $('obs-dimensions').textContent = `${x} × ${y}`;
    } catch (_) {
      obsUrl.placeholder = 'Source URL unavailable';
      $('active-line').textContent = 'Could not check publication state';
      $('publication-state').textContent = 'Unavailable';
      $('publication-state').className = 'pill pill-warn';
    }
  }
  window.addEventListener('bambuboard:status', ({ detail: s }) => {
    $('app-version').textContent = s.version || '';
    $('printer-notice').hidden = !!s.connected;
    $('printer-notice').replaceChildren();
    if (!s.connected) {
      $('printer-notice').append('Printer disconnected. Your output remains available. ');
      const link = document.createElement('a'); link.href = '/setup#connect'; link.textContent = 'Check connection';
      $('printer-notice').appendChild(link);
    }
  });
  refreshActive();
  setInterval(() => { if (!document.hidden) refreshActive(); }, 4000);

})();
