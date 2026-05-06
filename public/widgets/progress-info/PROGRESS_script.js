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
let telemetryObjectMain;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

async function retrieveData() {
  // Setting: Point this URL to your local server that is generating the telemetry data from Bambu
  const response = await fetch(fullServerURL + "/data.json");

  let data = await response.text();
  let telemetryObject = JSON.parse(data);

  if (telemetryObject.print && "gcode_state" in telemetryObject.print) {
    currentState = telemetryObject.print.gcode_state;
    telemetryObject = telemetryObject.print;
  } else if (telemetryObject.print) {
    telemetryObject = "Incomplete";
  } else {
    telemetryObject = null;
  }

  return telemetryObject;
}

async function updateUI(telemetryObject) {
  try {
    let printStatus = telemetryObject.gcode_state;
    let progressParentWidth = $("#printParentProgressBar").width();

    if (printStatus === "RUNNING") {
      const pctText = "Printing... " + (telemetryObject.mc_percent || 0) + "%";
      printStatus = pctText;

      // Newer firmware uses stage codes outside the original 0–35 range
      // (e.g. H2D reports 74, 72, etc.). Only override the percent text if
      // get_stage_string actually recognizes the stage — otherwise fall back
      // to "Printing... X%" so the bar is never blank.
      if (telemetryObject.stg_cur != 0) {
        const stageLabel = get_stage_string(telemetryObject.stg_cur);
        if (stageLabel) {
          // Pair the stage description with the percentage so users keep
          // visibility into progress while a sub-stage is active.
          printStatus = stageLabel + " — " + (telemetryObject.mc_percent || 0) + "%";
        }
      }
      $("#printProgressBar").css("background-color", "#51a34f");
      $("#printStatus").text(
        printStatus
      );
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
    } else if (printStatus === "FINISH") {
      printStatus = "Print Complete";
      $("#printStatus").text(printStatus + "... ");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "grey");
    } else if (printStatus === "FAILED") {
      $("#printStatus").text("Print failed...");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "red");
    } else if (printStatus === "PAUSE") {
      $("#printStatus").text("Paused... " + (telemetryObject.mc_percent || 0) + "%");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "#e2a04a");
    } else if (printStatus === "PREPARE") {
      $("#printStatus").text("Preparing...");
      $("#printProgressBar").width(5);
      $("#printProgressBar").css("background-color", "#4a90e2");
    } else if (printStatus === "IDLE") {
      $("#printStatus").text("Idle");
      $("#printProgressBar").width(5);
      $("#printProgressBar").css("background-color", "grey");
    } else if (printStatus === "SLICING") {
      $("#printStatus").text("Slicing...");
      $("#printProgressBar").width(5);
      $("#printProgressBar").css("background-color", "#4a90e2");
    } else {
      // Unknown or new state — show something rather than blank
      const label = printStatus
        ? printStatus.charAt(0).toUpperCase() + printStatus.slice(1).toLowerCase()
        : 'Processing';
      $("#printStatus").text(label + "...");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100 || 5
      );
      $("#printProgressBar").css("background-color", "grey");
    }

    return telemetryObject;
  } catch (error) {
    console.error("Error: ", error);
  }
}

function disableUI() {
  $("#bedProgressBar").css("background-color", "grey");
}

function convertUtc(timestampUtcMs) {
  var localTime = new Date(timestampUtcMs);

  // Formatting the date to a readable string in local time
  return localTime.toLocaleString();
}

function log(logText) {
  if (consoleLogging) {
    console.log(logText);
  }
}

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

// Call the updateLog function to fetch and parse the data
setInterval(async () => {
  try {
    var telemetryObject = await retrieveData();
    telemetryObjectMain = telemetryObject;
    if (telemetryObject != null) {
      if (telemetryObject != "Incomplete") {
        await updateUI(telemetryObject);
      }
    } else if (telemetryObject != "Incomplete") {
      // Data is incomplete, but we did get something, just skip for now
    } else {
      disableUI();
    }
  } catch (error) {
    //console.error(error);
    await sleep(1000);
  }
}, 1000);

function convertMinutesToReadableTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return (
      hours +
      " hour" +
      (hours > 1 ? "s " : " ") +
      minutes +
      " minute" +
      (minutes !== 1 ? "s" : "")
    );
  } else {
    return minutes + " minute" + (minutes !== 1 ? "s" : "");
  }
}

// Stage codes published by Bambu printers via MQTT (`stg_cur`). Ported from
// ha-bambulab's CURRENT_STAGE_IDS (pybambu/const.py) — they keep this list
// up to date as Bambu adds new sub-stages with each firmware release. Stages
// 36+ are H2D/H2S/X1E-era additions; without these we leave the progress bar
// blank during, e.g., heatbed-foreign-object detection (stage 74).
const STAGE_NAMES = {
  '-1': 'Working',
  0: 'Printing',
  1: 'Auto bed leveling',
  2: 'Heatbed preheating',
  3: 'Vibration compensation',
  4: 'Changing filament',
  5: 'M400 pause',
  6: 'Paused — filament runout',
  7: 'Heating hotend',
  8: 'Calibrating extrusion',
  9: 'Scanning bed surface',
  10: 'Inspecting first layer',
  11: 'Identifying build plate type',
  12: 'Calibrating Micro Lidar',
  13: 'Homing toolhead',
  14: 'Cleaning nozzle tip',
  15: 'Checking extruder temperature',
  16: 'Paused by user',
  17: 'Paused — front cover',
  18: 'Calibrating Micro Lidar',
  19: 'Calibrating extrusion flow',
  20: 'Paused — nozzle temp malfunction',
  21: 'Paused — heatbed temp malfunction',
  22: 'Filament unloading',
  23: 'Skip-step pause',
  24: 'Filament loading',
  25: 'Calibrating motor noise',
  26: 'Paused — AMS lost',
  27: 'Paused — low heatbreak fan speed',
  28: 'Paused — chamber temp error',
  29: 'Cooling chamber',
  30: 'Paused by user G-code',
  31: 'Motor noise showoff',
  32: 'Paused — nozzle filament covered',
  33: 'Paused — cutter error',
  34: 'Paused — first-layer error',
  35: 'Paused — nozzle clog',
  36: 'Check absolute accuracy (pre-cal)',
  37: 'Absolute accuracy calibration',
  38: 'Check absolute accuracy (post-cal)',
  39: 'Calibrating nozzle offset',
  40: 'Bed leveling — high temp',
  41: 'Checking quick-release',
  42: 'Checking door and cover',
  43: 'Laser calibration',
  44: 'Checking platform',
  45: 'Checking birdeye camera position',
  46: 'Calibrating birdeye camera',
  47: 'Bed leveling — phase 1',
  48: 'Bed leveling — phase 2',
  49: 'Heating chamber',
  50: 'Cooling heatbed',
  51: 'Printing calibration lines',
  52: 'Checking material',
  53: 'Calibrating live-view camera',
  54: 'Waiting for heatbed temperature',
  55: 'Checking material position',
  56: 'Calibrating cutter model offset',
  57: 'Measuring surface',
  58: 'Thermal preconditioning',
  59: 'Homing blade holder',
  60: 'Calibrating camera offset',
  61: 'Calibrating blade-holder position',
  62: 'Hotend pick-and-place test',
  63: 'Waiting — chamber temp equalize',
  64: 'Preparing hotend',
  65: 'Calibrating nozzle-clumping detection',
  66: 'Purifying chamber air',
  67: 'Measuring rotary attachment',
  68: 'Moving toolhead above purge chute',
  69: 'Cooling nozzle',
  70: 'Moving toolhead to bed center',
  71: 'Active arc fitting',
  72: 'Detecting hotend type',
  73: 'Build-plate alignment detection',
  74: 'Heatbed foreign-object check',
  75: 'Heatbed underside foreign-object check',
  76: 'Pre-extrusion before printing',
  77: 'Preparing AMS',
  255: 'Idle',
};

function get_stage_string(stage) {
  return STAGE_NAMES[stage] || '';
}
