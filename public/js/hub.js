// Live workspace: show the published output first; relay is an optional action.
(function () {
  const $ = id => document.getElementById(id);
  const liveUrl = `${location.origin}/live`;
  $('live-url').value = liveUrl;
  $('copy-url').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(liveUrl);
      window.toast('Source URL copied');
    } catch (_) {
      $('live-url').focus(); $('live-url').select();
      window.toast('URL selected. Press ⌘/Ctrl+C to copy.');
    }
  });
  async function refreshActive() {
    try {
      const r = await fetch('/api/obs/active', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const a = await r.json();
      $('active-line').textContent = a.slug || a.label || 'Default scene';
      $('publication-state').textContent = a.slug ? 'Published' : 'Default layout';
      $('publication-state').className = 'pill' + (a.slug ? ' pill-ok' : '');
      $('output-label').textContent = a.slug ? 'Published output' : 'Default output · nothing published yet';
      const { x = 1920, y = 1080 } = a.resolution || {};
      $('preview-viewport').style.aspectRatio = `${x} / ${y}`;
      $('preview-dimensions').textContent = `${x} × ${y}`;
      $('obs-dimensions').textContent = `${x} × ${y}`;
    } catch (_) {
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
