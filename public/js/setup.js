// Setup page — printer config + display prefs + cloud auth.

(async function init() {
  const types = await fetch('/api/printer-types').then(r => r.json()).catch(() => []);
  const cfg = await fetch('/api/settings').then(r => r.json()).catch(() => null);
  if (!cfg) return;

  const isFirst = new URLSearchParams(location.search).get('firstRun') === '1' || cfg._meta?.firstRun;
  if (isFirst) document.body.classList.add('first-run');

  // Type dropdown
  const typeSel = document.getElementById('p-type');
  types.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.value; opt.textContent = `${t.label} (${t.value})`;
    typeSel.appendChild(opt);
  });
  typeSel.value = cfg.printer?.type || 'X1';

  // Hydrate fields
  document.getElementById('p-name').value = cfg.printer?.name || '';
  document.getElementById('p-url').value = cfg.printer?.url || '';
  document.getElementById('p-port').value = cfg.printer?.port || '8883';
  document.getElementById('p-sn').value = cfg.printer?.serialNumber === 'FILL_THIS_OUT' ? '' : (cfg.printer?.serialNumber || '');
  document.getElementById('p-ac-status').textContent = cfg.printer?.accessCodeSet ? 'A code is saved. Leave blank to keep it.' : 'Required.';
  document.getElementById('temp').value = cfg.BambuBoard_tempSetting || 'Both';
  toggle('fan-pct', !!cfg.BambuBoard_displayFanPercentages);
  toggle('fan-icons', cfg.BambuBoard_displayFanIcons !== false);
  toggle('logging', !!cfg.BambuBoard_logging);
  toggle('cloud-enabled', !!cfg.cloudAuth?.enabled);

  document.querySelectorAll('.toggle').forEach(t => {
    t.addEventListener('click', () => t.classList.toggle('on'));
  });

  document.getElementById('show-ac').addEventListener('click', () => {
    const i = document.getElementById('p-ac');
    i.type = i.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('test-btn').addEventListener('click', async () => {
    const btn = document.getElementById('test-btn');
    btn.disabled = true;
    const res = document.getElementById('test-result');
    res.className = 'test-result';
    res.textContent = 'Testing connection…';
    const body = readPrinterFields();
    try {
      const r = await fetch('/api/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) { res.className = 'test-result ok'; res.textContent = '✓ Connected.'; }
      else     { res.className = 'test-result error'; res.textContent = '✗ ' + (j.error || 'Connection failed'); }
    } catch (e) {
      res.className = 'test-result error'; res.textContent = '✗ ' + e.message;
    }
    btn.disabled = false;
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const body = {
      BambuBoard_tempSetting: document.getElementById('temp').value,
      BambuBoard_displayFanPercentages: isOn('fan-pct'),
      BambuBoard_displayFanIcons: isOn('fan-icons'),
      BambuBoard_logging: isOn('logging'),
      cloudAuth: { enabled: isOn('cloud-enabled') },
      printer: readPrinterFields(),
    };
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      window.toast('Settings saved');
      // Reveal the Connect (Step 2) section and start polling. We replace the
      // old "redirect to / after 600ms" behavior with this two-step flow:
      // user verifies the printer connects + auto-identifies before being
      // sent to the Layout page.
      revealConnectSection();
    } else {
      const j = await r.json().catch(() => ({}));
      window.toast('Save failed: ' + (j.error || r.status), 'error');
    }
  });

  // If the user lands on this page with valid existing credentials, show the
  // Connect section immediately so they can re-check status / proceed without
  // re-saving. (Only triggered when not first-run, since first-run users
  // haven't filled the form yet.)
  if (!isFirst && cfg && !cfg._meta?.firstRun) {
    revealConnectSection();
  }
  // Also reveal if the user manually navigated to /setup#connect
  if (location.hash === '#connect') {
    revealConnectSection();
    // Scroll into view
    setTimeout(() => {
      const a = document.getElementById('connect-step');
      if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  function revealConnectSection() {
    const sec = document.getElementById('connect-step');
    if (!sec || sec.dataset.shown === '1') return;
    sec.dataset.shown = '1';
    sec.style.display = '';
    pollStatus();
    if (!sec.dataset.timer) {
      sec.dataset.timer = setInterval(pollStatus, 1500);
    }
    document.getElementById('continue-btn').addEventListener('click', () => {
      location.href = '/scene-editor';
    });
  }

  async function pollStatus() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) return;
      const s = await r.json();
      const pill = document.getElementById('connect-mqtt');
      const detected = document.getElementById('connect-detected');
      const last = document.getElementById('connect-last');
      const cont = document.getElementById('continue-btn');
      if (!pill) return;

      const conn = s.status?.connection || 'unknown';
      pill.className = 'pill ' + (conn === 'online' ? 'pill-ok' : conn === 'offline' ? 'pill-warn' : 'pill-error');
      pill.textContent = conn === 'online' ? '✓ Connected' : conn === 'offline' ? 'Connecting…' : 'Unknown';

      if (s.printer?.model) {
        const src = s.printer.detectedFrom === 'mqtt' ? '(auto-detected via MQTT)' : '(from config)';
        detected.innerHTML = `<strong>${escapeHtml(s.printer.model)}</strong> — ${escapeHtml(s.printer.type)} <span class="text-dim">${src}</span>`;
      } else if (s.printer?.type) {
        detected.innerHTML = `${escapeHtml(s.printer.type)} <span class="text-dim">(detection pending — check printer is on and reachable)</span>`;
      }

      last.textContent = s.status?.lastUpdate || 'No telemetry yet';

      // Continue button enables once we have BOTH MQTT online and printer auto-detected.
      const ready = s.connected && s.printer?.detectedFrom === 'mqtt';
      cont.disabled = !ready;
      cont.textContent = ready ? 'Continue to Layout →' : 'Waiting for printer…';
    } catch (_) {}
  }

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

  function readPrinterFields() {
    const ac = document.getElementById('p-ac').value;
    return {
      name: document.getElementById('p-name').value.trim(),
      url: document.getElementById('p-url').value.trim(),
      port: document.getElementById('p-port').value.trim() || '8883',
      serialNumber: document.getElementById('p-sn').value.trim(),
      accessCode: ac, // empty means "keep existing"
      type: document.getElementById('p-type').value,
    };
  }
  function toggle(id, on) { document.getElementById(id).classList.toggle('on', !!on); }
  function isOn(id) { return document.getElementById(id).classList.contains('on'); }
})();
