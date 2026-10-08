// Setup page — printer config + display prefs + cloud auth.

(async function init() {
  const types = await fetch('/api/printer-types').then(r => r.json()).catch(() => []);
  const cfg = await fetch('/api/settings').then(r => r.json()).catch(() => null);
  if (!cfg) { window.toast('Could not load settings. Reload to try again.', 'error'); return; }

  const isFirst = new URLSearchParams(location.search).get('firstRun') === '1' || cfg._meta?.firstRun;
  if (isFirst) document.body.classList.add('first-run');

  // Printer type — used to be a visible dropdown but the type is auto-detected
  // from MQTT once the printer connects (see src/lib/caps.js#printerTypeFromMqtt
  // and the onPrinterDetected hook in src/server.js). We keep the field as a
  // hidden input so save/load logic still reads it; populate the option list
  // only if the element is a `<select>` (kept for back-compat if someone
  // restores the dropdown). Default 'X1' is a safe bootstrap that gets
  // overwritten within a few seconds of MQTT connecting.
  const typeEl = document.getElementById('p-type');
  if (typeEl && typeEl.tagName === 'SELECT') {
    types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.value; opt.textContent = `${t.label} (${t.value})`;
      typeEl.appendChild(opt);
    });
  }
  if (typeEl) typeEl.value = cfg.printer?.type || 'X1';

  // Hydrate fields
  document.getElementById('p-name').value = cfg.printer?.name || '';
  document.getElementById('p-url').value = cfg.printer?.url || '';
  document.getElementById('p-port').value = cfg.printer?.port || '8883';
  document.getElementById('p-sn').value = cfg.printer?.serialNumber === 'FILL_THIS_OUT' ? '' : (cfg.printer?.serialNumber || '');
  // Pre-fill the LAN access code from the dedicated credentials endpoint so
  // the user can view (Show button) / edit it without re-typing. The /api/settings
  // response strips this for safety; /api/printer-credentials returns it
  // explicitly for the setup form.
  try {
    const creds = await fetch('/api/printer-credentials').then(r => r.json());
    if (creds && creds.accessCode) {
      document.getElementById('p-ac').value = creds.accessCode;
      document.getElementById('p-ac-status').textContent = 'Saved — click Show to reveal, or edit to replace.';
    } else {
      document.getElementById('p-ac-status').textContent = 'Required.';
    }
  } catch (_) {
    document.getElementById('p-ac-status').textContent = cfg.printer?.accessCodeSet ? 'A code is saved (could not load).' : 'Required.';
  }
  // Migration: older configs saved "C" / "F" but every temp widget checks for
  // the spelled-out strings. Map legacy values forward so the dropdown shows
  // the right thing — and so the next save normalizes the file.
  const legacyTempMap = { C: 'Celsius', F: 'Fahrenheit' };
  const savedTemp = cfg.BambuBoard_tempSetting || 'Both';
  document.getElementById('temp').value = legacyTempMap[savedTemp] || savedTemp;
  toggle('fan-pct', !!cfg.BambuBoard_displayFanPercentages);
  toggle('fan-icons', cfg.BambuBoard_displayFanIcons !== false);
  toggle('logging', !!cfg.BambuBoard_logging);

  document.querySelectorAll('.toggle').forEach(t => {
    t.addEventListener('click', () => { t.classList.toggle('on'); t.setAttribute('aria-checked', String(t.classList.contains('on'))); });
  });

  // Bambu Cloud sign-in — wired inline in this page (was a separate /login page).
  // Two methods: email+code (Method 1) and manual token paste (Method 2, fallback
  // when Cloudflare blocks the email API). Cloud auth auto-enables when either
  // method succeeds, so the user doesn't have to flip a toggle first.
  setupCloudPanel();

  document.getElementById('show-ac').addEventListener('click', () => {
    const i = document.getElementById('p-ac');
    i.type = i.type === 'password' ? 'text' : 'password';
    document.getElementById('show-ac').textContent = i.type === 'password' ? 'Show' : 'Hide';
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
      // Sign out disables it. We don't include
      // it in the main settings save so we don't accidentally clobber.
      printer: readPrinterFields(),
    };
    const button = document.getElementById('save-btn');
    if (!body.printer.url || !body.printer.serialNumber || (!body.printer.accessCode && !cfg.printer?.accessCodeSet)) return window.toast('Enter the printer IP, serial number and LAN access code.', 'error');
    button.disabled = true;
    try {
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      window.toast('Settings saved');
      window.dispatchEvent(new Event('bambuboard:settings-saved'));
      // Reveal the Connect (Step 2) section and start polling. We replace the
      // old "redirect to / after 600ms" behavior with this two-step flow:
      // user verifies the printer connects + auto-identifies before being
      // sent to the Layout page.
      revealConnectSection();
    } else {
      const j = await r.json().catch(() => ({}));
      window.toast('Save failed: ' + (j.error || r.status), 'error');
    }
    } catch (e) { window.toast('Could not save settings: ' + e.message, 'error'); }
    finally { button.disabled = false; }
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
      const video = await fetch('/api/printer/video/status').then(r => r.json()).catch(() => null);
      document.getElementById('connect-camera').textContent = video?.available ? `${video.cameraType === 'rtsp' ? 'RTSP' : 'Chamber image'} available` : 'Unavailable';
      document.getElementById('connect-camera-hint').textContent = video?.available ? 'Camera status is separate from the MQTT connection.' : (video?.hint || 'Connect the printer and check camera access.');
      const pill = document.getElementById('connect-mqtt');
      const detected = document.getElementById('connect-detected');
      const last = document.getElementById('connect-last');
      const cont = document.getElementById('continue-btn');
      if (!pill) return;

      const conn = s.status?.connection || 'unknown';
      pill.className = 'pill ' + (conn === 'online' ? 'pill-ok' : conn === 'offline' ? 'pill-warn' : 'pill-error');
      pill.textContent = conn === 'online' ? '✓ Connected' : conn === 'offline' ? 'Disconnected' : 'Unknown';

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
  function toggle(id, on) { const node = document.getElementById(id); node.classList.toggle('on', !!on); node.setAttribute('aria-checked', String(!!on)); }
  function isOn(id) { return document.getElementById(id).classList.contains('on'); }

  // ---- Bambu Cloud sign-in panel ----
  function setupCloudPanel() {
    const node = id => document.getElementById(id);
    const section = node('cloud-section');
    const controls = [...section.querySelectorAll('button, input')];
    let busy = false, action = '', tfaKey = null, requestedEmail = '';
    let tokenVisible = false, methodChosen = false, tokenSaved = false;
    let resendDeadline = 0, throttleDeadline = 0, resendTimer = null;

    function message(id, text = '', tone = '') {
      const field = node(id);
      field.textContent = text;
      field.dataset.tone = tone;
    }
    function updateControls() {
      controls.forEach(control => { control.disabled = busy; });
      const wait = Math.max(0, Math.ceil((throttleDeadline - Date.now()) / 1000));
      const seconds = Math.max(wait, Math.max(0, Math.ceil((resendDeadline - Date.now()) / 1000)));
      for (const id of ['cloud-verify', 'cloud-mfa-submit', 'cloud-token-save']) node(id).disabled = busy || wait > 0;
      node('cloud-check').disabled = busy || (tokenSaved && wait > 0);
      node('cloud-send-code').disabled = busy || seconds > 0;
      node('cloud-send-code').textContent = action === 'send' ? 'Sending code…' : seconds > 0 ? 'Resend in ' + seconds + 's' : requestedEmail ? 'Resend code' : 'Send sign-in code';
      node('cloud-verify').textContent = action === 'verify' ? 'Signing in…' : wait ? 'Retry in ' + wait + 's' : 'Sign in';
      node('cloud-mfa-submit').textContent = action === 'mfa' ? 'Verifying…' : wait ? 'Retry in ' + wait + 's' : 'Verify and sign in';
      node('cloud-token-save').textContent = action === 'token' ? 'Verifying token…' : wait ? 'Retry in ' + wait + 's' : 'Verify and save token';
      node('cloud-check').textContent = action === 'check' ? 'Checking…' : tokenSaved ? wait ? 'Retry in ' + wait + 's' : 'Check connection' : 'Retry status';
      node('cloud-signout-link').textContent = action === 'signout' ? 'Signing out…' : 'Sign out';
    }
    function cooldown(seconds, throttle = false) {
      clearInterval(resendTimer);
      const deadline = Date.now() + Math.max(0, Math.min(3600, Number(seconds) || 0)) * 1000;
      if (throttle) throttleDeadline = deadline; else resendDeadline = deadline;
      updateControls();
      if (Math.max(resendDeadline, throttleDeadline) > Date.now()) resendTimer = setInterval(() => {
        updateControls();
        if (Date.now() >= Math.max(resendDeadline, throttleDeadline)) { clearInterval(resendTimer); resendTimer = null; }
      }, 1000);
    }
    window.addEventListener('pagehide', () => clearInterval(resendTimer), { once: true });

    async function request(url, body) {
      let response;
      try {
        response = await fetch(url, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000) });
      } catch (e) {
        throw new Error(e.name === 'TimeoutError' ? 'The sign-in request timed out. Check this server’s connection and try again.' : 'Could not reach BambuBoard. Check your connection and try again.');
      }
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('BambuBoard returned an unexpected response. Try again.'); }
      if (!response.ok || result.ok === false) {
        // An MFA challenge is an intermediate step, not an error.
        if (result.mfa && result.tfaKey) return result;
        throw Object.assign(new Error(result.error || 'Could not complete sign-in. Try again.'), result);
      }
      return result;
    }
    function showMethod(method) {
      for (const name of ['email', 'token']) {
        const selected = name === method;
        node('cloud-method-' + name).hidden = !selected;
        node('cloud-tab-' + name).className = 'btn ' + (selected ? 'btn-primary' : 'btn-ghost');
        node('cloud-tab-' + name).setAttribute('aria-pressed', String(selected));
      }
    }
    for (const method of ['email', 'token']) node('cloud-tab-' + method).addEventListener('click', () => { methodChosen = true; showMethod(method); });
    node('cloud-use-token').addEventListener('click', () => {
      methodChosen = true;
      showMethod('token');
      node('cloud-token-instructions').open = true;
      node('cloud-fallback').hidden = true;
      node('cloud-token').focus();
    });

    function maskToken() {
      node('cloud-token').type = tokenVisible ? 'text' : 'password';
      node('cloud-token-show').textContent = tokenVisible ? 'Hide token' : 'Show token';
      node('cloud-token-show').setAttribute('aria-pressed', String(tokenVisible));
    }
    async function refresh() {
      try {
        const [status, saved] = await Promise.all([request('/auth/status'), request('/auth/token')]);
        tokenSaved = !!saved.token;
        const rejected = status.needsSignIn || status.connection?.code === 'TOKEN_REJECTED';
        const pill = node('cloud-status-pill');
        pill.className = 'pill ' + (status.signedIn ? 'pill-ok' : rejected ? 'pill-warn' : '');
        pill.textContent = status.signedIn ? status.email ? 'Signed in as ' + status.email : 'Signed in' : rejected ? 'Sign in again' : 'Not signed in';
        node('cloud-status-note').textContent = status.connection?.ok === false ? status.connection.error : status.signedIn ? status.connection?.ok ? 'Connection checked successfully. Your cloud widgets can now use this account.' : 'Your sign-in is saved. Use Check connection to confirm Bambu still accepts it.' : 'Choose a sign-in method below. Your printer connection works without cloud sign-in.';
        node('cloud-actions').hidden = !tokenSaved;
        node('cloud-signout-link').hidden = !tokenSaved;
        node('cloud-token').value = saved.token || '';
        maskToken();
        node('cloud-token-hint').textContent = tokenSaved ? 'Saved token. You can replace it without signing out first.' : 'Paste the complete token cookie value.';
        node('cloud-token-email').value = saved.email || '';
        if (!node('cloud-email').value) node('cloud-email').value = saved.email || '';
        if (!methodChosen) { showMethod(tokenSaved ? 'token' : 'email'); methodChosen = true; }
        updateControls();
        window.dispatchEvent(new Event('bambuboard:cloud-updated'));
        return true;
      } catch (e) {
        node('cloud-status-pill').className = 'pill pill-warn';
        node('cloud-status-pill').textContent = 'Status unavailable';
        node('cloud-status-note').textContent = e.message;
        node('cloud-actions').hidden = false;
        node('cloud-signout-link').hidden = !tokenSaved;
        updateControls();
        return false;
      }
    }
    function resetEmailSteps() {
      requestedEmail = '';
      tfaKey = null;
      node('cloud-code-step').hidden = true;
      node('cloud-mfa').hidden = true;
      node('cloud-code').value = '';
      node('cloud-mfa-code').value = '';
      message('cloud-verify-status');
      message('cloud-mfa-status');
    }
    function showError(target, error) {
      if (error.code === 'MFA_EXPIRED') { resetEmailSteps(); cooldown(0); target = 'cloud-send-status'; }
      message(target, error.message, 'error');
      node('cloud-fallback').hidden = !error.tryManual;
      if (error.code === 'RATE_LIMITED') cooldown(error.retryAfter || 60, true);
      if (error.code === 'CODE_EXPIRED') cooldown(0);
    }
    async function run(name, target, pending, work) {
      if (busy || (Date.now() < throttleDeadline && name !== 'signout' && !(name === 'check' && !tokenSaved))) return;
      if (['send', 'verify', 'mfa', 'token'].includes(name)) {
        message('cloud-account-status');
        if (name !== 'token') message('cloud-token-status');
      }
      busy = true; action = name;
      section.setAttribute('aria-busy', 'true');
      node('cloud-fallback').hidden = true;
      updateControls();
      message(target, pending);
      try { await work(); }
      catch (e) { showError(target, e); }
      finally { busy = false; action = ''; section.setAttribute('aria-busy', 'false'); updateControls(); }
    }
    async function signedIn(target) {
      resetEmailSteps();
      cooldown(0);
      tokenVisible = false;
      const loaded = await refresh();
      message(target, loaded ? 'Signed in. Your cloud widgets can now use this account.' : 'Signed in, but the saved status could not be reloaded. Use Retry status.', loaded ? 'ok' : 'error');
      window.toast && window.toast('Signed in to Bambu Cloud');
    }

    node('cloud-email').addEventListener('input', () => {
      if (requestedEmail && node('cloud-email').value.trim() !== requestedEmail) {
        resetEmailSteps();
        message('cloud-send-status', 'Email changed. Request a code for this address.');
        updateControls();
      }
    });
    node('cloud-email-form').addEventListener('submit', async e => {
      e.preventDefault();
      if (busy || Date.now() < resendDeadline) return;
      const email = node('cloud-email').value.trim();
      await run('send', 'cloud-send-status', 'Asking Bambu to send a sign-in code…', async () => {
        const result = await request('/sendVerificationCode', { username: email });
        resetEmailSteps();
        requestedEmail = email;
        node('cloud-code-step').hidden = false;
        node('cloud-code-hint').textContent = 'Sent to ' + email + '. Enter the latest code from Bambu; check your spam folder if needed.';
        message('cloud-send-status', 'Code sent. Check your email.', 'ok');
        cooldown(result.retryAfter || 60);
      });
      if (!node('cloud-code-step').hidden) node('cloud-code').focus();
    });
    node('cloud-code-step').addEventListener('submit', async e => {
      e.preventDefault();
      if (!requestedEmail || busy) return;
      await run('verify', 'cloud-verify-status', 'Checking your email code…', async () => {
        const result = await request('/verify', { username: requestedEmail, code: node('cloud-code').value.trim() });
        if (result.mfa) {
          tfaKey = result.tfaKey;
          node('cloud-code-step').hidden = true;
          node('cloud-mfa').hidden = false;
          message('cloud-send-status', 'Email confirmed. Complete two-step verification below.', 'ok');
        } else await signedIn('cloud-send-status');
      });
      if (!node('cloud-mfa').hidden) node('cloud-mfa-code').focus();
    });
    node('cloud-mfa').addEventListener('submit', async e => {
      e.preventDefault();
      if (!tfaKey || busy) return;
      await run('mfa', 'cloud-mfa-status', 'Checking your authenticator code…', async () => {
        await request('/mfa', { username: requestedEmail, tfaKey, tfaCode: node('cloud-mfa-code').value.trim() });
        await signedIn('cloud-send-status');
      });
    });
    for (const id of ['cloud-code', 'cloud-mfa-code']) node(id).addEventListener('paste', e => {
      const code = (e.clipboardData?.getData('text') || '').replace(/[\s-]/g, '');
      if (/^\d{6}$/.test(code)) { e.preventDefault(); node(id).value = code; }
    });

    node('cloud-token-show').addEventListener('click', () => { tokenVisible = !tokenVisible; maskToken(); });
    node('cloud-token-clear').addEventListener('click', () => {
      node('cloud-token').value = '';
      tokenVisible = false; maskToken();
      message('cloud-token-status', 'Field cleared. Your saved sign-in stays active until you sign out.');
      node('cloud-token').focus();
    });
    node('cloud-token-copy').addEventListener('click', async () => {
      if (!node('cloud-token').value) return message('cloud-token-status', 'There is no token to copy.', 'error');
      try {
        await navigator.clipboard.writeText(node('cloud-token').value);
        message('cloud-token-status', 'Token copied.');
      } catch (_) { message('cloud-token-status', 'Clipboard access is unavailable here. Use Show token, select the value and copy it.', 'error'); }
    });
    node('cloud-method-token').addEventListener('submit', async e => {
      e.preventDefault();
      await run('token', 'cloud-token-status', 'Checking this token with Bambu Cloud…', async () => {
        await request('/auth/manual-token', { token: node('cloud-token').value.trim(), email: node('cloud-token-email').value.trim() });
        await signedIn('cloud-token-status');
      });
    });
    node('cloud-check').addEventListener('click', async () => {
      await run('check', 'cloud-account-status', 'Checking the saved sign-in with Bambu Cloud…', async () => {
        if (!tokenSaved) {
          if (await refresh()) message('cloud-account-status', 'Saved sign-in status loaded.', 'ok');
          return;
        }
        try {
          await request('/auth/check', {});
          message('cloud-account-status', 'Connection checked successfully.', 'ok');
        } finally { await refresh(); }
      });
    });
    node('cloud-signout-link').addEventListener('click', async () => {
      await run('signout', 'cloud-account-status', 'Signing out…', async () => {
        try { await request('/auth/signout', { disable: true }); }
        catch (e) { await refresh(); throw e; }
        tokenVisible = false;
        resetEmailSteps(); cooldown(0);
        message('cloud-send-status'); message('cloud-token-status');
        showMethod('email');
        message('cloud-account-status', 'Signed out. Your printer connection is still available.', 'ok');
        await refresh();
      });
    });
    refresh();
  }
})();
