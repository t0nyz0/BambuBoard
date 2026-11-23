// BambuBoard — Fan widget with SVG ring gauges
// TZ | Redesigned 2025

// SVG circle circumference for r=32: 2 * PI * 32.
const CIRCUMFERENCE = 2 * Math.PI * 32;

// Fan data keys in telemetry, mapped to fan cell indices 0–3.
// Labels match ha-bambulab convention: big_fan1=Aux, big_fan2=Chamber.
const FAN_KEYS = ['big_fan1_speed', 'big_fan2_speed', 'cooling_fan_speed', 'heatbreak_fan_speed'];

// Convert raw speed (0–15) to percentage (0–100).
function pct(raw) {
  const v = BBTelemetry.number(raw);
  if (v === null || v < 0) return null;
  return Math.min(Math.round((v / 15) * 100), 100);
}

// Pick a gauge color based on percentage.
function gaugeColor(p) {
  if (p === 0) return 'rgba(255,255,255,0.12)';
  if (p <= 30) return '#51a34f';     // green
  if (p <= 60) return '#7ab648';     // green-yellow
  if (p <= 80) return '#e2a04a';     // amber
  return '#e55454';                  // red
}

// Map percentage to spin animation duration (seconds).
// 0% = no spin, 100% = fastest (0.35s).
function spinDuration(p) {
  if (p === 0) return 0;
  // Linear interpolation: 100% → 0.35s, 7% → 5s
  return Math.max(0.35, 5 - (p / 100) * 4.65);
}

// Cache DOM references for each fan cell.
const fanCells = [];
document.querySelectorAll('.fan-cell').forEach((cell) => {
  fanCells.push({
    fill: cell.querySelector('.gauge-fill'),
    icon: cell.querySelector('.fan-icon'),
    pctEl: cell.querySelector('.fan-pct'),
    _lastPct: -1,
  });
});

function updateFan(index, rawSpeed) {
  const fan = fanCells[index];
  if (!fan) return;

  const p = pct(rawSpeed);

  // Skip redundant updates.
  if (fan._lastPct === p) return;
  fan._lastPct = p;

  // Gauge ring.
  const offset = CIRCUMFERENCE * (1 - (p ?? 0) / 100);
  fan.fill.style.strokeDashoffset = offset;
  fan.fill.style.stroke = gaugeColor(p ?? 0);

  // Percentage text.
  fan.pctEl.textContent = p === null ? '—' : p > 0 ? p + '%' : 'OFF';
  fan.pctEl.classList.toggle('active', p > 0);

  // Spinning icon.
  if (p > 0) {
    const dur = spinDuration(p);
    fan.icon.style.animation = `fan-spin ${dur}s infinite linear`;
    fan.icon.classList.add('spinning');
  } else {
    fan.icon.style.animation = 'none';
    fan.icon.classList.remove('spinning');
  }
}

BBTelemetry.poll(print => FAN_KEYS.forEach((key, i) => updateFan(i, print[key])), {
  ready: print => FAN_KEYS.some(key => pct(print[key]) !== null),
});

async function updateFanPreferences() {
  try {
    const response = await fetch('/settings', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) return;
    const settings = await response.json();
    for (const fan of fanCells) {
      if (typeof settings.BambuBoard_displayFanPercentages === 'boolean') fan.pctEl.hidden = !settings.BambuBoard_displayFanPercentages;
      if (typeof settings.BambuBoard_displayFanIcons === 'boolean') fan.icon.hidden = !settings.BambuBoard_displayFanIcons;
    }
  } catch (_) { /* Keep the previous appearance if settings are temporarily unavailable. */ }
  finally { setTimeout(updateFanPreferences, 5000); }
}
updateFanPreferences();
