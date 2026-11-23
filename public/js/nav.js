// Shared navigation for the management pages. Broadcast widgets keep their own styles.
(function () {
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  let stepper, stepperState, printerStatus, cloudLink, refreshId = 0, cloudRefreshId = 0;
  async function getJSON(path) {
    const reply = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!reply.ok) throw new Error('Status unavailable');
    return reply.json();
  }
  async function refreshStatus() {
    const revision = ++refreshId;
    try {
      const status = await getJSON('/api/status');
      if (revision !== refreshId) return;
      const ready = status.telemetryConnection === 'online';
      const label = ready ? 'receiving data' : status.telemetryConnection === 'waiting' ? 'waiting for data' : 'disconnected';
      printerStatus.className = 'pill ' + (ready ? 'pill-ok' : 'pill-warn');
      printerStatus.textContent = !status.setupComplete ? 'Printer setup required' : `${status.printer?.name || status.printer?.type || 'Printer'} · ${label}`;
      renderStepper(status);
      window.dispatchEvent(new CustomEvent('bambuboard:status', { detail: status }));
    } catch (_) {
      if (revision !== refreshId) return;
      printerStatus.className = 'pill pill-warn';
      printerStatus.textContent = 'Connection status unavailable';
      window.dispatchEvent(new CustomEvent('bambuboard:status', { detail: null }));
    }
  }
  async function refreshCloud() {
    const revision = ++cloudRefreshId;
    const cloud = await getJSON('/auth/status').catch(() => null);
    if (revision !== cloudRefreshId) return;
    cloudLink.className = 'pill cloud-pill' + (cloud?.needsSignIn ? ' pill-warn' : cloud?.signedIn ? ' pill-info' : '');
    cloudLink.textContent = !cloud ? 'Cloud status unavailable' : cloud.needsSignIn ? 'Cloud sign-in needed' : cloud.signedIn ? 'Cloud signed in' : 'Cloud optional';
    window.dispatchEvent(new CustomEvent('bambuboard:cloud-status', { detail: cloud }));
  }
  function renderStepper(status) {
    const firstRun = new URLSearchParams(location.search).get('firstRun') === '1';
    stepper.hidden = location.pathname === '/login' || (status.setupComplete && !firstRun);
    if (stepper.hidden) return;
    const current = location.pathname + (location.hash === '#connect' ? '#connect' : '');
    const ready = status.telemetryConnection === 'online';
    const steps = [
      ['Setup', '/setup', status.setupComplete, false],
      ['Printer data', '/setup#connect', ready, !status.setupComplete],
      ['Live preview', '/', ready && current === '/', !ready],
    ];
    const state = JSON.stringify([current, steps]);
    if (state === stepperState) return;
    stepperState = state;
    stepper.replaceChildren();
    steps.forEach(([label, href, done, locked], i) => {
      const item = make(locked ? 'span' : 'a', 'bb-step' + (done ? ' is-complete' : '') + (locked ? ' is-locked' : ''));
      if (!locked) {
        const url = new URL(href, location.origin);
        url.searchParams.set('firstRun', '1');
        item.href = url.pathname + url.search + url.hash;
      }
      if (current === href) {
        item.classList.add('is-active');
        item.setAttribute('aria-current', 'step');
      }
      const circle = make('span', 'bb-step-circle', done ? '✓' : String(i + 1));
      circle.setAttribute('aria-hidden', 'true');
      item.append(circle, make('span', 'bb-step-label', label));
      if (done) item.append(make('span', 'sr-only', ' (completed)'));
      stepper.appendChild(item);
      if (i < steps.length - 1) stepper.appendChild(make('span', 'bb-step-connector' + (done ? ' is-complete' : '')));
    });
  }
  function build() {
    const main = document.querySelector('main');
    if (main) { main.id = 'main-content'; main.tabIndex = -1; }
    const skip = make('a', 'skip-link', 'Skip to content'); skip.href = '#main-content';
    const nav = make('nav', 'nav'); nav.setAttribute('aria-label', 'Main navigation');
    const brand = make('a', 'nav-brand'); brand.href = '/';
    brand.innerHTML = '<img class="bb-logo" src="/assets/bambuboard-prism.svg" alt="" width="34" height="36"><span class="bb-logo-text">BambuBoard</span>';
    const links = make('div', 'nav-links');
    [['/', 'Live', 'desktop_windows'], ['/scene-editor', 'Layout', 'dashboard'], ['/setup', 'Setup', 'tune']].forEach(([href, label, icon]) => {
      const link = make('a', 'nav-link'); link.href = href;
      if (location.pathname === href) { link.classList.add('active'); link.setAttribute('aria-current', 'page'); }
      const symbol = make('span', 'nav-icon', icon); symbol.setAttribute('aria-hidden', 'true');
      link.append(symbol, document.createTextNode(label)); links.appendChild(link);
    });
    const meta = make('div', 'nav-meta'); meta.id = 'nav-meta';
    printerStatus = make('span', 'pill', 'Checking printer…');
    cloudLink = make('a', 'pill cloud-pill', 'Cloud optional');
    cloudLink.href = '/setup#cloud-section'; cloudLink.title = 'Open Bambu Cloud settings';
    meta.append(printerStatus, cloudLink);
    nav.append(brand, links, make('div', 'nav-spacer'), meta);
    stepper = make('nav', 'bb-stepper'); stepper.id = 'bb-stepper'; stepper.hidden = true;
    stepper.setAttribute('aria-label', 'Printer setup progress');
    document.body.prepend(skip, nav, stepper);
    refreshStatus();
    refreshCloud();
    setInterval(() => { if (!document.hidden) { refreshStatus(); refreshCloud(); } }, 5000);
    window.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshStatus(); refreshCloud(); } });
    window.addEventListener('bambuboard:settings-saved', refreshStatus);
    window.addEventListener('bambuboard:cloud-updated', refreshCloud);
    window.addEventListener('hashchange', refreshStatus);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();

// Toast helper used by other pages
window.toast = function (msg, kind) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity 200ms'; t.style.opacity = '0'; }, 2400);
  setTimeout(() => t.remove(), 2700);
};
