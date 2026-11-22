// BambuBoard — AMS Tray widget
// Explicit ?ams=N selects an array position. Otherwise prefer the integrated
// AMS 3H, or index 1 for compatibility with dual-AMS layouts, or the sole unit.

const amsParams = new URLSearchParams(location.search);
const AMS_INDEX = parseInt(amsParams.get('ams') || '1', 10);
const ams3hView = document.querySelector('.ams-3h');
const amsCard = ams3hView.parentElement;
const amsUnavailable = document.getElementById('ams-unavailable');
const amsTitle = document.querySelector('.partTitle');
const originalTitle = amsTitle.textContent;
const ams3hRows = [];

const protocol = window.location.protocol;
const serverURL = window.location.hostname;
const serverPort = window.location.port;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

let currentState = 'OFF';
let settings = {};

async function loadSettings() {
  try {
    const response = await fetch(fullServerURL + '/settings');
    if (response.ok) settings = await response.json();
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

loadSettings();
// Re-fetch every 5s so changes made on the /setup page (e.g. temperature
// unit, fan-percent toggle) propagate without reloading the iframe.
setInterval(loadSettings, 5000);

// Update a single tray's UI elements.
function updateTray(trayIdx, tray) {
  const n = trayIdx + 1; // 1-based for element IDs
  const color = tray.tray_color || '';
  const material = tray.tray_sub_brands || '';
  const filType = tray.tray_type || '';
  const uid = tray.tag_uid || '';
  const remain = tray.remain;

  // Detect empty tray: no filament type and no color means nothing is loaded.
  const isEmpty = !filType && !color;

  // Tag the parent .element so CSS can hide the progress bar on empty rows
  // (no phantom horizontal line under "Empty").
  const $element = $(`#tray${n}Color`).closest('.element');

  if (isEmpty) {
    $element.addClass('tray-empty');
    $(`#tray${n}Color`).css('background-color', 'rgba(100,100,100,0.3)');
    $(`#tray${n}Material`).text('Empty').css('opacity', '0.4');
    $(`#tray${n}Type`).text('');
    $(`#tray${n}Remaining`).text('');
    $(`#tray${n}ProgressBar`).width(0).css('background-color', 'transparent');
    return;
  }

  // Loaded tray — show filament info.
  $element.removeClass('tray-empty');
  $(`#tray${n}Material`).css('opacity', '1');

  // Color swatch
  if (color) {
    $(`#tray${n}Color`).css('background-color', '#' + color);
  }

  // Material name
  $(`#tray${n}Material`).text(material || filType || 'Unknown');

  // Type label (brand + filament type)
  // uid empty = manual/external, uid all-zeros = generic/3rd-party, uid valid = Bambu RFID
  let typeLabel = '';
  if (!uid || uid === '0000000000000000') {
    typeLabel = filType;
  } else {
    typeLabel = 'Bambu • ' + filType;
  }
  $(`#tray${n}Type`).text(typeLabel);

  // Remaining percentage
  const parentWidth = $(`#tray${n}ProgressBarParent`).width();
  if (remain == null || remain < 0) {
    // Unknown remaining (RFID tag present but no data, or non-Bambu filament)
    $(`#tray${n}Remaining`).text('');
    $(`#tray${n}ProgressBar`).width(0).css('background-color', 'grey');
  } else if (remain <= 2) {
    $(`#tray${n}Remaining`).text('LOW');
    $(`#tray${n}ProgressBar`).width((remain * parentWidth) / 100).css('background-color', 'red');
  } else {
    $(`#tray${n}Remaining`).text(remain + '%');
    const barWidth = (Math.max(0, remain) * parentWidth) / 100;
    $(`#tray${n}ProgressBar`).width(barWidth);

    if (remain >= 20) {
      $(`#tray${n}ProgressBar`).css('background-color', '#51a34f');
    } else if (remain > 10) {
      $(`#tray${n}ProgressBar`).css('background-color', 'yellow');
    } else {
      $(`#tray${n}ProgressBar`).css('background-color', 'red');
    }
  }

  if (currentState !== 'RUNNING') {
    // Off state: only the progress bar (filament-remaining) goes grey to
    // signal inactivity. The color swatch always reflects the loaded
    // filament's actual color — there is no "disabled" state for it. The
    // drying pill (rendered separately in updateAMS) stays colorful too.
    $(`#tray${n}ProgressBar`).css('background-color', 'grey');
  }
}

function zoneTemperature(value) {
  const celsius = BBAms.number(value);
  if (celsius == null || celsius < 0 || celsius > 100) return '—';
  const c = `${Math.round(celsius * 10) / 10}°C`;
  const f = `${Math.round((celsius * 9 / 5 + 32) * 10) / 10}°F`;
  if (settings.BambuBoard_tempSetting === 'Fahrenheit') return f;
  if (settings.BambuBoard_tempSetting === 'Celsius') return c;
  return `${c} / ${f}`;
}

function updateAms3h(print, unit) {
  const trayList = ams3hView.querySelector('.ams-3h-trays');
  const template = document.getElementById('ams-3h-tray-template');
  if (!ams3hRows.length) {
    for (let slot = 0; slot < 9; slot++) {
      const row = template.content.firstElementChild.cloneNode(true);
      row.querySelector('.ams-3h-slot-number').textContent = `#${slot + 1}`;
      trayList.append(row);
      ams3hRows.push(row);
    }
  }

  const active = BBAms.activeTray(print);
  const target = BBAms.targetTray(print);
  ams3hRows.forEach((row, slot) => {
    const tray = BBAms.trayAt(print, unit, slot);
    const carriesFilament = active.amsIndex === BBAms.AMS_3H_ID && active.trayIndex === slot;
    const isActive = Boolean(tray) && carriesFilament;
    const isTarget = !carriesFilament && target.amsIndex === BBAms.AMS_3H_ID && target.trayIndex === slot;
    row.classList.toggle('is-empty', !tray);
    row.classList.toggle('is-active', isActive);
    row.classList.toggle('is-target', isTarget);
    row.querySelector('.ams-3h-tray-state').textContent = isActive ? 'Active' : (isTarget ? 'Next' : '');
    const color = tray?.tray_color || '';
    row.querySelector('.ams-3h-dot').style.backgroundColor = /^[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(color) ? '#' + color : '';
    const material = row.querySelector('.ams-3h-material');
    material.textContent = tray ? (tray.tray_sub_brands || tray.tray_type || 'Unknown filament') : 'Empty';
    material.title = material.textContent;
    const remain = BBAms.number(tray?.remain);
    row.querySelector('.ams-3h-remaining').textContent = remain != null && remain >= 0 && remain <= 100 ? `${remain}%` : '';
  });

  const zones = Array.isArray(unit?.zone_info) ? unit.zone_info : [];
  ams3hView.querySelectorAll('.ams-3h-zone').forEach((card, id) => {
    const zone = zones.find(zone => BBAms.number(zone?.zone_id) === id);
    const humidity = BBAms.number(zone?.humidity_raw);
    const humidityLabel = humidity != null && humidity >= 0 && humidity <= 100 ? `${humidity}% RH` : '— RH';
    card.querySelector('.ams-3h-zone-reading').textContent = `${zoneTemperature(zone?.temp)} · ${humidityLabel}`;
    const slots = Array.isArray(zone?.zone_slots) ? zone.zone_slots.map(BBAms.number)
      .filter(slot => Number.isInteger(slot) && slot >= 0 && slot < 9).map(slot => slot + 1) : [];
    card.querySelector('.ams-3h-zone-slots').textContent = slots.length ? `Trays ${slots.join(', ')}` : '';
    // Zone 0 is the dryer. Zone 1 reports a duplicate timer that can lag.
    const timer = card.querySelector('.ams-3h-zone-time');
    if (timer) {
      const drying = Number.isInteger(zone?.dry_time) && zone.dry_time > 0;
      card.classList.toggle('is-drying', drying);
      timer.hidden = !drying;
      timer.textContent = drying ? `Drying · ${formatDryMinutes(zone.dry_time)}` : '';
    }
  });
}

async function updateAMS(telemetryObject) {
  try {
    const units = telemetryObject.ams?.ams;
    const integrated = BBAms.ams3hUnit(telemetryObject);
    const explicit = amsParams.has('ams');
    const selectedIndex = explicit || units?.[1] ? AMS_INDEX : 0;
    const amsUnit = (!explicit && integrated) || units?.[selectedIndex];
    const isAms3h = Boolean(amsUnit && amsUnit === integrated);
    const missing = !isAms3h && !Array.isArray(amsUnit?.tray);
    ams3hView.hidden = !isAms3h;
    amsCard.classList.toggle('ams-card-3h', isAms3h);
    amsCard.classList.toggle('ams-card-missing', missing);
    amsUnavailable.hidden = !missing;
    if (missing) {
      const message = explicit ? 'Selected AMS unit unavailable' : 'No AMS unit reported';
      if (amsUnavailable.textContent !== message) amsUnavailable.textContent = message;
    }
    if (!amsParams.has('title')) amsTitle.textContent = isAms3h ? 'AMS 3H' : (missing ? 'AMS' : originalTitle);
    if (isAms3h) {
      updateAms3h(telemetryObject, amsUnit);
      return;
    }
    if (missing) return;

    // Update all 4 trays.
    for (let i = 0; i < 4; i++) {
      updateTray(i, amsUnit.tray[i] || {});
    }

    // Drying pill — only AMS 2 Pro / AMS HT report dry_time > 0.
    updateDryingStatus(amsUnit);

    // Humidity raw percentage (the 1–5 humidity index controls the bars,
    // humidity_raw is the actual % value shown next to the "Humidity" label).
    const humPct = amsUnit.humidity_raw != null ? parseInt(amsUnit.humidity_raw, 10) : NaN;
    $('#humidityPercent').text(!isNaN(humPct) ? `(${humPct}%)` : '');

    // AMS Humidity
    const amsHumidity = String(amsUnit.humidity ?? '');

    $('#humidity1, #humidity2, #humidity3, #humidity4, #humidity5').css('background', 'gray');
    $('#humidityLevelText').text('—');

    if (amsHumidity === '5') {
      $('#humidity1').css('background', '#51a34f');
      $('#humidityLevelText').text('Low');
    } else if (amsHumidity === '4') {
      $('#humidity1, #humidity2').css('background', '#51a34f');
      $('#humidityLevelText').text('Low');
    } else if (amsHumidity === '3') {
      $('#humidity1, #humidity2, #humidity3').css('background', 'yellow');
      $('#humidityLevelText').text('Ok');
    } else if (amsHumidity === '2') {
      $('#humidity1, #humidity2, #humidity3, #humidity4').css('background', 'red');
      $('#humidityLevelText').text('High');
    } else if (amsHumidity === '1') {
      $('#humidity1, #humidity2, #humidity3, #humidity4, #humidity5').css('background', 'red');
      $('#humidityLevelText').text('High');
    }

    // AMS Temperature
    const amsTemp = BBTelemetry.number(amsUnit.temp);
    const amsTempPercentage = amsTemp === null ? 0 : Math.min((amsTemp / 82) * 100, 100);

    $('#amsTargetTempC').text('82');
    $('#amsTargetTempF').text(180);

    const amsCurrentTempF = amsTemp === null ? '—' : parseFloat(((amsTemp * 9) / 5 + 32).toFixed(1));
    $('#amsCurrentTempF').text(amsCurrentTempF);
    $('#amsCurrentTempC').text(amsTemp ?? '—');

    const progressWidth = $('#amsProgressBarParent').width();
    $('#amsProgressBar').width((amsTempPercentage * progressWidth) / 100);

    const ts = settings.BambuBoard_tempSetting;
    if (ts === 'Fahrenheit') {
      $('#amsTargetTempSymbolsF, #amsCurrentTempSymbolsF, #amsTargetTempF, #amsCurrentTempF').show();
      $('#amsCurrentTempC, #amsTargetTempSymbolsC, #amsCurrentTempSymbolsC, #amsTargetTempC').hide();
    } else if (ts === 'Celsius') {
      $('#amsTargetTempSymbolsF, #amsCurrentTempSymbolsF, #amsTargetTempF, #amsCurrentTempF').hide();
      $('#amsCurrentTempC, #amsTargetTempSymbolsC, #amsCurrentTempSymbolsC, #amsTargetTempC').show();
    } else {
      $('#amsTargetTempSymbolsF, #amsCurrentTempSymbolsF, #amsTargetTempF, #amsCurrentTempF').show();
      $('#amsCurrentTempC, #amsTargetTempSymbolsC, #amsCurrentTempSymbolsC, #amsTargetTempC').show();
    }

    if (amsTempPercentage > 90) {
      $('#amsProgressBar').css('background-color', 'red');
    } else if (amsTempPercentage > 70) {
      $('#amsProgressBar').css('background-color', 'yellow');
    } else {
      $('#amsProgressBar').css('background-color', '#51a34f');
    }

    // Off state: AMS temp + humidity bars read as inactive, but we still
    // convey the humidity level via two shades of grey so the gauge stays
    // useful at a glance. Drying pill (rendered separately) keeps its color.
    // Exception: when the AMS is actively drying (dry_time > 0), the
    // temp progress bar stays in its colored state — the unit is heating
    // and the heating value is the relevant piece of data even with the
    // printer idle.
    const isDrying = (parseInt(amsUnit.dry_time, 10) || 0) > 0;
    if (currentState !== 'RUNNING' && !isDrying) {
      $('#amsProgressBar').css('background-color', 'grey');
    }
    if (currentState !== 'RUNNING') {
      $('#humidity1, #humidity2, #humidity3, #humidity4, #humidity5').css('background', '#3a3a3a');
      // Bambu's humidity index is inverted: 5 = driest (1 bar), 1 = wettest (5 bars).
      const idx = parseInt(amsHumidity, 10);
      const lit = (idx >= 1 && idx <= 5) ? (6 - idx) : 0;
      for (let i = 1; i <= lit; i++) {
        $('#humidity' + i).css('background', '#9a9a9a');
      }
    }

    // AMS active tray — dual/quad-AMS aware.
    const THIS_AMS_INDEX = BBAms.unitId(amsUnit) ?? selectedIndex;
    const active = window.getActiveAmsTray
      ? window.getActiveAmsTray({ print: telemetryObject })
      : { amsIndex: 255, trayIndex: 255 };

    $('#tray1Active, #tray2Active, #tray3Active, #tray4Active').hide();
    // Reset the container highlight on all trays before applying it to
    // whichever one is active right now.
    $('.ams-container .element').removeClass('tray-active');
    const activeColor = currentState === 'RUNNING' ? '#51a34f' : 'grey';
    $('#tray1Active, #tray2Active, #tray3Active, #tray4Active').css('background-color', activeColor);

    if (active.amsIndex === THIS_AMS_INDEX) {
      // Show the small "active" pill AND highlight the whole tray container
      // green so the active state is obvious at a glance — the tiny pill
      // alone is hard to spot in tight layouts.
      const slotMap = { 0: 1, 1: 2, 2: 3, 3: 4 };
      const slot = slotMap[active.trayIndex];
      if (slot) {
        $(`#tray${slot}Active`).show();
        $(`#tray${slot}Color`).closest('.element').addClass('tray-active');
      }
    }

    // Filament change target indicator.
    $('#tray1Target, #tray2Target, #tray3Target, #tray4Target').hide();
    if (integrated) {
      const target = BBAms.targetTray(telemetryObject);
      if (target.amsIndex === THIS_AMS_INDEX && target.trayIndex < 4
          && (target.amsIndex !== active.amsIndex || target.trayIndex !== active.trayIndex)) {
        $(`#tray${target.trayIndex + 1}Target`).show();
      }
      return;
    }
    try {
      const trayTar = parseInt(telemetryObject.ams.tray_tar, 10);
      const trayNow = parseInt(telemetryObject.ams.tray_now, 10);
      const isChanging = !isNaN(trayTar) && trayTar !== 255 && trayTar !== trayNow;
      if (isChanging) {
        const tarAmsUnit = trayTar >= 128 ? (trayTar - 128) : (trayTar >> 2);
        const tarTraySlot = trayTar >= 128 ? 0 : (trayTar & 0x3);
        if (tarAmsUnit === selectedIndex) {
          $(`#tray${tarTraySlot + 1}Target`).show();
        }
      }
    } catch (_) {}
  } catch (error) {
    console.error('Error:', error);
  }
}

// Drying pill state. ha-bambulab confirms only heating-capable AMSes
// (AMS 2 Pro / AMS HT) ever publish dry_time > 0 — older models always
// report 0, so a model check isn't needed. Format is kept compact
// ("Drying 55° · 11h 43m") because the AMS card is narrow (~198px).
function updateDryingStatus(amsUnit) {
  const dryTime = parseInt(amsUnit.dry_time, 10) || 0;
  const dryTemp = parseInt((amsUnit.dry_setting || {}).dry_temperature, 10);
  const $pill = $('#dryingStatusPill');
  const $row = $pill.closest('.ams-drying-row');
  if (dryTime > 0) {
    const parts = [];
    if (dryTemp > 0) parts.push(`${dryTemp}°`);
    parts.push(formatDryMinutes(dryTime));
    const text = parts.join(' · ');

    // Build the icon + label + text container ONCE. Subsequent ticks
    // only update the text node — replacing innerHTML every poll
    // restarts the CSS animation every second, making the fan stutter.
    // Inline SVG with viewBox centered on (0,0) so rotation pivots on
    // the geometric center.
    if (!$pill.children('.drying-fan').length) {
      const svg =
        '<svg class="drying-fan" viewBox="-50 -50 100 100" aria-hidden="true">'
        + '<g>'
        +   '<ellipse cx="0" cy="-28" rx="11" ry="22"/>'
        +   '<ellipse cx="0" cy="-28" rx="11" ry="22" transform="rotate(72)"/>'
        +   '<ellipse cx="0" cy="-28" rx="11" ry="22" transform="rotate(144)"/>'
        +   '<ellipse cx="0" cy="-28" rx="11" ry="22" transform="rotate(216)"/>'
        +   '<ellipse cx="0" cy="-28" rx="11" ry="22" transform="rotate(288)"/>'
        + '</g>'
        + '<circle cx="0" cy="0" r="6"/>'
        + '</svg>';
      $pill.html(
        svg
        + '<span class="drying-label">Drying</span>'
        + '<span class="drying-text"></span>'
      );
    }
    // Numbers part — temp + remaining time, prefixed with separator.
    $pill.children('.drying-text').text('· ' + text);
    $pill.show();
    $row.show();
  } else {
    $pill.hide();
    $row.hide();
  }
}

function formatDryMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

BBTelemetry.poll(print => {
  currentState = print.gcode_state || 'OFF';
  return updateAMS(print);
}, { ready: print => Array.isArray(print.ams?.ams) });
