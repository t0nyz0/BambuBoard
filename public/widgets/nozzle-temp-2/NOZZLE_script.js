// BambuBoard — Left nozzle temperature widget (legacy back-compat)
// This is equivalent to nozzle-temp/?nozzle=1. Kept for existing OBS scenes
// that reference /widgets/nozzle-temp-2/.
// Hardcoded to NOZZLE_INDEX = 1 (left nozzle).

const NOZZLE_INDEX = 1;

const protocol = window.location.protocol;
const serverURL = window.location.hostname;
const serverPort = window.location.port;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

let currentState = 'OFF';
const consoleLogging = false;
let settings = '';

async function loadSettings() {
  try {
    const response = await fetch(fullServerURL + '/settings');
    if (response.ok) {
      settings = await response.json();
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

loadSettings();
// Re-fetch every 5s so changes made on the /setup page (e.g. temperature
// unit, fan-percent toggle) propagate without reloading the iframe.
setInterval(loadSettings, 5000);
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

async function updateUI(telemetryObject) {
  try {
    const extruder = telemetryObject.device && telemetryObject.device.extruder
      ? telemetryObject.device.extruder
      : null;
    const nozzleInfo = extruder && extruder.info && extruder.info[NOZZLE_INDEX]
      ? extruder.info[NOZZLE_INDEX]
      : null;

    let nozzleCurrentTempC = 0;
    let nozzleTargetTempC = 0;

    if (nozzleInfo && typeof nozzleInfo.temp === 'number') {
      nozzleCurrentTempC = nozzleInfo.temp & 0xFFFF;
      nozzleTargetTempC = (nozzleInfo.temp >> 16) & 0xFFFF;
    } else {
      nozzleCurrentTempC = telemetryObject.nozzle_temper || 0;
      nozzleTargetTempC = telemetryObject.nozzle_target_temper || 0;
    }

    // A1/P1/X1 report nozzle_temper as a float (e.g. 27.8125); the packed
    // H2D format yields integers. Round so the display matches the bed widget
    // and ha-bambulab rather than showing a long decimal like "27.8125".
    nozzleCurrentTempC = Math.round(nozzleCurrentTempC);
    nozzleTargetTempC = Math.round(nozzleTargetTempC);

    // Active-extruder badge — bright green when printing, grey/dim when idle
    const isPrinting = currentState === 'RUNNING' || currentState === 'PREPARE' || currentState === 'PAUSE';
    try {
      if (extruder && typeof extruder.state === 'number') {
        const activeIdx = (extruder.state >> 4) & 0x0F;
        const $card = $('.bed-title');
        if (activeIdx === NOZZLE_INDEX && isPrinting) {
          // See /widgets/nozzle-temp/NOZZLE_script.js — container highlight
          // replaces the legacy inline pill for visibility.
          $card.addClass('nozzle-active');
          $('#activeTag').show()
            .css({ 'background-color': '#51a34f', 'opacity': '1' });
        } else {
          $card.removeClass('nozzle-active');
          $('#activeTag').hide();
        }
      } else {
        $('.bed-title').removeClass('nozzle-active');
        $('#activeTag').hide();
      }
    } catch (_) {
      $('.bed-title').removeClass('nozzle-active');
      $('#activeTag').hide();
    }

    const nozzleCurrentTempF = Math.round((nozzleCurrentTempC * 9) / 5 + 32);
    let nozzleTempPercentage = 0;

    if (nozzleTargetTempC > 0) {
      nozzleTempPercentage = (nozzleCurrentTempC / nozzleTargetTempC) * 100;
    }
    if (nozzleTempPercentage > 100) nozzleTempPercentage = 100;

    if (nozzleCurrentTempC > 1 && nozzleCurrentTempC < 800) {
      $('#nozzleCurrentTempC').text(nozzleCurrentTempC);
      $('#nozzleCurrentTempF').text(nozzleCurrentTempF);
    } else {
      $('#nozzleCurrentTempC').text('-');
      $('#nozzleCurrentTempF').text('-');
    }

    let nozzleTargetDisplay;
    if (nozzleTargetTempC > 0) {
      const nozzleTargetTempF = Math.round((nozzleTargetTempC * 9) / 5 + 32);
      $('#nozzleTargetTempC').text(Math.round(nozzleTargetTempC));
      $('#nozzleTargetTempF').text(nozzleTargetTempF);
      nozzleTargetDisplay = nozzleTargetTempC;
    } else {
      nozzleTargetDisplay = 'OFF';
      $('#nozzleTargetTempF').text('OFF');
      $('#nozzleTargetTempC').text('');
    }

    const progressNozzleParentWidth = $('#nozzleProgressBarParent').width();
    $('#nozzleProgressBar').width((nozzleTempPercentage * progressNozzleParentWidth) / 100);

    if (nozzleTargetDisplay === 'OFF') {
      $('#nozzleProgressBar').css('background-color', 'grey');
      $('#nozzleTargetTempC').hide();
      $('#nozzleTargetTempSymbolsF').hide();
      $('#nozzleTargetTempSymbolsC').hide();
    } else {
      if (settings.BambuBoard_tempSetting === 'Fahrenheit') {
        $('#nozzleTargetTempSymbolsF').show();
        $('#nozzleCurrentTempSymbolsF').show();
        $('#nozzleTargetTempF').show();
        $('#nozzleCurrentTempF').show();
        $('#nozzleCurrentTempC').hide();
        $('#nozzleTargetTempSymbolsC').hide();
        $('#nozzleCurrentTempSymbolsC').hide();
        $('#nozzleTargetTempC').hide();
      } else if (settings.BambuBoard_tempSetting === 'Celsius') {
        $('#nozzleTargetTempSymbolsF').hide();
        $('#nozzleCurrentTempSymbolsF').hide();
        $('#nozzleTargetTempF').hide();
        $('#nozzleCurrentTempF').hide();
        $('#nozzleCurrentTempC').show();
        $('#nozzleTargetTempSymbolsC').show();
        $('#nozzleCurrentTempSymbolsC').show();
        $('#nozzleTargetTempC').show();
      } else if (settings.BambuBoard_tempSetting === 'Both') {
        $('#nozzleTargetTempSymbolsF').show();
        $('#nozzleCurrentTempSymbolsF').show();
        $('#nozzleTargetTempF').show();
        $('#nozzleCurrentTempF').show();
        $('#nozzleCurrentTempC').show();
        $('#nozzleTargetTempSymbolsC').show();
        $('#nozzleCurrentTempSymbolsC').show();
        $('#nozzleTargetTempC').show();
      }

      if (nozzleTempPercentage > 80) {
        $('#nozzleProgressBar').css('background-color', 'red');
      } else if (nozzleTempPercentage > 50) {
        $('#nozzleProgressBar').css('background-color', 'yellow');
      } else {
        $('#nozzleProgressBar').css('background-color', '#51a34f');
      }
    }

    return telemetryObject;
  } catch (error) {
    console.error('Error: ', error);
  }
}

function disableUI() {
  $('#activeTag').hide();
  $('#nozzleProgressBar').css('background-color', 'grey');
  $('#nozzleProgressBar').width(0);
  $('#nozzleTargetTempSymbolsF').hide();
  $('#nozzleTargetTempSymbolsC').hide();
  $('#nozzleTargetTempC').hide();
  $('#nozzleCurrentTempC').hide();
  $('#nozzleCurrentTempF').hide();
  $('#nozzleCurrentTempSymbolsC').hide();
  $('#nozzleCurrentTempSymbolsF').hide();
}

function log(logText) {
  if (consoleLogging) console.log(logText);
}

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

setInterval(async () => {
  try {
    const telemetryObject = await retrieveData();
    if (telemetryObject != null && telemetryObject !== 'Incomplete') {
      await updateUI(telemetryObject);
    } else if (telemetryObject == null) {
      disableUI();
    }
  } catch (error) {
    await sleep(1000);
  }
}, 1000);
