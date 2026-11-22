// Setup page — printer config + display prefs + cloud auth.

(async function init() {
  const types = await fetch('/api/printer-types').then(r => r.json()).catch(() => []);
  const cfg = await fetch('/api/settings').then(r => r.json()).catch(() => null);
  if (!cfg) { window.toast('Could not load settings. Reload to try again.', 'error'); return; }

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
  let accessCodeSet = !!cfg.printer?.accessCodeSet;
  try {
    const creds = await fetch('/api/printer-credentials').then(r => r.json());
    if (creds && creds.accessCode) {
      document.getElementById('p-ac').value = creds.accessCode;
      document.getElementById('p-ac-status').textContent = 'Saved — click Show to reveal, or edit to replace.';
      accessCodeSet = true;
    } else {
      document.getElementById('p-ac-status').textContent = accessCodeSet ? 'A code is saved.' : 'Required.';
    }
  } catch (_) {
    document.getElementById('p-ac-status').textContent = accessCodeSet ? 'A code is saved (could not load).' : 'Required.';
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

  const testButton = document.getElementById('test-btn');
  const testResult = document.getElementById('test-result');
  const saveButton = document.getElementById('save-btn');
  const connectSection = document.getElementById('connect-step');
  const connectTitle = document.getElementById('connect');
  const continueButton = document.getElementById('continue-btn');
  const nextHint = document.getElementById('connect-next');
  let savedCredentials = connectionKey(readPrinterFields());
  let configured = hasPrinterDetails(readPrinterFields());
  const isFirst = new URLSearchParams(location.search).get('firstRun') === '1' || !configured;
  let latestStatus = null, statusUnavailable = false, reconnectUntil = 0;
  let statusVersion = 0, statusTimer, checkingCamera = false;
  let testing = false, saving = false, testVersion = 0;

  if (isFirst) {
    document.body.classList.add('first-run');
    document.getElementById('setup-title').textContent = 'Set up your printer';
    document.getElementById('setup-intro').textContent = 'Find the printer IP address, serial number, and LAN access code in Bambu Studio under Device → Access Code.';
    saveButton.textContent = 'Save and connect';
  }

  document.getElementById('show-ac').addEventListener('click', event => {
    const i = document.getElementById('p-ac');
    i.type = i.type === 'password' ? 'text' : 'password';
    event.currentTarget.textContent = i.type === 'password' ? 'Show' : 'Hide';
    event.currentTarget.setAttribute('aria-pressed', String(i.type === 'text'));
  });

  for (const id of ['p-url', 'p-port', 'p-sn', 'p-ac']) {
    document.getElementById(id).addEventListener('input', () => {
      testVersion++;
      setTestResult('');
      updateContinue();
    });
  }

  testButton.addEventListener('click', async () => {
    const body = readPrinterFields();
    if (!hasPrinterDetails(body)) {
      setTestResult('Enter the printer IP address, serial number, and LAN access code.', 'error');
      return;
    }
    const attempt = ++testVersion;
    testing = true;
    updateButtons();
    setTestResult('Testing LAN connection…');
    try {
      const r = await fetch('/api/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (attempt !== testVersion) return;
      if (r.ok && j.ok) {
        setTestResult('Connection test passed. ' + (hasUnsavedCredentials() || !configured ?
          'Save to connect with these credentials.' : 'See the saved printer connection below.'), 'ok');
      } else {
        setTestResult(j.error || 'Connection test failed.', 'error');
      }
    } catch (_) {
      if (attempt === testVersion) setTestResult('Could not complete the test. Try again.', 'error');
    } finally {
      testing = false;
      updateButtons();
    }
  });

  saveButton.addEventListener('click', async () => {
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
    if (!hasPrinterDetails(body.printer)) {
      setTestResult('Enter the printer IP address, serial number, and LAN access code.', 'error');
      return;
    }
    const changedConnection = !configured || connectionKey(body.printer) !== savedCredentials;
    saving = true;
    setTestResult('');
    updateButtons();
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        window.toast('Save failed: ' + (j.error || r.status), 'error');
        return;
      }
      savedCredentials = connectionKey(body.printer);
      accessCodeSet = true;
      document.getElementById('p-ac-status').textContent = 'A code is saved.';
      configured = true;
      reconnectUntil = Date.now() + 5000;
      latestStatus = null;
      statusUnavailable = false;
      revealConnectSection();
      if (changedConnection) {
        const setupUrl = isFirst ? '/setup?firstRun=1#connect' : '/setup#connect';
        history.replaceState(history.state, '', setupUrl);
        connectTitle.focus();
      }
      window.toast('Settings saved');
      window.dispatchEvent(new Event('bambuboard:settings-saved'));
    } catch (e) {
      window.toast('Could not save settings: ' + e.message, 'error');
    } finally {
      saving = false;
      updateButtons();
    }
  });

  continueButton.addEventListener('click', () => {
    location.href = isFirst ? '/scene-editor?firstRun=1' : '/scene-editor';
  });
  if (configured) {
    revealConnectSection();
    if (location.hash === '#connect') connectTitle.focus();
  }

  function hasPrinterDetails(fields) {
    return !!(fields.url && fields.serialNumber && (fields.accessCode || accessCodeSet));
  }

  function connectionKey({ url, port, serialNumber, accessCode }) {
    return JSON.stringify([url, port, serialNumber, accessCode]);
  }

  function hasUnsavedCredentials() {
    return connectionKey(readPrinterFields()) !== savedCredentials;
  }

  function setTestResult(message, tone = '') {
    testResult.hidden = !message;
    testResult.className = 'test-result' + (tone ? ' ' + tone : '');
    testResult.textContent = message;
  }

  function updateButtons() {
    testButton.disabled = saveButton.disabled = testing || saving;
    updateContinue();
  }

  function updateContinue() {
    const dirty = hasUnsavedCredentials();
    const online = !!latestStatus?.connected;
    continueButton.disabled = !configured || saving || dirty || !online;
    const hint = saving ? 'Saving printer settings…'
      : dirty ? 'Save your credential changes to connect with them.'
      : statusUnavailable ? 'Printer status is unavailable. Retrying…'
      : online ? (latestStatus.printer?.detectedFrom === 'mqtt'
        ? 'The printer is connected. Continue to choose a layout.'
        : 'The printer is connected. Model detection is still in progress. You can continue to Layout.')
      : Date.now() < reconnectUntil ? 'BambuBoard is connecting with the saved credentials.'
      : latestStatus ? 'Check that the printer is on and the saved credentials are correct.'
      : 'Checking the saved printer connection.';
    if (nextHint.textContent !== hint) nextHint.textContent = hint;
  }

  function revealConnectSection() {
    connectSection.hidden = false;
    updateConnectionStatus();
    clearTimeout(statusTimer);
    pollStatus(++statusVersion);
  }

  async function pollStatus(version) {
    try {
      const r = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error('Status unavailable');
      const s = await r.json();
      if (version !== statusVersion) return;
      latestStatus = s;
      statusUnavailable = false;
      if (s.connected) reconnectUntil = 0;
    } catch (_) {
      if (version !== statusVersion) return;
      latestStatus = null;
      statusUnavailable = true;
    }
    updateConnectionStatus();
    updateCameraStatus();
    statusTimer = setTimeout(() => pollStatus(version), 1500);
  }

  async function updateCameraStatus() {
    if (checkingCamera) return;
    checkingCamera = true;
    try {
      const response = await fetch('/api/printer/video/status', { signal: AbortSignal.timeout(4000) });
      const video = response.ok ? await response.json() : null;
      document.getElementById('connect-camera').textContent = video?.available ? `${video.cameraType === 'rtsp' ? 'RTSP' : 'Chamber image'} available` : 'Unavailable';
      document.getElementById('connect-camera-hint').textContent = video?.available ? '' : (video?.hint || 'Camera availability does not affect the printer connection.');
    } catch (_) {
      document.getElementById('connect-camera').textContent = 'Status unavailable';
      document.getElementById('connect-camera-hint').textContent = '';
    } finally {
      checkingCamera = false;
    }
  }

  function updateConnectionStatus() {
    const pill = document.getElementById('connect-mqtt');
    const online = !!latestStatus?.connected;
    pill.className = 'pill ' + (online ? 'pill-ok' : 'pill-warn');
    pill.textContent = statusUnavailable ? 'Status unavailable'
      : online ? 'Connected'
      : Date.now() < reconnectUntil ? 'Connecting…'
      : !latestStatus ? 'Checking…'
      : 'Disconnected';
    const printer = latestStatus?.printer;
    document.getElementById('connect-detected').textContent = printer?.detectedFrom === 'mqtt'
      ? (printer.model || printer.type || 'Detected')
      : printer?.model ? `${printer.model} (saved)`
      : online ? 'Detecting…' : '—';
    document.getElementById('connect-last').textContent = latestStatus?.status?.lastUpdate || 'No telemetry yet';
    updateContinue();
  }

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
    const forms = { email: 'cloud-email-form', code: 'cloud-code-step', mfa: 'cloud-mfa', token: 'cloud-method-token' };
    const inputs = { account: 'cloud-check', email: 'cloud-email', code: 'cloud-code', mfa: 'cloud-mfa-code', token: 'cloud-token' };
    let step = 'account', returnStep = 'account', tokenSaved = false, signedInAccount = false, emailCodeExpired = false;
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
      for (const id of ['cloud-mfa-submit', 'cloud-token-save']) node(id).disabled = busy || wait > 0;
      node('cloud-verify').disabled = busy || wait > 0 || emailCodeExpired;
      node('cloud-check').disabled = busy || (tokenSaved && wait > 0);
      node('cloud-send-code').disabled = busy || seconds > 0;
      node('cloud-resend-code').disabled = busy || seconds > 0;
      node('cloud-send-code').textContent = action === 'send' ? 'Sending code…' : seconds ? 'Send in ' + seconds + 's' : 'Send sign-in code';
      node('cloud-resend-code').textContent = action === 'send' ? 'Sending code…' : seconds ? 'Resend in ' + seconds + 's' : 'Resend code';
      node('cloud-verify').textContent = action === 'verify' ? 'Verifying…' : wait ? 'Retry in ' + wait + 's' : 'Verify email code';
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
    function showStep(next) {
      step = next;
      for (const [name, form] of Object.entries(forms)) node(form).hidden = step !== name;
      node('cloud-change-account').hidden = step !== 'account' || !signedInAccount;
      node('cloud-back-account').hidden = !signedInAccount || step === 'account' || step === 'token';
      node('cloud-troubleshooting').hidden = step === 'token';
      node('cloud-fallback').hidden = true;
      return inputs[step];
    }
    async function refresh(resetStep = false) {
      try {
        const status = await request('/auth/status');
        const recovered = status.signedIn && !signedInAccount;
        tokenSaved = status.tokenSaved;
        signedInAccount = status.signedIn;
        const rejected = status.needsSignIn || status.connection?.code === 'TOKEN_REJECTED';
        const pill = node('cloud-status-pill');
        pill.className = 'pill ' + (status.signedIn ? 'pill-ok' : rejected ? 'pill-warn' : '');
        pill.textContent = status.signedIn ? status.email ? 'Signed in as ' + status.email : 'Signed in' : rejected ? 'Sign in again' : 'Not signed in';
        node('cloud-status-note').textContent = status.connection?.ok === false ? status.connection.error : '';
        node('cloud-actions').hidden = !tokenSaved;
        node('cloud-signout-link').hidden = !tokenSaved;
        if (status.email && (resetStep || step === 'account' || !node('cloud-email').value)) node('cloud-email').value = status.email;
        if (resetStep || (step === 'account' && !signedInAccount) || (step === 'email' && recovered)) {
          showStep(signedInAccount ? 'account' : 'email');
        }
        updateControls();
        window.dispatchEvent(new Event('bambuboard:cloud-updated'));
        return true;
      } catch (e) {
        node('cloud-status-pill').className = 'pill pill-warn';
        node('cloud-status-pill').textContent = 'Status unavailable';
        node('cloud-status-note').textContent = e.message;
        node('cloud-actions').hidden = false;
        node('cloud-signout-link').hidden = !tokenSaved;
        if (resetStep) showStep(signedInAccount ? 'account' : 'email');
        updateControls();
        return false;
      }
    }
    function resetEmailSteps() {
      requestedEmail = '';
      tfaKey = null;
      emailCodeExpired = false;
      node('cloud-code').value = '';
      node('cloud-mfa-code').value = '';
      message('cloud-send-status');
      message('cloud-verify-status');
      message('cloud-mfa-status');
    }
    function showError(target, error) {
      let focus = target === 'cloud-account-status' ? 'cloud-check' : inputs[step];
      if (error.code === 'MFA_EXPIRED') {
        resetEmailSteps();
        cooldown(0);
        showStep('email');
        target = 'cloud-send-status';
        focus = 'cloud-send-code';
      }
      if (error.code === 'CODE_EXPIRED') {
        emailCodeExpired = true;
        node('cloud-code').value = '';
        cooldown(0);
        focus = 'cloud-resend-code';
      }
      if (error.code === 'TOKEN_REJECTED' && action === 'check' && step === 'email') focus = 'cloud-email';
      const hint = error.tryManual && step !== 'token';
      message(target, hint && error.code === 'SECURITY_TOKEN' ? 'Bambu couldn’t verify this sign-in. Try again in a moment.' : error.message, 'error');
      node('cloud-fallback').hidden = !hint;
      if (error.code === 'RATE_LIMITED') cooldown(error.retryAfter || 60, true);
      return focus;
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
      let focus;
      try { focus = await work(); }
      catch (e) { focus = showError(target, e); }
      finally { busy = false; action = ''; section.setAttribute('aria-busy', 'false'); updateControls(); }
      if (focus) node(focus).focus();
    }
    async function signedIn() {
      resetEmailSteps();
      cooldown(0);
      clearImportedToken();
      signedInAccount = tokenSaved = true;
      const loaded = await refresh(true);
      message('cloud-account-status', loaded ? 'Signed in. Your cloud widgets can now use this account.' : 'Signed in. Use Check connection to reload your account status.', loaded ? 'ok' : 'error');
      window.toast && window.toast('Signed in to Bambu Cloud');
      return 'cloud-check';
    }

    async function sendCode(email, target) {
      if (busy || Date.now() < resendDeadline) return;
      await run('send', target, 'Asking Bambu to send a sign-in code…', async () => {
        const result = await request('/sendVerificationCode', { username: email });
        resetEmailSteps();
        requestedEmail = email;
        node('cloud-code-hint').textContent = 'Code sent to ' + email + '. Check your spam folder if it hasn’t arrived.';
        cooldown(result.retryAfter || 60);
        return showStep('code');
      });
    }
    function changeEmail() {
      resetEmailSteps();
      node(showStep('email')).focus();
    }
    node('cloud-email-form').addEventListener('submit', e => {
      e.preventDefault();
      if (step === 'email') sendCode(node('cloud-email').value.trim(), 'cloud-send-status');
    });
    node('cloud-resend-code').addEventListener('click', () => sendCode(requestedEmail, 'cloud-verify-status'));
    for (const id of ['cloud-change-email', 'cloud-mfa-change-email', 'cloud-change-account']) node(id).addEventListener('click', changeEmail);
    node('cloud-back-account').addEventListener('click', () => {
      resetEmailSteps();
      showStep('account');
      node('cloud-change-account').focus();
    });
    node('cloud-code-step').addEventListener('submit', async e => {
      e.preventDefault();
      if (step !== 'code' || !requestedEmail || emailCodeExpired) return;
      await run('verify', 'cloud-verify-status', 'Checking your email code…', async () => {
        const result = await request('/verify', { username: requestedEmail, code: node('cloud-code').value.trim() });
        if (result.mfa) {
          tfaKey = result.tfaKey;
          node('cloud-code').value = '';
          return showStep('mfa');
        }
        return signedIn();
      });
    });
    node('cloud-mfa').addEventListener('submit', async e => {
      e.preventDefault();
      if (step !== 'mfa' || !tfaKey) return;
      await run('mfa', 'cloud-mfa-status', 'Checking your authenticator code…', async () => {
        await request('/mfa', { username: requestedEmail, tfaKey, tfaCode: node('cloud-mfa-code').value.trim() });
        return signedIn();
      });
    });
    for (const id of ['cloud-code', 'cloud-mfa-code']) node(id).addEventListener('paste', e => {
      const code = (e.clipboardData?.getData('text') || '').replace(/[\s-]/g, '');
      if (/^\d{6}$/.test(code)) { e.preventDefault(); node(id).value = code; }
    });

    function clearImportedToken() {
      node('cloud-token').value = '';
      node('cloud-token-email').value = '';
      node('cloud-token-instructions').open = false;
      node('cloud-troubleshooting').open = false;
      message('cloud-token-status');
    }
    for (const id of ['cloud-import-token', 'cloud-use-token']) node(id).addEventListener('click', () => {
      returnStep = step;
      clearImportedToken();
      node('cloud-token-instructions').open = true;
      node(showStep('token')).focus();
    });
    node('cloud-token-cancel').addEventListener('click', () => {
      clearImportedToken();
      node(showStep(returnStep === 'account' && !signedInAccount ? 'email' : returnStep)).focus();
    });
    node('cloud-method-token').addEventListener('submit', async e => {
      e.preventDefault();
      if (step !== 'token') return;
      await run('token', 'cloud-token-status', 'Checking this token with Bambu Cloud…', async () => {
        await request('/auth/manual-token', { token: node('cloud-token').value.trim(), email: node('cloud-token-email').value.trim() });
        return signedIn();
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
        resetEmailSteps(); cooldown(0);
        clearImportedToken();
        message('cloud-account-status', 'Signed out. Your printer connection is still available.', 'ok');
        await refresh(true);
        return 'cloud-email';
      });
    });
    refresh(true);
  }
})();
