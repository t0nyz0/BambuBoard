// Live page — surfaces the composited /live output, the OBS URL + 1-click
// scene download, and which scene is currently published. (Replaced the old
// OBS-export wizard: there's no scene-collection import or camera/SDP setup
// anymore — OBS just needs one Browser Source pointing at /live.)
(function () {
  const liveUrl = `${location.origin}/live`;

  const urlInput = document.getElementById('live-url');
  if (urlInput) urlInput.value = liveUrl;

  const copyBtn = document.getElementById('copy-url');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(liveUrl);
        copyBtn.textContent = 'Copied!';
      } catch (_) {
        // Fallback: select the field so the user can copy manually.
        urlInput && urlInput.select();
        copyBtn.textContent = 'Press ⌘/Ctrl+C';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1600);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Show which scene is currently published (or prompt the user to make one).
  async function refreshActive() {
    const line = document.getElementById('active-line');
    if (!line) return;
    try {
      const a = await (await fetch('/api/obs/active', { cache: 'no-store' })).json();
      if (a && a.slug) {
        line.innerHTML = `Currently live: <strong>${escapeHtml(a.slug)}</strong>. ` +
          `Change it in the <a href="/scene-editor">Layout editor</a> → 🔴 Go Live.`;
      } else {
        line.innerHTML = `Nothing published yet — open the ` +
          `<a href="/scene-editor">Layout editor</a>, design your overlay, and hit ` +
          `<strong>🔴 Go Live</strong>. Until then, /live shows a default layout.`;
      }
    } catch (_) {
      line.textContent = '';
    }
  }

  refreshActive();
})();
