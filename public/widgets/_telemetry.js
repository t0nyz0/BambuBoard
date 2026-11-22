// Shared status for widgets that display current printer readings.
(function (root) {
  const activeStates = new Set(['RUNNING', 'PREPARE', 'SLICING', 'PAUSE', 'PAUSED']);
  const messages = {
    loading: 'Loading printer data…',
    offline: 'Printer offline',
    waiting: 'Waiting for printer data',
  };

  function number(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const reading = Number(value);
    return Number.isFinite(reading) ? reading : null;
  }

  function hasPrintState(print) {
    return typeof print.gcode_state === 'string' && print.gcode_state.trim() !== '';
  }

  function nozzleTemps(print, index) {
    const tools = print.device?.extruder?.info;
    const byId = Array.isArray(tools) ? tools.find(tool => number(tool?.id) === index) : undefined;
    const position = tools?.[index];
    const tool = byId ?? (position?.id == null ? position : undefined);
    const packed = tool?.temp;
    if (Number.isFinite(packed)) return { current: packed & 0xFFFF, target: (packed >> 16) & 0xFFFF };
    // Legacy reports only supply top-level temperatures. Once a dual-nozzle
    // report has arrived, never substitute the primary reading for its other tool.
    if (index !== 0 && Array.isArray(tools)) return null;
    const current = number(print.nozzle_temper);
    return current === null ? null : { current, target: number(print.nozzle_target_temper) };
  }

  function hasNozzleDetails(print) {
    return (typeof print.nozzle_type === 'string' && print.nozzle_type.trim() !== '') ||
      number(print.nozzle_diameter) !== null || number(print.spd_lvl) !== null;
  }

  function isStale(snapshot, now) {
    // Active jobs normally report continuously. Allow quiet printers a full
    // five-minute MQTT refresh interval plus a margin while they are idle.
    const maxAge = activeStates.has(snapshot?.print?.gcode_state) ? 60_000 : 330_000;
    const receivedAt = snapshot?._bb_received_at;
    return Number.isFinite(receivedAt) && now - receivedAt > maxAge;
  }

  function reading(snapshot, { connection, now = Date.now(), ready = hasPrintState } = {}) {
    if (connection === 'offline') return { state: 'offline' };
    const print = snapshot?.print;
    if (connection === 'waiting' || !print || typeof print !== 'object' || Array.isArray(print) || !ready(print)) {
      return { state: 'waiting' };
    }
    if (isStale(snapshot, now)) return { state: 'waiting' };
    return { state: 'live', print };
  }

  async function read(ready) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/data.json', { cache: 'no-cache', signal: controller.signal });
      if (!response.ok) return { state: 'waiting' };
      const connection = response.headers.get('X-BambuBoard-Printer-Connection');
      if (connection === 'offline' || connection === 'waiting') return { state: connection };
      const serverTime = Date.parse(response.headers.get('Date'));
      const snapshot = await response.json();
      return reading(snapshot, { connection, now: Number.isFinite(serverTime) ? serverTime : Date.now(), ready });
    } finally {
      clearTimeout(deadline);
    }
  }

  function poll(update, { ready, showStatus, onUnavailable } = {}) {
    let state;
    if (!showStatus) {
      const badge = document.createElement('div');
      badge.className = 'bb-telemetry-status';
      badge.setAttribute('role', 'status');
      document.body.append(badge);
      showStatus = message => {
        badge.textContent = message;
        badge.hidden = !message;
        document.documentElement.classList.toggle('bb-telemetry-unavailable', !!message);
      };
    }
    function setState(next) {
      if (state === next) return;
      state = next;
      if (next !== 'live') onUnavailable?.();
      showStatus(messages[next] || '');
    }
    async function refresh() {
      try {
        const result = await read(ready);
        if (result.state === 'live') await update(result.print);
        setState(result.state);
      } catch (_) {
        setState('waiting');
      } finally {
        setTimeout(refresh, 1000);
      }
    }
    setState('loading');
    refresh();
  }

  if (typeof module === 'object' && module.exports) module.exports = { reading, number, nozzleTemps };
  else root.BBTelemetry = { poll, isStale, number, hasPrintState, nozzleTemps, hasNozzleDetails };
})(globalThis);
