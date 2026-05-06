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

  document.querySelectorAll('.toggle').forEach(t => {
    t.addEventListener('click', () => t.classList.toggle('on'));
  });

  // Bambu Cloud sign-in — wired inline in this page (was a separate /login page).
  // Two methods: email+code (Method 1) and manual token paste (Method 2, fallback
  // when Cloudflare blocks the email API). Cloud auth auto-enables when either
  // method succeeds, so the user doesn't have to flip a toggle first.
  setupCloudPanel();

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
      // cloudAuth.enabled is auto-managed by the cloud panel itself —
      // pasting a token / completing email login enables it; the
      // "Disable cloud auth entirely" link disables it. We don't include
      // it in the main settings save so we don't accidentally clobber.
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

  // ---- Bambu Cloud sign-in panel ----
  // Two methods, both inline in /setup. Method 1: email + verification code
  // (Bambu's normal flow, but Cloudflare often returns an HTML challenge
  // that breaks the JSON parser — we surface that as a "try Method 2"
  // hint). Method 2: paste the `token` cookie from a logged-in
  // makerworld.com session — most reliable when the API is gated.
  function setupCloudPanel() {
    let tfaKey = null;

    async function refresh() {
      const r = await fetch('/auth/status').then(r => r.json()).catch(() => null);
      if (!r) return;
      const signin    = document.getElementById('cloud-signin');
      const signedin  = document.getElementById('cloud-signedin');
      const disableLink = document.getElementById('cloud-disable-link');
      if (r.signedIn) {
        signin.style.display = 'none';
        signedin.style.display = '';
        document.getElementById('cloud-as').textContent = r.email ? `Signed in as ${r.email}` : 'Signed in';
        if (disableLink) disableLink.style.display = '';
      } else {
        signin.style.display = '';
        signedin.style.display = 'none';
        if (disableLink) disableLink.style.display = r.enabled ? '' : 'none';
      }
    }

    // Tab switching
    function showMethod(which) {
      document.getElementById('cloud-method-email').style.display = which === 'email' ? '' : 'none';
      document.getElementById('cloud-method-token').style.display = which === 'token' ? '' : 'none';
      document.getElementById('cloud-tab-email').className = 'btn ' + (which === 'email' ? 'btn-primary' : 'btn-ghost');
      document.getElementById('cloud-tab-token').className = 'btn ' + (which === 'token' ? 'btn-primary' : 'btn-ghost');
    }
    document.getElementById('cloud-tab-email').addEventListener('click', () => showMethod('email'));
    document.getElementById('cloud-tab-token').addEventListener('click', () => showMethod('token'));

    // Method 1: email + verification code
    document.getElementById('cloud-send-code').addEventListener('click', async () => {
      const status = document.getElementById('cloud-send-status');
      const email = document.getElementById('cloud-email').value.trim();
      if (!email) { status.textContent = 'Enter your email first'; status.style.color = 'var(--color-error)'; return; }
      status.textContent = 'Enabling cloud auth & sending code…';
      status.style.color = '';
      // sendVerificationCode requires cloudAuth.enabled — quietly enable it first
      await ensureCloudEnabled();
      try {
        const r = await fetch('/sendVerificationCode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: email }) });
        const j = await r.json();
        if (j.ok) {
          status.textContent = '✓ Code sent — check your email';
          status.style.color = 'var(--color-ok)';
        } else {
          status.innerHTML = `✗ ${escapeHtml(j.error || 'Send failed')}` + (j.tryManual ? ' — try <a href="#" data-switch-token>Method 2</a>' : '');
          status.style.color = 'var(--color-error)';
        }
      } catch (e) {
        status.innerHTML = `✗ ${escapeHtml(e.message)} — try <a href="#" data-switch-token>Method 2</a>`;
        status.style.color = 'var(--color-error)';
      }
    });

    document.getElementById('cloud-verify').addEventListener('click', async () => {
      const status = document.getElementById('cloud-verify-status');
      const email = document.getElementById('cloud-email').value.trim();
      const code  = document.getElementById('cloud-code').value.trim();
      if (!email || !code) { status.textContent = 'Email + code required'; status.style.color = 'var(--color-error)'; return; }
      status.textContent = 'Verifying…';
      status.style.color = '';
      try {
        const r = await fetch('/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: email, code }) });
        const j = await r.json();
        if (j.ok) {
          status.textContent = '✓ Signed in';
          status.style.color = 'var(--color-ok)';
          window.toast && window.toast('Signed in to Bambu Cloud');
          refresh();
        } else if (j.mfa) {
          tfaKey = j.tfaKey;
          document.getElementById('cloud-mfa').style.display = '';
          status.textContent = 'MFA required — see below';
        } else {
          status.innerHTML = `✗ ${escapeHtml(j.error || 'Verify failed')}` + (j.tryManual ? ' — try <a href="#" data-switch-token>Method 2</a>' : '');
          status.style.color = 'var(--color-error)';
        }
      } catch (e) {
        status.innerHTML = `✗ ${escapeHtml(e.message)} — try <a href="#" data-switch-token>Method 2</a>`;
        status.style.color = 'var(--color-error)';
      }
    });

    document.getElementById('cloud-mfa-submit').addEventListener('click', async () => {
      const code = document.getElementById('cloud-mfa-code').value.trim();
      if (!code || !tfaKey) return;
      const r = await fetch('/mfa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tfaKey, tfaCode: code }) });
      const j = await r.json();
      if (j.ok) { window.toast && window.toast('Signed in'); refresh(); }
      else window.toast && window.toast('MFA failed: ' + (j.error || ''), 'error');
    });

    // Method 2: paste token
    document.getElementById('cloud-token-save').addEventListener('click', async () => {
      const status = document.getElementById('cloud-token-status');
      const token = document.getElementById('cloud-token').value.trim();
      const email = document.getElementById('cloud-token-email').value.trim();
      if (!token) { status.textContent = 'Paste your token first'; status.style.color = 'var(--color-error)'; return; }
      status.textContent = 'Verifying token with Bambu Cloud…';
      status.style.color = '';
      try {
        const r = await fetch('/auth/manual-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, email }) });
        const j = await r.json();
        if (j.ok) {
          status.textContent = '✓ Token saved & verified';
          status.style.color = 'var(--color-ok)';
          window.toast && window.toast('Signed in to Bambu Cloud');
          refresh();
        } else {
          status.textContent = '✗ ' + (j.error || 'Token rejected');
          status.style.color = 'var(--color-error)';
        }
      } catch (e) {
        status.textContent = '✗ ' + e.message;
        status.style.color = 'var(--color-error)';
      }
    });

    // Sign out / disable
    document.getElementById('cloud-signout').addEventListener('click', async () => {
      await fetch('/auth/signout', { method: 'POST' });
      window.toast && window.toast('Signed out');
      refresh();
    });
    document.getElementById('cloud-disable').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Disable Bambu Cloud auth? Profile / model-image widgets will go back to placeholder content.')) return;
      // Sign out (clear token) AND set cloudAuth.enabled = false
      await fetch('/auth/signout', { method: 'POST' });
      const cur = await fetch('/api/settings').then(r => r.json());
      await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cur, cloudAuth: { enabled: false } }),
      });
      window.toast && window.toast('Cloud auth disabled');
      refresh();
    });

    // "try Method 2" inline links inside error messages
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-switch-token]')) {
        e.preventDefault();
        showMethod('token');
      }
    });

    refresh();
  }

  // Auto-enable cloud auth in config so /sendVerificationCode and /verify
  // pass the cloudEnabled() check. Idempotent — no-op if already enabled.
  async function ensureCloudEnabled() {
    const s = await fetch('/auth/status').then(r => r.json()).catch(() => null);
    if (s && s.enabled) return;
    const cur = await fetch('/api/settings').then(r => r.json());
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cur, cloudAuth: { enabled: true } }),
    });
  }
})();
