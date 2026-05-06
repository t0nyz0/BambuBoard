// In-app dashboard. Reads /data.json once per second, updates DOM gated by capabilities.

(async function init() {
  const status = await fetch('/api/status').then(r => r.json()).catch(() => null);
  if (!status) return;
  const caps = window.capsFor(status.printer.type);
  const tempUnit = (await fetch('/api/settings').then(r => r.json()).catch(() => ({}))).BambuBoard_tempSetting || 'Both';

  // Apply caps: hide tiles that don't apply to this type.
  byId('tile-chamber').classList.toggle('hidden', !caps.hasChamberTemp);
  byId('tile-nozzle2').classList.toggle('hidden', !caps.hasDualNozzle);
  byId('tile-ams2').classList.toggle('hidden', !caps.hasDualAMS);
  // Per ha-bambulab convention: extruder.info[0] = right nozzle, [1] = left.
  // We render nozzle1 = right, nozzle2 = left.
  byId('tile-nozzle1-label').textContent = caps.hasDualNozzle ? 'Right nozzle' : 'Nozzle';

  await initNote();
  setInterval(tick, 1000);
  tick();

  async function tick() {
    try {
      const r = await fetch('/data.json', { cache: 'no-store' });
      const data = await r.json();
      const print = data.print;
      if (!print) return setOffline();
      paintBanner(print);
      paintTemps(print, caps, tempUnit);
      paintFans(print);
      paintAms(print, caps);
      paintInfo(print, status);
      paintHms(print);
    } catch (e) { /* swallow */ }
  }

  function setOffline() {
    byId('banner-status').textContent = 'Offline';
  }

  function paintBanner(p) {
    const stage = stageString(p.stg_cur);
    const state = p.gcode_state || 'IDLE';
    const label = state === 'RUNNING'
      ? (stage || `Printing ${p.mc_percent || 0}%`)
      : state === 'FINISH' ? 'Print complete'
      : state === 'FAILED' ? 'Print failed'
      : state === 'PAUSE'  ? 'Paused'
      : state;
    byId('banner-status').textContent = label;
    const remain = p.mc_remaining_time;
    const meta = [];
    if (typeof remain === 'number' && remain > 0) meta.push(`Remaining: ${formatMin(remain)}`);
    if (p.layer_num != null && p.total_layer_num != null) meta.push(`Layer ${p.layer_num} of ${p.total_layer_num}`);
    if (p.subtask_name) meta.push(p.subtask_name);
    byId('banner-meta').textContent = meta.join(' · ');
    const bar = byId('banner-progress');
    bar.style.width = `${Math.max(0, Math.min(100, p.mc_percent || 0))}%`;
  }

  // Newer Bambu firmware (notably the H2D) packs current+target temperature into
  // a single int32: low 16 bits = current, high 16 bits = target. Older firmware
  // uses separate bed_temper / bed_target_temper / nozzle_temper / nozzle_target_temper
  // flat fields. unpack() returns whichever shape we got.
  function unpack(packed) {
    if (typeof packed !== 'number') return null;
    return { current: packed & 0xFFFF, target: (packed >> 16) & 0xFFFF };
  }

  function paintTemps(p, caps, unit) {
    const dev = p.device || {};

    // Bed: prefer packed; fall back to legacy.
    const bedPacked = unpack(dev.bed?.info?.temp);
    setTemp('bed',
      bedPacked ? bedPacked.current : p.bed_temper,
      bedPacked ? bedPacked.target : p.bed_target_temper,
      110, unit);

    // Chamber: prefer packed (H2D), fall back to legacy chamber_temper.
    if (caps.hasChamberTemp) {
      const chPacked = unpack(dev.ctc?.info?.temp);
      const chCur = chPacked ? chPacked.current : p.chamber_temper;
      setTemp('chamber', chCur, null, 60, unit);
    }

    // Nozzles: H2D has device.extruder.info[] with packed temps. Index 0 = right, 1 = left.
    // Single-nozzle printers use the legacy nozzle_temper / nozzle_target_temper fields.
    const ext = dev.extruder?.info;
    if (caps.hasDualNozzle && Array.isArray(ext) && ext.length >= 2) {
      const right = unpack(ext[0]?.temp) || { current: null, target: null };
      const left  = unpack(ext[1]?.temp) || { current: null, target: null };
      setTemp('nozzle1', right.current, right.target, 300, unit);
      setTemp('nozzle2', left.current,  left.target,  300, unit);
    } else if (Array.isArray(ext) && ext.length >= 1) {
      const n = unpack(ext[0]?.temp) || { current: p.nozzle_temper, target: p.nozzle_target_temper };
      setTemp('nozzle1', n.current ?? p.nozzle_temper, n.target ?? p.nozzle_target_temper, 300, unit);
    } else {
      setTemp('nozzle1', p.nozzle_temper, p.nozzle_target_temper, 300, unit);
    }
  }

  // Active nozzle is encoded in device.extruder.state's high nibble (>> 4 & 0xF).
  // Used by paintInfo to highlight which nozzle is currently selected.
  function activeNozzleIndex(p) {
    const s = p.device?.extruder?.state;
    return typeof s === 'number' ? (s >> 4) & 0xF : null;
  }

  function setTemp(key, cur, tgt, max, unit) {
    const c = byId(`${key}-current`);
    const t = byId(`${key}-target`);
    if (cur == null) { c.textContent = '—'; return; }
    c.textContent = formatTemp(cur, unit);
    if (t) t.textContent = (tgt && tgt > 0) ? `target ${formatTemp(tgt, unit)}` : 'idle';
    const bar = byId(`${key}-bar`);
    if (bar) bar.style.width = `${Math.min(100, (Number(cur) / max) * 100)}%`;
  }

  // ha-bambulab fan_percentage(): (raw / 15) * 100, rounded to nearest 10.
  // Field naming, also from ha-bambulab: big_fan1 = aux, big_fan2 = chamber.
  function fanPct(raw) {
    if (raw == null || raw === '') return 0;
    const pct = (Number(raw) / 15) * 100;
    return Math.round(pct / 10) * 10;
  }
  function paintFans(p) {
    const fans = [
      { label: 'Cooling',   val: p.cooling_fan_speed },
      { label: 'Heatbreak', val: p.heatbreak_fan_speed },
      { label: 'Aux',       val: p.big_fan1_speed },
      { label: 'Chamber',   val: p.big_fan2_speed },
    ];
    const host = byId('fans-row');
    host.innerHTML = '';
    fans.forEach(f => {
      const pct = fanPct(f.val);
      const div = document.createElement('div');
      div.className = 'fan' + (pct > 0 ? ' spinning' : '');
      div.innerHTML = `<div class="fan-icon material-symbols-outlined">mode_fan</div><div>${f.label}</div><div class="text-dim">${pct}%</div>`;
      host.appendChild(div);
    });
  }

  function paintAms(p, caps) {
    const amsList = p.ams && p.ams.ams ? p.ams.ams : [];
    paintAmsTrays('ams1-trays', amsList[0]);
    if (caps.hasDualAMS) paintAmsTrays('ams2-trays', amsList[1]);
  }

  function paintAmsTrays(hostId, amsUnit) {
    const host = byId(hostId);
    host.innerHTML = '';
    if (!amsUnit || !Array.isArray(amsUnit.tray)) {
      host.innerHTML = '<div class="text-dim">No AMS data.</div>';
      return;
    }
    amsUnit.tray.forEach((tray, i) => {
      const remain = tray.remain != null ? `${tray.remain}%` : '';
      const color = tray.tray_color ? `#${tray.tray_color.slice(0, 6)}` : '#444';
      const name = (tray.tray_sub_brands || tray.tray_type || 'Empty').toString();
      const row = document.createElement('div');
      row.className = 'ams-tray';
      row.innerHTML = `
        <div class="swatch" style="background:${color}"></div>
        <div class="tray-info">
          <div class="name">Slot ${i + 1} · ${name}</div>
          <div class="sub">${tray.tray_type || ''}</div>
        </div>
        <div class="tray-pct">${remain}</div>
      `;
      host.appendChild(row);
    });
  }

  function paintInfo(p, status) {
    const printInfo = byId('print-info');
    const activeIdx = activeNozzleIndex(p);
    const activeNozzle = activeIdx == null ? null : (activeIdx === 0 ? 'right' : activeIdx === 1 ? 'left' : `nozzle ${activeIdx}`);
    // Nozzle-type from device.nozzle.info[i].type
    const nozzleInfo = p.device?.nozzle?.info;
    const activeType = (Array.isArray(nozzleInfo) && activeIdx != null && nozzleInfo[activeIdx])
      ? nozzleInfo[activeIdx].type : (p.nozzle_type || null);
    const activeDiam = (Array.isArray(nozzleInfo) && activeIdx != null && nozzleInfo[activeIdx])
      ? nozzleInfo[activeIdx].diameter : (p.nozzle_diameter || null);
    const layerLine = p.total_layer_num
      ? `${p.layer_num || 0} / ${p.total_layer_num}` : '—';
    printInfo.innerHTML = `
      <div class="card-row"><span class="text-dim">Model</span><span>${esc(p.subtask_name || '—')}</span></div>
      <div class="card-row"><span class="text-dim">Layer</span><span>${layerLine}</span></div>
      <div class="card-row"><span class="text-dim">Speed</span><span>${speedLevel(p.spd_lvl)}</span></div>
      ${activeNozzle ? `<div class="card-row"><span class="text-dim">Active nozzle</span><span>${esc(activeNozzle)}</span></div>` : ''}
      <div class="card-row"><span class="text-dim">Nozzle</span><span>${esc(nozzleTypeName(activeType))} · ⌀${esc(activeDiam ?? '—')}mm</span></div>
      <div class="card-row"><span class="text-dim">Bed</span><span>${esc(p.bed_type || '—')}</span></div>
    `;
    const printer = status.printer;
    byId('printer-info').innerHTML = `
      <div class="card-row"><span class="text-dim">Name</span><span>${esc(printer.name)}</span></div>
      <div class="card-row"><span class="text-dim">Model</span><span>${esc(printer.type)}</span></div>
      <div class="card-row"><span class="text-dim">IP</span><span class="text-mono">${esc(printer.url)}</span></div>
      <div class="card-row"><span class="text-dim">Status</span><span>${esc(status.status?.connection || '?')}</span></div>
      <div class="card-row"><span class="text-dim">Last update</span><span class="text-dim">${esc(status.status?.lastUpdate || '—')}</span></div>
    `;
  }

  async function initNote() {
    const r = await fetch('/api/note').then(r => r.json()).catch(() => ({ text: '', manual: false }));
    byId('note-text').value = r.text || '';
    setNoteStatus(r);
    byId('note-save').addEventListener('click', async () => {
      const text = byId('note-text').value;
      await fetch('/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, manual: true }) });
      window.toast && window.toast('Saved');
      const cur = await fetch('/api/note').then(r => r.json()).catch(() => null);
      if (cur) setNoteStatus(cur);
    });
    byId('note-auto').addEventListener('click', async () => {
      await fetch('/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '', manual: false }) });
      const cur = await fetch('/api/note').then(r => r.json()).catch(() => null);
      if (cur) { byId('note-text').value = cur.text || ''; setNoteStatus(cur); }
    });
  }

  function setNoteStatus(n) {
    byId('note-status').textContent = n.manual ? 'Manual override' : 'Auto-updated each print';
  }

  // HMS (Health Management System) errors. Bambu's MQTT publishes an `hms[]`
  // array with `{attr, code}` entries when something's wrong (filament jam,
  // door open, AMS lost, etc.). ha-bambulab decodes these to the canonical
  // 4-part hex code `XXXX_XXXX_XXXX_XXXX` and links to the troubleshooting wiki.
  // We don't ship the full error-text dictionary here (it's huge and
  // localized), but the wiki link gives users a one-click path to the
  // explanation.
  function hmsCode(attr, code) {
    if (!attr || !code) return null;
    const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();
    return `${hex4(Math.floor(attr / 0x10000))}_${hex4(attr & 0xFFFF)}_${hex4(Math.floor(code / 0x10000))}_${hex4(code & 0xFFFF)}`;
  }
  function hmsSeverity(code) {
    // From ha-bambulab/pybambu/utils.py:get_HMS_severity. Severity is the high
    // nibble of the code's high word.
    const sev = (code >> 16) & 0xF;
    return ({1:'fatal',2:'serious',3:'common',4:'info'})[sev] || 'unknown';
  }
  let _lastHmsCount = -1;
  function paintHms(p) {
    const hms = Array.isArray(p.hms) ? p.hms : [];
    if (hms.length === _lastHmsCount && hms.length === 0) return;
    _lastHmsCount = hms.length;
    let host = byId('hms-strip');
    if (!host) {
      host = document.createElement('div');
      host.id = 'hms-strip';
      host.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--space-2);margin-bottom:var(--space-3)';
      const banner = document.querySelector('.print-banner');
      if (banner && banner.parentNode) banner.parentNode.insertBefore(host, banner.nextSibling);
    }
    host.innerHTML = '';
    if (!hms.length) return;
    hms.forEach(h => {
      const code = hmsCode(parseInt(h.attr,10), parseInt(h.code,10));
      if (!code) return;
      const sev = hmsSeverity(parseInt(h.code,10));
      const cls = sev === 'fatal' || sev === 'serious' ? 'pill-error'
                : sev === 'common' ? 'pill-warn' : 'pill-info';
      const wiki = `https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/${code}`;
      const a = document.createElement('a');
      a.href = wiki; a.target = '_blank'; a.className = `pill ${cls}`;
      a.title = `HMS ${sev} — click for details`;
      a.textContent = `HMS_${code} · ${sev}`;
      host.appendChild(a);
    });
  }

  // helpers
  function byId(id) { return document.getElementById(id); }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function formatTemp(c, unit) {
    if (unit === 'F') return `${(c * 9 / 5 + 32).toFixed(0)}°F`;
    if (unit === 'Both') return `${Number(c).toFixed(0)}°C / ${(c * 9 / 5 + 32).toFixed(0)}°F`;
    return `${Number(c).toFixed(0)}°C`;
  }
  function formatMin(m) {
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? `${h}h ${mm}m` : `${mm}m`;
  }
  function speedLevel(lvl) { return ({1:'Silent',2:'Standard',3:'Sport',4:'Ludicrous'}[lvl] || '—'); }
  // Decode Bambu nozzle type codes into human-readable names.
  // Format: XYmm where X=category, Y=S(standard)/H(high-flow), mm=material.
  // Sourced from ha-bambulab pybambu/models.py:_nozzle_type_name().
  const NOZZLE_MATERIALS = { '00': 'Stainless Steel', '01': 'Hardened Steel', '05': 'Tungsten Carbide' };
  function nozzleTypeName(code) {
    if (!code || code.length < 4) {
      // Legacy string values like "hardened_steel" or "stainless_steel"
      if (typeof code === 'string') {
        return code.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
      return code || '—';
    }
    const highFlow = code[1] === 'H';
    const material = NOZZLE_MATERIALS[code.substring(2, 4)] || code;
    return (highFlow ? 'High Flow ' : '') + material;
  }
  // Full Bambu cur_stage enum, mirrored from
  // ha-bambulab/custom_components/bambu_lab/pybambu/const.py:CURRENT_STAGE_IDS.
  // Keep the slug-to-display mapping here so the dashboard reads cleanly.
  const STAGE_STRINGS = {
    [-1]:'Idle', 255:'Idle',
    0:'Printing', 1:'Auto bed leveling', 2:'Heatbed preheating',
    3:'Vibration compensation', 4:'Changing filament', 5:'Paused (M400)',
    6:'Paused — filament runout', 7:'Heating hotend', 8:'Calibrating extrusion',
    9:'Scanning bed', 10:'Inspecting first layer', 11:'Identifying build plate',
    12:'Calibrating micro lidar', 13:'Homing toolhead', 14:'Cleaning nozzle',
    15:'Checking extruder temperature', 16:'Paused by user',
    17:'Paused — front cover falling', 18:'Calibrating micro lidar',
    19:'Calibrating extrusion flow', 20:'Paused — nozzle temp error',
    21:'Paused — heatbed temp error', 22:'Unloading filament',
    23:'Paused — skipped step', 24:'Loading filament', 25:'Calibrating motor noise',
    26:'Paused — AMS lost', 27:'Paused — low heatbreak fan speed',
    28:'Paused — chamber temp error', 29:'Cooling chamber',
    30:'Paused (G-code)', 31:'Motor noise showoff',
    32:'Paused — filament covered nozzle', 33:'Paused — cutter error',
    34:'Paused — first layer error', 35:'Paused — nozzle clog',
    36:'Pre-calibration accuracy check', 37:'Absolute accuracy calibration',
    38:'Post-calibration accuracy check', 39:'Calibrating nozzle offset',
    40:'Bed level (high temp)', 41:'Checking quick release',
    42:'Checking door and cover', 43:'Laser calibration',
    44:'Checking platform', 45:'Checking birdseye camera position',
    46:'Calibrating birdseye camera', 47:'Bed level (phase 1)',
    48:'Bed level (phase 2)', 49:'Heating chamber',
    50:'Heated bed cooling', 51:'Print calibration lines',
    52:'Checking material', 53:'Calibrating live view camera',
    54:'Waiting for heatbed temperature', 55:'Checking material position',
    56:'Calibrating cutter model offset', 57:'Measuring surface',
    58:'Thermal preconditioning', 59:'Homing blade holder',
    60:'Calibrating camera offset', 61:'Calibrating blade holder position',
    62:'Hotend pick-place test', 63:'Waiting for chamber temp to equalize',
    64:'Preparing hotend', 65:'Calibrating nozzle clumping detection',
    66:'Purifying chamber air', 67:'Measuring rotary attachment',
    68:'Moving toolhead over purge chute', 69:'Cooling nozzle',
    70:'Moving toolhead to bed center', 71:'Active arc fitting',
    72:'Hotend type detection', 73:'Build plate alignment detection',
    74:'Heatbed surface foreign-object scan',
    75:'Heatbed underside foreign-object scan',
    76:'Pre-extrusion check', 77:'Preparing AMS',
  };
  function stageString(s) {
    if (s == null) return '';
    return STAGE_STRINGS[s] || '';
  }
})();
