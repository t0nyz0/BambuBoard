// BambuBoard — Fan widget with SVG ring gauges
// TZ | Redesigned 2025

const protocol = window.location.protocol;
const serverURL = window.location.hostname;
const serverPort = window.location.port;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

const consoleLogging = false;

// SVG circle circumference for r=32: 2 * PI * 32 = ~201.06
const CIRCUMFERENCE = 2 * Math.PI * 32;

// Fan data keys in telemetry, mapped to fan cell indices 0–3.
// Labels match ha-bambulab convention: big_fan1=Aux, big_fan2=Chamber.
const FAN_KEYS = ['big_fan1_speed', 'big_fan2_speed', 'cooling_fan_speed', 'heatbreak_fan_speed'];

// Convert raw speed (0–15) to percentage (0–100).
function pct(raw) {
  const v = parseInt(raw, 10);
  if (isNaN(v) || v < 0) return 0;
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
  const offset = CIRCUMFERENCE * (1 - p / 100);
  fan.fill.style.strokeDashoffset = offset;
  fan.fill.style.stroke = gaugeColor(p);

  // Percentage text.
  fan.pctEl.textContent = p > 0 ? p + '%' : 'OFF';
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

async function retrieveData() {
  const response = await fetch(fullServerURL + '/data.json');
  const data = await response.text();
  let obj = JSON.parse(data);

  if (obj.print && 'gcode_state' in obj.print) {
    return obj.print;
  } else if (obj.print) {
    return 'Incomplete';
  }
  return null;
}

function disableAll() {
  for (let i = 0; i < 4; i++) updateFan(i, 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setInterval(async () => {
  try {
    const telem = await retrieveData();
    if (telem && telem !== 'Incomplete') {
      FAN_KEYS.forEach((key, i) => updateFan(i, telem[key]));
    } else if (telem === null) {
      disableAll();
    }
  } catch (err) {
    if (consoleLogging) console.error(err);
    await sleep(1000);
  }
}, 1000);
