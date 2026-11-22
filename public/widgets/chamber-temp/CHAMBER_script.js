// BambuBoard
// TZ | 11/20/23

//-------------------------------------------------------------------------------------------------------------
const protocol = window.location.protocol; // 'http:' or 'https:'
const serverURL = window.location.hostname; // IP of the computer running this dashboard
const serverPort = window.location.port;
//-------------------------------------------------------------------------------------------------------------

let currentState = "OFF";
let modelImage = "";
const consoleLogging = false;
let settings = "";
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

async function loadSettings() {
  try {
      const serverURL = window.location.hostname;
      const response = await fetch(fullServerURL + '/settings');
      if (response.ok) {
          const data = await response.json();
          settings = data;
      } 
  } catch (error) {
      console.error('Error loading settings:', error);
  }
}

loadSettings();
// Re-fetch every 5s so changes made on the /setup page (e.g. temperature
// unit, fan-percent toggle) propagate without reloading the iframe.
setInterval(loadSettings, 5000);

// Self-gate on printer capability: A1 / P1-class printers have no enclosed
// chamber but still emit a spurious `chamber_temper` (~5°C), which would
// otherwise render as a bogus tile. Hide the whole widget when the server's
// capability map says this printer has no chamber. Defaults to visible so a
// transient /api/status failure never hides it on a chamber-equipped printer.
let chamberSupported = true;
async function loadCaps() {
  try {
    const res = await fetch(fullServerURL + '/api/status');
    if (!res.ok) return;
    const s = await res.json();
    chamberSupported = !s.caps || s.caps.hasChamberTemp !== false;
    document.body.hidden = !chamberSupported;
  } catch (_) { /* keep visible on error */ }
}
loadCaps();

function chamberTemperature(print) {
  const packed = print.device?.ctc?.info?.temp;
  return Number.isFinite(packed) ? packed & 0xFFFF : BBTelemetry.number(print.chamber_temper);
}

async function updateUI(telemetryObject) {
  try {
    if (!chamberSupported) return telemetryObject; // no chamber on this printer
    let printStatus = telemetryObject.gcode_state;

    if (printStatus === "RUNNING") {
      printStatus = "Printing";
    } else if (printStatus === "FINISH") {
      printStatus = "Print Complete";
    } else if (printStatus === "FAILED") {
    }

    /// Chamber Temperature
    let chamberTargetTempF = 180;
    let chamberTargetTempC = 82;
    let chamberTempPercentage = 1;

    // Newer Bambu firmware (H2D) packs current+target into device.ctc.info.temp
    // (low 16 bits current, high 16 bits target). Legacy firmware uses the
    // top-level chamber_temper field. Read whichever one's present.
    const chamberC = chamberTemperature(telemetryObject);

    $("#chamberTargetTempF").text(chamberTargetTempF);
    $("#chamberTargetTempC").text(chamberTargetTempC);

    if (chamberC == null) {
      $("#chamberCurrentTempC").text("—");
      $("#chamberCurrentTempF").text("—");
      return telemetryObject;
    }

    var chamberCurrentTemp = (chamberC * 9) / 5 + 32;
    $("#chamberCurrentTempF").text(chamberCurrentTemp);
    $("#chamberCurrentTempC").text(chamberC);

    log("chamberCurrentTemp = " + chamberCurrentTemp);

    chamberTempPercentage = (chamberCurrentTemp / chamberTargetTempF) * 100;

    let progressChamberParentWidth = $("#chamberProgressBarParent").width();
    log("progressChamberParentWidth = " + progressChamberParentWidth);
    $("#chamberProgressBar").width(
      (chamberTempPercentage * progressChamberParentWidth) / 100
    );

    if (settings.BambuBoard_tempSetting === "Fahrenheit")
      {
        $("#chamberTargetTempSymbolsF").show();
        $("#chamberCurrentTempSymbolsF").show();
        $("#chamberTargetTempF").show();
        $("#chamberCurrentTempF").show();

        $("#chamberCurrentTempC").hide();
        $("#chamberTargetTempSymbolsC").hide();
        $("#chamberCurrentTempSymbolsC").hide();
        $("#chamberTargetTempC").hide();
      }
      else if (settings.BambuBoard_tempSetting === "Celsius")
      {
        $("#chamberTargetTempSymbolsF").hide();
        $("#chamberCurrentTempSymbolsF").hide();
        $("#chamberTargetTempF").hide();
        $("#chamberCurrentTempF").hide();

        $("#chamberCurrentTempC").show();
        $("#chamberTargetTempSymbolsC").show();
        $("#chamberCurrentTempSymbolsC").show();
        $("#chamberTargetTempC").show();
      }
      else if (settings.BambuBoard_tempSetting === "Both")
      {
        $("#chamberTargetTempSymbolsF").show();
        $("#chamberCurrentTempSymbolsF").show();
        $("#chamberTargetTempF").show();
        $("#chamberCurrentTempF").show();

        $("#chamberCurrentTempC").show();
        $("#chamberTargetTempSymbolsC").show();
        $("#chamberCurrentTempSymbolsC").show();
        $("#chamberTargetTempC").show();
      }

    if (chamberCurrentTemp > 110) {
      $("#chamberProgressBar").css("background-color", "red");
    } else if (chamberCurrentTemp > 100) {
      $("#chamberProgressBar").css("background-color", "yellow");
    } else {
      $("#chamberProgressBar").css("background-color", "#51a34f");
    }

    if (currentState !== "RUNNING") {
      $("#chamberProgressBar").css("background-color", "grey");
    }
    
    return telemetryObject;
  } catch (error) {
    console.error("Error: ", error);
  }
}

function log(logText) {
  if (consoleLogging) {
    console.log(logText);
  }
}

BBTelemetry.poll(print => {
  currentState = print.gcode_state;
  return updateUI(print);
}, { ready: print => chamberTemperature(print) !== null });
