// Hub landing page — widget gallery + scene templates + saved scenes.

(async function () {
  const [statusR, widgetsR, templatesR, scenesR, authR] = await Promise.all([
    fetch('/api/status').then(r => r.json()).catch(() => null),
    fetch('/api/widgets').then(r => r.json()).catch(() => []),
    fetch('/api/obs/templates').then(r => r.json()).catch(() => []),
    fetch('/api/obs/scenes').then(r => r.json()).catch(() => []),
    fetch('/auth/status').then(r => r.json()).catch(() => ({ enabled: false, signedIn: false })),
  ]);

  const printerType = statusR?.printer?.type || 'X1';
  const caps = window.capsFor(printerType);
  const cloudSignedIn = !!(authR?.enabled && authR?.signedIn);

  renderHero(statusR);
  renderTemplates(templatesR, printerType);
  renderScenes(scenesR);
  renderGallery(widgetsR, caps, cloudSignedIn);

  // The OBS import instructions reference the scene collection's name as
  // "BambuBoard <version>". Stamp the actual running version into the
  // instructions so users see the same string they'll find in OBS.
  const verEl = document.getElementById('export-version');
  if (verEl && statusR?.version) verEl.textContent = statusR.version;
})();

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs, kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(k => k && e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
  return e;
}

function renderHero(s) {
  const host = $('#hero');
  if (!host) return;
  const printerName = s?.printer?.name || 'Printer';
  const type = s?.printer?.type || '?';
  const conn = s?.status?.connection || 'unknown';
  host.innerHTML = '';
  host.appendChild(el('div', {}, [
    el('h1', { text: 'Export to OBS' }),
    el('p', { text: `Download your scene file and import it into OBS Studio. The widgets stream live data from your printer.` }),
  ]));
  host.appendChild(el('div', { class: 'btn-row' }, [
    el('span', { class: 'pill ' + (conn === 'online' ? 'pill-ok' : 'pill-warn'), text: `${printerName} · ${type} · ${conn}` }),
    el('a', { class: 'btn btn-ghost', href: '/scene-editor', text: '← Back to Layout' }),
  ]));
}

function renderTemplates(list, printerType) {
  const host = $('#templates-row');
  if (!host) return;
  host.innerHTML = '';
  if (!list.length) {
    host.appendChild(el('div', { class: 'empty', text: 'No templates found.' }));
    return;
  }
  list.forEach(tpl => {
    const recommended = (tpl.recommendedTypes || []).includes(printerType);
    const card = el('div', { class: 'card scene-card' + (tpl.recommendedTypes && tpl.recommendedTypes.length && !recommended ? ' disabled' : '') }, [
      el('div', { class: 'scene-label', text: tpl.label || tpl.slug }),
      el('div', { class: 'scene-meta', text: tpl.description || '' }),
      el('div', { class: 'btn-row' }, [
        el('a', { class: 'btn btn-primary', href: `/api/obs/templates/${tpl.slug}`, text: 'Download for OBS' }),
        el('a', { class: 'btn btn-ghost', href: `/api/obs/templates/${tpl.slug}/raw`, target: '_blank', text: 'Raw' }),
      ]),
      recommended ? el('span', { class: 'pill pill-ok', text: `Recommended for ${printerType}` }) : null,
    ]);
    host.appendChild(card);
  });
}

