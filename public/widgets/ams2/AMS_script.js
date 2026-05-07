// BambuBoard — AMS Tray widget (AMS #2 — legacy back-compat)
// Hardcoded to AMS index 1 for backward compatibility with existing OBS scenes.
// New scenes should use /widgets/ams/?ams=1 instead.

const AMS_INDEX = 1;

const protocol = window.location.protocol;
const serverURL = window.location.hostname;
const serverPort = window.location.port;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

let currentState = 'OFF';
const consoleLogging = false;
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

async function retrieveData() {
  const response = await fetch(fullServerURL + '/data.json');
  let data = await response.text();
  let telemetryObject = JSON.parse(data);

  if (telemetryObject.print && 'gcode_state' in telemetryObject.print) {
    currentState = telemetryObject.print.gcode_state;
    telemetryObject = telemetryObject.print;
  } else if (telemetryObject.print) {
    telemetryObject = 'Incomplete';
  } else {
    telemetryObject = null;
  }

  return telemetryObject;
}

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
    $(`#tray${n}ProgressBar`).css('background-color', 'grey');
  }
}

async function updateAMS(telemetryObject) {
  try {
    const amsUnit = telemetryObject.ams.ams[AMS_INDEX];
    if (!amsUnit || !amsUnit.tray) return;

    // Update all 4 trays.
    for (let i = 0; i < 4; i++) {
      updateTray(i, amsUnit.tray[i] || {});
    }

    // Drying pill + humidity_raw % — see ams/AMS_script.js for details.
    updateDryingStatus(amsUnit);
    const humPct = amsUnit.humidity_raw != null ? parseInt(amsUnit.humidity_raw, 10) : NaN;
    $('#humidityPercent').text(!isNaN(humPct) ? `(${humPct}%)` : '');

    // AMS Humidity
    const amsHumidity = amsUnit.humidity;

    $('#humidity1, #humidity2, #humidity3, #humidity4, #humidity5').css('background', 'gray');

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
    const amsTemp = amsUnit.temp || 0;
    const amsTempPercentage = Math.min((amsTemp / 60) * 100, 100);

    $('#amsTargetTempC').text('60');
    $('#amsTargetTempF').text(140);

    const amsCurrentTempF = parseFloat(((amsTemp * 9) / 5 + 32).toFixed(1));
    $('#amsCurrentTempF').text(amsCurrentTempF);
    $('#amsCurrentTempC').text(amsTemp);

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

    // AMS active tray — dual/quad-AMS aware.
    const THIS_AMS_INDEX = AMS_INDEX;
    const active = window.getActiveAmsTray
      ? window.getActiveAmsTray({ print: telemetryObject })
      : { amsIndex: 255, trayIndex: 255 };

    $('#tray1Active, #tray2Active, #tray3Active, #tray4Active').hide();
    // Reset container highlight on all trays before applying it to whichever
    // one is active. See ams/AMS_script.js for rationale.
    $('.ams-container .element').removeClass('tray-active');
    const activeColor = currentState === 'RUNNING' ? '#51a34f' : 'grey';
    $('#tray1Active, #tray2Active, #tray3Active, #tray4Active').css('background-color', activeColor);

    if (active.amsIndex === THIS_AMS_INDEX) {
      const slotMap = { 0: 1, 1: 2, 2: 3, 3: 4 };
      const slot = slotMap[active.trayIndex];
      if (slot) {
        $(`#tray${slot}Active`).show();
        $(`#tray${slot}Color`).closest('.element').addClass('tray-active');
      }
    }

    // Filament change target indicator.
    $('#tray1Target, #tray2Target, #tray3Target, #tray4Target').hide();
    try {
      const trayTar = parseInt(telemetryObject.ams.tray_tar, 10);
      const trayNow = parseInt(telemetryObject.ams.tray_now, 10);
      const stgCur = telemetryObject.stg_cur;
      const isChanging = !isNaN(trayTar) && trayTar !== 255 && trayTar !== trayNow;
      if (isChanging) {
        const tarAmsUnit = trayTar >= 128 ? (trayTar - 128) : (trayTar >> 2);
        const tarTraySlot = trayTar >= 128 ? 0 : (trayTar & 0x3);
        if (tarAmsUnit === THIS_AMS_INDEX) {
          $(`#tray${tarTraySlot + 1}Target`).show();
        }
      }
    } catch (_) {}
  } catch (error) {
    console.error('Error:', error);
  }
}

function disableUI() {
  for (let i = 1; i <= 4; i++) {
    $(`#tray${i}ProgressBar`).css('background-color', 'grey');
    $(`#tray${i}Active`).hide().css('background-color', 'grey');
    $(`#tray${i}Target`).hide();
  }
  $('.ams-container .element').removeClass('tray-active');
  $('#dryingStatusPill').hide();
}

// See ams/AMS_script.js for explanation. Heating-capable models only.
function updateDryingStatus(amsUnit) {
  const dryTime = parseInt(amsUnit.dry_time, 10) || 0;
  const dryTemp = parseInt((amsUnit.dry_setting || {}).dry_temperature, 10);
  const $pill = $('#dryingStatusPill');
  if (dryTime > 0) {
    const parts = [];
    if (dryTemp > 0) parts.push(`${dryTemp}°`);
    parts.push(formatDryMinutes(dryTime));
    // See ams/AMS_script.js — fans-widget toys_fan pattern (no wobble).
    const text = parts.join(' · ');
    const fan = '<span class="drying-fan-wrap">'
              +   '<span class="drying-fan material-symbols-outlined">toys_fan</span>'
              + '</span>';
    $pill
      .html(fan + '<span class="drying-text"></span>')
      .find('.drying-text').text(text).end()
      .show();
  } else {
    $pill.hide();
  }
}

function formatDryMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function log(logText) {
  if (consoleLogging) console.log(logText);
}

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

setInterval(async () => {
  try {
    const telemetryObject = await retrieveData();
    if (telemetryObject != null && telemetryObject !== 'Incomplete') {
      await updateAMS(telemetryObject);
    } else if (telemetryObject == null) {
      disableUI();
    }
  } catch (error) {
    await sleep(1000);
  }
}, 1000);
