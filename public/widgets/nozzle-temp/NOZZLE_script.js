// BambuBoard — Unified nozzle temperature widget
// Supports ?nozzle=N parameter: 0 = right (default), 1 = left
// For single-nozzle printers, only ?nozzle=0 is meaningful.
// Uses H2D bit-packed temp format with legacy fallback.

const NOZZLE_INDEX = parseInt(new URLSearchParams(location.search).get('nozzle') || '0', 10);

const protocol = window.location.protocol;
const serverURL = window.location.hostname;
const serverPort = window.location.port;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

let currentState = 'OFF';
const consoleLogging = false;
let settings = '';

// Set title data attributes based on nozzle index (before _customizer.js applies them).
// _customizer.js already ran once at DOMContentLoaded, so we re-apply after setting attrs.
(function setTitleDefaults() {
  const h2 = document.querySelector('.partTitle');
  if (!h2) return;
  if (NOZZLE_INDEX === 0) {
    h2.setAttribute('data-default', 'Nozzle');
    h2.setAttribute('data-default-dual', 'Right Nozzle');
  } else {
    h2.setAttribute('data-default', 'Left Nozzle');
    h2.setAttribute('data-default-dual', 'Left Nozzle');
    // Set immediately so there's no flash of "Nozzle"
    const firstText = h2.firstChild;
    if (firstText && firstText.nodeType === 3) firstText.nodeValue = 'Left Nozzle';
  }
})();

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
async function updateUI(telemetryObject) {
  try {
    // Extract temperature from bit-packed H2D format, with legacy fallback.
    const extruder = telemetryObject.device && telemetryObject.device.extruder
      ? telemetryObject.device.extruder
      : null;
    const { current, target } = BBTelemetry.nozzleTemps(telemetryObject, NOZZLE_INDEX);

    // A1/P1/X1 report nozzle_temper as a float (e.g. 27.8125); the packed
    // H2D format yields integers. Round so the display matches the bed widget
    // and ha-bambulab rather than showing a long decimal like "27.8125".
    const nozzleCurrentTempC = Math.round(current);
    const nozzleTargetTempC = target === null ? null : Math.round(target);

    // Active-extruder badge for dual-nozzle printers.
    // Show bright green when printing, grey/dim when idle.
    const isPrinting = currentState === 'RUNNING' || currentState === 'PREPARE' || currentState === 'PAUSE';
    try {
      if (extruder && typeof extruder.state === 'number') {
        const activeIdx = (extruder.state >> 4) & 0x0F;
        const $card = $('.bed-title');
        if (activeIdx === NOZZLE_INDEX && isPrinting) {
          // The .nozzle-active class on .bed-title gives the whole card a
          // green tint + glow. Much more visible than the legacy inline pill.
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

    // Compute Fahrenheit and percentage
    const nozzleCurrentTempF = Math.round((nozzleCurrentTempC * 9) / 5 + 32);
    let nozzleTempPercentage = 0;

    if (nozzleTargetTempC > 0) {
      nozzleTempPercentage = (nozzleCurrentTempC / nozzleTargetTempC) * 100;
    }

    if (nozzleTempPercentage > 100) {
      log('Nozzle percentage over 100, adjusting...' + nozzleTempPercentage);
      nozzleTempPercentage = 100;
    }

    // Set current temp in UI
    if (nozzleCurrentTempC > 1 && nozzleCurrentTempC < 800) {
      $('#nozzleCurrentTempC').text(nozzleCurrentTempC);
      $('#nozzleCurrentTempF').text(nozzleCurrentTempF);
    } else {
      $('#nozzleCurrentTempC').text('-');
      $('#nozzleCurrentTempF').text('-');
    }

    // Set target temp in UI
    let nozzleTargetDisplay;
    if (nozzleTargetTempC > 0) {
      const nozzleTargetTempF = Math.round((nozzleTargetTempC * 9) / 5 + 32);
      $('#nozzleTargetTempC').text(Math.round(nozzleTargetTempC));
      $('#nozzleTargetTempF').text(nozzleTargetTempF);
      nozzleTargetDisplay = nozzleTargetTempC;
    } else if (nozzleTargetTempC === null) {
      nozzleTargetDisplay = '—';
      $('#nozzleTargetTempF, #nozzleTargetTempC').text('—');
    } else {
      nozzleTargetDisplay = 'OFF';
      $('#nozzleTargetTempF').text('OFF');
      $('#nozzleTargetTempC').text('');
    }

    log('nozzleCurrentTempC = ' + nozzleCurrentTempC);
    log('nozzleTargetTempC = ' + nozzleTargetTempC);
    log('nozzleTempPercentage = ' + nozzleTempPercentage);

    // Update progress bar
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

function log(logText) {
  if (consoleLogging) console.log(logText);
}

BBTelemetry.poll(print => {
  currentState = print.gcode_state;
  return updateUI(print);
}, { ready: print => BBTelemetry.nozzleTemps(print, NOZZLE_INDEX) !== null });