function renderScenes(list) {
  const host = $('#scenes-row');
  if (!host) return;
  host.innerHTML = '';
  if (!list.length) {
    host.appendChild(el('div', { class: 'empty', html:
      'No saved scenes yet. Go to the <a href="/scene-editor">Layout</a> step, design your scene, and click "Save & Continue to Export".' }));
    return;
  }
  // If we arrived from /scene-editor's "Save & Continue to Export" flow, the
  // hash carries the saved scene's name so we can highlight it and scroll to it.
  const justSaved = (location.hash.match(/saved=([^&]+)/) || [])[1];
  const justSavedDecoded = justSaved ? decodeURIComponent(justSaved) : null;
  // Sort scenes so the most recently updated is first.
  const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sorted.forEach(s => {
    const isJustSaved = justSavedDecoded && s.name === justSavedDecoded;
    const card = el('div', { class: 'card scene-card' + (isJustSaved ? ' scene-card-highlight' : '') }, [
      isJustSaved ? el('span', { class: 'pill pill-ok', text: '✓ Just saved' }) : null,
      el('div', { class: 'scene-label', text: s.name }),
      el('div', { class: 'scene-meta', text: 'Updated ' + new Date(s.updatedAt).toLocaleString() }),
      el('div', { class: 'btn-row' }, [
        el('a', { class: 'btn btn-primary', href: `/api/obs/scenes/${s.slug}`, text: 'Download for OBS' }),
        el('button', { class: 'btn btn-danger', onclick: async () => {
          if (!confirm(`Delete "${s.name}"?`)) return;
          const r = await fetch(`/api/obs/scenes/${s.slug}`, { method: 'DELETE' });
          if (r.ok) { window.toast('Deleted'); location.reload(); }
        }, text: 'Delete' }),
      ]),
    ]);
    host.appendChild(card);
    if (isJustSaved) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  });
}

// In-memory store of per-widget customizations (Tier 1).
const customizations = {};

