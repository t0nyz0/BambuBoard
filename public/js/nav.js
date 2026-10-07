// Shared navigation for the management pages. Broadcast widgets keep their own styles.
(function () {
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  let stepper;
  async function refreshStatus() {
    try {
      const results = await Promise.all([
        fetch('/api/status', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
        fetch('/api/obs/active', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
        fetch('/api/obs/scenes').then(r => r.json()).catch(() => []),
      ]);
      const [status, active, scenes] = results;
      const meta = document.getElementById('nav-meta');
      meta.replaceChildren();
      const online = status.connected;
      meta.appendChild(make('span', 'pill ' + (online ? 'pill-ok' : 'pill-warn'),
        `${status.printer?.name || status.printer?.type || 'Printer'} · ${online ? 'connected' : 'disconnected'}`));
      const cloud = make('span', 'pill cloud-pill' + (status.cloudAuth?.signedIn ? ' pill-info' : ''),
        status.cloudAuth?.signedIn ? 'Cloud signed in' : 'Cloud optional');
      meta.appendChild(cloud);
      renderStepper(status, active, scenes);
      window.dispatchEvent(new CustomEvent('bambuboard:status', { detail: status }));
    } catch (_) {
      const meta = document.getElementById('nav-meta');
      meta.replaceChildren(make('span', 'pill pill-warn', 'Connection status unavailable'));
    }
  }
  function renderStepper(status, active, scenes) {
    const firstRun = new URLSearchParams(location.search).get('firstRun') === '1';
    stepper.hidden = location.pathname === '/login' || (status.setupComplete && !firstRun);
    if (stepper.hidden) return;
    stepper.replaceChildren();
    const steps = [
      ['Setup', '/setup', status.setupComplete],
      ['Connect', '/setup#connect', status.connected],
      ['Layout', '/scene-editor', Array.isArray(scenes) && scenes.length > 0],
      ['Publish', '/', !!active?.slug],
    ];
    steps.forEach(([label, href, done], i) => {
      const locked = i > 0 && !status.setupComplete;
      const item = make(locked ? 'span' : 'a', 'bb-step' + (done ? ' is-complete' : '') + (locked ? ' is-locked' : ''));
      if (!locked) item.href = href;
      const current = location.pathname + location.hash;
      if (current === href || (!location.hash && location.pathname === href)) item.classList.add('is-active');
      item.append(make('span', 'bb-step-circle', done ? '✓' : String(i + 1)), make('span', 'bb-step-label', label));
      stepper.appendChild(item);
      if (i < 3) stepper.appendChild(make('span', 'bb-step-connector' + (done ? ' is-complete' : '')));
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
    meta.append(make('span', 'pill', 'Checking printer…'));
    nav.append(brand, links, make('div', 'nav-spacer'), meta);
    stepper = make('div', 'bb-stepper'); stepper.id = 'bb-stepper'; stepper.hidden = true;
    document.body.prepend(skip, nav, stepper);
    refreshStatus();
    setInterval(refreshStatus, 5000);
    window.addEventListener('bambuboard:published', refreshStatus);
    window.addEventListener('bambuboard:settings-saved', refreshStatus);
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
