// Live workspace: show the published output first; relay is an optional action.
(function () {
  const $ = id => document.getElementById(id);
  const obsUrl = $('live-url');
  const copyUrl = $('copy-url');
  function showLayout() {
    if (!$('live-frame').hasAttribute('src')) $('live-frame').src = '/live';
    $('preview-viewport').hidden = false;
    $('preview-loading').hidden = true;
  }
  $('show-layout').addEventListener('click', () => {
    showLayout();
    $('live-frame').focus();
  });
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
      const r = await fetch('/api/obs/active', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error();
      const a = await r.json();
      const url = a.obsUrl || '';
      if (obsUrl.value !== url) obsUrl.value = url;
      obsUrl.placeholder = 'Source URL unavailable';
      copyUrl.disabled = !obsUrl.value;
      $('active-line').textContent = a.name || a.label || a.slug || 'Default scene';
      $('publication-state').textContent = a.slug ? 'Published' : 'Using the built-in layout';
      $('publication-state').className = 'pill' + (a.slug ? ' pill-ok' : '');
      const { x = 1920, y = 1080 } = a.resolution || {};
      $('preview-viewport').style.aspectRatio = `${x} / ${y}`;
      $('obs-dimensions').textContent = `${x} × ${y}`;
    } catch (_) {
      obsUrl.placeholder = 'Source URL unavailable';
      $('active-line').textContent = 'Could not check publication state';
      $('publication-state').textContent = 'Unavailable';
      $('publication-state').className = 'pill pill-warn';
    }
  }
  window.addEventListener('bambuboard:status', ({ detail: s }) => {
    if (s?.version) $('app-version').textContent = s.version;
    const ready = s?.telemetryConnection === 'online';
    $('printer-notice').hidden = ready;
    if (ready) {
      showLayout();
      return;
    }
    const message = !s ? 'Printer status is temporarily unavailable.' : s.telemetryConnection === 'waiting'
      ? 'Waiting for printer data.' : 'Printer disconnected. Your layout is still available.';
    if ($('printer-status-message').textContent !== message) $('printer-status-message').textContent = message;
  });
  refreshActive();
  setInterval(() => { if (!document.hidden) refreshActive(); }, 4000);

})();