function renderGallery(widgets, caps, cloudSignedIn) {
  const host = $('#gallery');
  if (!host) return;
  host.innerHTML = '';
  if (!widgets.length) {
    host.appendChild(el('div', { class: 'empty', text: 'No widgets discovered.' }));
    return;
  }
  const baseHost = location.host;
  widgets.forEach(w => {
    const requires = w.requiresCap;
    const locked = !!requires && !caps[requires];
    const isCloud = Array.isArray(w.tags) && w.tags.includes('cloud');
    const cloudLocked = isCloud && !cloudSignedIn;
    const baseUrl = `${location.protocol}//${baseHost}/widgets/${w.slug}/`;
    let iframe;

    const customizer = el('div', { class: 'widget-customizer' }, [
      el('div', { class: 'row' }, [
        el('label', { text: 'Title' }),
        el('input', { class: 'input', type: 'text', placeholder: '(default)', oninput: (e) => updateCust(w.slug, 'title', e.target.value) }),
      ]),
      el('div', { class: 'row' }, [
        el('label', { text: 'Theme' }),
        select(['(default)', 'dark', 'light', 'transparent'], (val) => updateCust(w.slug, 'theme', val === '(default)' ? '' : val)),
      ]),
      el('div', { class: 'row' }, [
        el('label', { text: 'Accent' }),
        el('input', { type: 'color', value: '#51a34f', onchange: (e) => updateCust(w.slug, 'accent', e.target.value.replace(/^#/, '')) }),
      ]),
      el('div', { class: 'row' }, [
        el('label', { text: 'Font px' }),
        el('input', { class: 'input', type: 'number', min: '8', max: '64', placeholder: 'auto', oninput: (e) => updateCust(w.slug, 'fontSize', e.target.value) }),
      ]),
    ]);

    const anyLocked = locked || cloudLocked;
    const tile = el('div', { class: 'widget-tile' + (anyLocked ? ' disabled' : ''), id: `tile-${w.slug}` }, [
      el('div', { class: 'widget-tile-header' }, [
        el('span', { class: 'widget-tile-name', text: w.name || w.slug }),
        isCloud ? el('span', { class: 'pill pill-cloud', text: 'cloud', title: 'Requires Bambu Cloud sign-in' }) : null,
        el('span', { class: 'pill', text: w.slug }),
      ]),
      el('div', { class: 'widget-tile-preview' }, [
        locked
          ? el('div', { class: 'lock-overlay' }, [
              el('strong', { text: capRequiredLabel(requires) }),
              el('span', { text: 'Not available for this printer type' })
            ])
          : cloudLocked
          ? el('div', { class: 'lock-overlay' }, [
              el('strong', { text: 'Requires Bambu Cloud' }),
              el('a', { href: '/setup#cloud-section', class: 'btn btn-ghost', style: 'margin-top:var(--space-2);font-size:12px', text: 'Sign in' })
            ])
          : (iframe = el('iframe', { src: `/widgets/${w.slug}/`, title: w.name || w.slug, loading: 'lazy' }))
      ]),
      el('div', { class: 'widget-tile-footer' }, [
        el('span', { class: 'widget-url', title: baseUrl, id: `url-${w.slug}`, text: baseUrl }),
        el('button', { class: 'btn btn-ghost', onclick: () => copy(document.getElementById(`url-${w.slug}`).textContent), text: 'Copy' }),
        locked ? null : el('button', { class: 'btn btn-ghost', onclick: () => customizer.classList.toggle('open'), text: 'Customize' }),
      ]),
      customizer,
    ]);
    host.appendChild(tile);

    function updateCust(slug, key, val) {
      customizations[slug] = customizations[slug] || {};
      if (val === '' || val == null) delete customizations[slug][key];
      else customizations[slug][key] = val;
      // Refresh iframe + URL display
      const params = new URLSearchParams();
      for (const k in customizations[slug]) params.set(k, customizations[slug][k]);
      const next = baseUrl + (params.toString() ? '?' + params.toString() : '');
      const urlEl = document.getElementById(`url-${w.slug}`);
      if (urlEl) urlEl.textContent = next;
      if (iframe) iframe.src = `/widgets/${w.slug}/` + (params.toString() ? '?' + params.toString() : '');
      updateCustomizeBar();
    }
  });

  // Append a sticky download bar
  const bar = el('div', { class: 'customize-bar', id: 'customize-bar' }, [
    el('div', {}, [el('span', { class: 'pill pill-info', id: 'customize-count', text: '0 customized' })]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-ghost', onclick: clearCustomizations, text: 'Reset' }),
      el('button', { class: 'btn', onclick: saveCustomScene, text: 'Save scene' }),
      el('button', { class: 'btn btn-primary', onclick: downloadCustomScene, text: 'Download scene' }),
    ]),
  ]);
  document.querySelector('main.page').appendChild(bar);
  updateCustomizeBar();
}

function updateCustomizeBar() {
  const bar = document.getElementById('customize-bar');
  if (!bar) return;
  const count = Object.keys(customizations).filter(k => Object.keys(customizations[k]).length > 0).length;
  bar.classList.toggle('visible', count > 0);
  const lbl = document.getElementById('customize-count');
  if (lbl) lbl.textContent = `${count} widget${count === 1 ? '' : 's'} customized`;
}

function clearCustomizations() {
  for (const k in customizations) delete customizations[k];
  location.reload();
}

async function pickTemplate() {
  const r = await fetch('/api/obs/templates').then(r => r.json()).catch(() => []);
  if (!r.length) return null;
  if (r.length === 1) return r[0].slug;
  // Simple prompt for now
  const labels = r.map((t, i) => `${i + 1}. ${t.label || t.slug}`).join('\n');
  const idx = prompt(`Which template?\n${labels}`, '1');
  const i = parseInt(idx, 10) - 1;
  return r[i] ? r[i].slug : r[0].slug;
}

async function downloadCustomScene() {
  const tpl = await pickTemplate();
  if (!tpl) return;
  const r = await fetch('/api/obs/customize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: tpl, customizations }),
  });
  if (!r.ok) return window.toast('Download failed', 'error');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `bambuboard-custom.json`; a.click();
  URL.revokeObjectURL(url);
  window.toast('Downloaded');
}

async function saveCustomScene() {
  const name = prompt('Save scene as:');
  if (!name) return;
  const tpl = await pickTemplate();
  if (!tpl) return;
  const r = await fetch('/api/obs/customize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: tpl, customizations, name }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.ok) {
    window.toast(`Saved as "${name}"`);
    setTimeout(() => location.reload(), 600);
  } else {
    window.toast('Save failed: ' + (j.error || ''), 'error');
  }
}

function select(options, onChange) {
  const s = document.createElement('select');
  s.className = 'select';
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    s.appendChild(opt);
  });
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function capRequiredLabel(cap) {
  if (cap === 'hasDualNozzle') return 'Requires dual-nozzle (H2D)';
  if (cap === 'hasDualAMS')    return 'Requires dual-AMS (H2D)';
  if (cap === 'hasChamberTemp')return 'Requires chamber temperature sensor';
  return cap;
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => window.toast && window.toast('Copied'));
}
