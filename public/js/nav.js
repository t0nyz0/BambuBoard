// Shared top-nav injector. Include with <script src="/js/nav.js"></script>
// in any full-page view (NOT in OBS widget pages).
//
// Renders two horizontal bars:
//   1. The top nav (brand + links + status pills)
//   2. A workflow stepper showing the 4-step setup flow
//      (Setup → Connect → Layout → Export). The stepper is hidden on
//      Dashboard / Login since those aren't part of the setup workflow.
(function () {
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => e.appendChild(c));
    return e;
  }

  // Workflow steps. Order matches the in-app 4-step setup flow.
  // - matchPath: which URL pathnames mark this as the active step
  // - href:      where clicking the step takes the user
  // - locked:    function(status) → bool. Locked steps are not clickable.
  const STEPS = [
    { num: 1, label: 'Setup',   href: '/setup',         match: p => p.startsWith('/setup'),
      locked: () => false },
    { num: 2, label: 'Connect', href: '/setup#connect', match: p => p === '/setup#connect',
      locked: s => !s || !s.setupComplete },
    { num: 3, label: 'Layout',  href: '/scene-editor',  match: p => p.startsWith('/scene-editor'),
      locked: s => !s || !s.setupComplete },
    { num: 4, label: 'Go Live', href: '/',              match: p => p === '/',
      locked: s => !s || !s.setupComplete },
  ];

  // Pages where the stepper is hidden — these aren't part of the workflow.
  const STEPPER_HIDDEN_ON = ['/login'];

  function build() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    // Leads with the core loop: Live (the published output / "go live" page) is
    // the primary destination, Layout is the editor, Setup is config. The old
    // Export hub and the standalone Dashboard are gone — /live is both the
    // output and the de-facto dashboard now.
    const items = [
      { href: '/',             label: 'Live',   match: p => p === '/' },
      { href: '/scene-editor', label: 'Layout', match: p => p.startsWith('/scene-editor') },
      { href: '/setup',        label: 'Setup',  match: p => p.startsWith('/setup') },
    ];

    // Brand mark — designed to actually stand out in the top-left.
    // Layered geometric mark suggesting print layers + nozzle flow:
    //   - Bold colored hexagon-ish base (extruder body)
    //   - Stacked layer lines emerging from it (the print)
    //   - Connection-status dot in the corner pulses when MQTT is online
    // Wordmark uses heavier weight + tighter tracking for visual confidence.
    const brand = document.createElement('a');
    brand.className = 'nav-brand';
    brand.href = '/';
    brand.innerHTML = `
      <span class="bb-logo-wrap">
        <svg class="bb-logo" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
          <defs>
            <linearGradient id="bb-logo-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%"  stop-color="#6dc26b"/>
              <stop offset="100%" stop-color="#3d8c3b"/>
            </linearGradient>
          </defs>
          <!-- Build plate -->
          <rect x="3" y="25" width="26" height="3" rx="1.5" fill="currentColor" opacity="0.25"/>
          <!-- Print layers — wider at the bottom, narrower at top, suggesting a
               vertical extrusion. Filled with the gradient for richer color. -->
          <rect x="6"  y="20" width="20" height="3.5" rx="1.5" fill="url(#bb-logo-grad)" opacity="0.55"/>
          <rect x="8"  y="14" width="16" height="3.5" rx="1.5" fill="url(#bb-logo-grad)" opacity="0.78"/>
          <rect x="10" y="8"  width="12" height="3.5" rx="1.5" fill="url(#bb-logo-grad)"/>
          <!-- Status dot -->
          <circle class="bb-logo-status" cx="26" cy="6" r="3.5" />
        </svg>
        <span class="bb-logo-text">BambuBoard</span>
      </span>
    `;

    const links = el('div', { class: 'nav-links' }, items.map(it => {
      return el('a', {
        href: it.href,
        class: 'nav-link' + (it.match(path) ? ' active' : ''),
        text: it.label,
      });
    }));

    const meta = el('div', { class: 'nav-meta', id: 'nav-meta' }, []);
    const nav = el('nav', { class: 'nav' }, [brand, links, el('div', { class: 'nav-spacer' }), meta]);
    document.body.insertBefore(nav, document.body.firstChild);

    // Stepper (separate bar below the nav). Hidden on dashboard/login/customize.
    const showStepper = !STEPPER_HIDDEN_ON.some(p => path.startsWith(p));
    if (showStepper) {
      const stepper = el('div', { class: 'bb-stepper', id: 'bb-stepper' }, []);
      nav.parentNode.insertBefore(stepper, nav.nextSibling);
      // First render uses an empty status; refreshStatus will fill it in.
      renderStepper(null);
    }

    refreshStatus();
    setInterval(refreshStatus, 5000);
  }

  function renderStepper(status) {
    const host = document.getElementById('bb-stepper');
    if (!host) return;
    const path = location.pathname.replace(/\/$/, '') || '/';
    const hash = location.hash || '';
    host.innerHTML = '';
    STEPS.forEach((step, i) => {
      const active = step.match(path + hash) || step.match(path);
      const completed = isStepComplete(step.num, status);
      const locked = step.locked(status);

      const cls = ['bb-step',
        active ? 'is-active' : '',
        completed ? 'is-complete' : '',
        locked ? 'is-locked' : '',
      ].filter(Boolean).join(' ');

      const node = locked
        ? el('span', { class: cls, title: 'Complete the previous step first' })
        : el('a', { class: cls, href: step.href });

      const circle = el('span', { class: 'bb-step-circle', text: completed ? '✓' : String(step.num) });
      const lbl = el('span', { class: 'bb-step-label', text: step.label });
      node.appendChild(circle);
      node.appendChild(lbl);
      host.appendChild(node);

      if (i < STEPS.length - 1) {
        host.appendChild(el('span', { class: 'bb-step-connector' + (completed ? ' is-complete' : '') }));
      }
    });
  }

  function isStepComplete(num, status) {
    if (!status) return false;
    if (num === 1) return !!status.setupComplete;
    if (num === 2) return !!status.connected;
    // Steps 3 and 4 don't have a clear "completed" state today — they're done
    // when the user clicks "Save & Continue to Export". Could be tracked via
    // localStorage in a future iteration. Leave as not-complete for now so
    // the breadcrumb just shows progress through the flow.
    return false;
  }

  async function refreshStatus() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) return;
      const s = await r.json();

      // Reflect connection state on the brand mark — green pulse when online,
      // amber dim when offline, gray when unknown. This makes the logo
      // double as a quick at-a-glance status indicator.
      const brand = document.querySelector('.nav-brand');
      if (brand) {
        brand.classList.remove('is-online', 'is-offline', 'is-unknown');
        const conn = s.status?.connection || 'unknown';
        brand.classList.add('is-' + conn);
      }

      const meta = document.getElementById('nav-meta');
      if (meta) {
        const pillClass = s.status?.connection === 'online' ? 'pill-ok'
          : s.status?.connection === 'offline' ? 'pill-warn'
          : 'pill-error';
        meta.innerHTML = `
          <span class="pill ${pillClass}">${s.printer.name || s.printer.type} · ${s.status?.connection || 'unknown'}</span>
          <span class="pill ${s.cloudAuth.signedIn ? 'pill-info' : ''}">${s.cloudAuth.enabled ? (s.cloudAuth.signedIn ? 'Cloud: signed in' : 'Cloud: on') : 'Cloud: off'}</span>
        `;
      }
      renderStepper(s);
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();

// Toast helper used by other pages
window.toast = function (msg, kind) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity 200ms'; t.style.opacity = '0'; }, 2400);
  setTimeout(() => t.remove(), 2700);
};
