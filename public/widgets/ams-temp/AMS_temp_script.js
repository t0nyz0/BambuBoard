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
let telemetryObjectMain;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

// Multi-AMS support: read ?ams=N URL parameter (0..3) so a single widget file
// can drive any AMS unit. Default is 0 (primary AMS). The legacy ams2/
// folder still exists as a fallback for back-compat with already-imported
// OBS scenes; new scenes can simply add ?ams=1, ?ams=2, ?ams=3 to /widgets/ams/.
const AMS_INDEX = (function () {
  const n = parseInt(new URLSearchParams(window.location.search).get('ams'), 10);
  // Default to 1 because H2D MQTT enumerates the user's "AMS #1" as id=1.
  // Single-AMS printers can pass ?ams=0 to view that unit explicitly.
  return Number.isFinite(n) && n >= 0 && n <= 3 ? n : 1;
})();


async function loadSettings() {
  try {
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

async function retrieveData() {
  const response2 = await fetch(fullServerURL + "/data.json");

  let data = await response2.text();
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

// Update humidity-raw % and drying status. Logic shared between AMS #1 and #2
// (both ams-temp/ and ams-temp-2/ widgets call this with their unit index).
// Mirrors ha-bambulab's AMS humidity / dryer model.
function updateHumidityExtras(unit) {
  if (!unit) return;
  // humidity_raw is the actual percentage (0-100). Falls back to humidity index
  // (1-5, low-to-high) which doesn't have a percentage form.
  var humPct = unit.humidity_raw != null ? parseInt(unit.humidity_raw, 10) : null;
  $("#humidityPercent").text(humPct != null && !isNaN(humPct) ? `(${humPct}%)` : "");

  // Drying state: dry_time > 0 while AMS is actively heating filament.
  // Renders as a pulsing pill next to the AMS title. ha-bambulab confirms
  // only AMS 2 Pro / AMS HT models report non-zero dry_time, so older
  // AMS / AMS Lite users see nothing — no model gating needed.
  var dryTime = unit.dry_time != null ? parseInt(unit.dry_time, 10) : 0;
  var setting = unit.dry_setting || {};
  var $pill = $("#dryingStatusPill");
  if (dryTime > 0) {
    var temp = parseInt(setting.dry_temperature, 10);
    var detail = [];
    if (!isNaN(temp) && temp > 0) detail.push(`${temp}°C`);
    detail.push(formatDryMinutes(dryTime));
    $pill.text(`Drying — ${detail.join(' / ')}`).show();
  } else {
    $pill.hide();
  }
}

function formatDryMinutes(mins) {
  if (mins < 60) return `${mins}m left`;
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return m === 0 ? `${h}h left` : `${h}h ${m}m left`;
}

async function updateAMS(telemetryObject) {
  /// AMS

  updateHumidityExtras(telemetryObject.ams.ams[AMS_INDEX]);

  // AMS Humidity
  let amsHumidity = telemetryObject.ams.ams[AMS_INDEX].humidity;

  if (currentState !== "RUNNING")
  {
    $("#humidity1").css("background", "#383838");
    $("#humidity2").css("background", "#383838");
    $("#humidity3").css("background", "#383838");
    $("#humidity4").css("background", "#383838");
    $("#humidity5").css("background", "#383838");
  }
  else
  {
    $("#humidity1").css("background", "gray");
    $("#humidity2").css("background", "gray");
    $("#humidity3").css("background", "gray");
    $("#humidity4").css("background", "gray");
    $("#humidity5").css("background", "gray");
  }

  if (amsHumidity === "5"){
    // One green bar
    if (currentState !== "RUNNING") {
      $("#humidity1").css("background", "gray");
    }
    else
    {
      $("#humidity1").css("background", "#51a34f");
    }
    
    $("#humidityLevelText").text("Low");
  } else if (amsHumidity === "4"){
    // Two green bar
    if (currentState !== "RUNNING") {
      $("#humidity1").css("background", "gray");
      $("#humidity2").css("background", "gray");
    }
    else
    {
      $("#humidity1").css("background", "#51a34f");
      $("#humidity2").css("background", "#51a34f");
    }

    $("#humidityLevelText").text("Low");
  } else if (amsHumidity === "3"){
    // 3 green bar
    if (currentState !== "RUNNING") {
      $("#humidity1").css("background", "gray");
      $("#humidity2").css("background", "gray");
      $("#humidity3").css("background", "gray");
    }
    else
    {
      $("#humidity1").css("background", "yellow");
      $("#humidity2").css("background", "yellow");
      $("#humidity3").css("background", "yellow");
    }

    $("#humidityLevelText").text("Ok");
  } else if (amsHumidity === "2"){
    // 4 green bar
    if (currentState !== "RUNNING") {
      $("#humidity1").css("background", "gray");
      $("#humidity2").css("background", "gray");
      $("#humidity3").css("background", "gray");
      $("#humidity4").css("background", "gray");
    }
    else
    {
      $("#humidity1").css("background", "red");
      $("#humidity2").css("background", "red");
      $("#humidity3").css("background", "red");
      $("#humidity4").css("background", "red");
    }
    $("#humidityLevelText").text("High");
  } else if (amsHumidity === "1"){
    // 5 green bar
    if (currentState !== "RUNNING") {
      $("#humidity1").css("background", "gray");
      $("#humidity2").css("background", "gray");
      $("#humidity3").css("background", "gray");
      $("#humidity4").css("background", "gray");
      $("#humidity5").css("background", "gray");
    }
    else
    {
      $("#humidity1").css("background", "red");
      $("#humidity2").css("background", "red");
      $("#humidity3").css("background", "red");
      $("#humidity4").css("background", "red");
      $("#humidity5").css("background", "red");
    }
    $("#humidityLevelText").text("High");
  }

  // AMS Temp
let amsTargetTemp = 140;
let amsTempPercentage = 1;
// ams Target Temp

amsTempPercentage = (telemetryObject.ams.ams[AMS_INDEX].temp / 60) * 100;

log("amsTargetTemp = " + amsTargetTemp);
log("amsTempPercentage = " + amsTempPercentage);

if (amsTempPercentage > 100) {
  log(
    "ams percentage over 100, adjusting..." + nozzleTempPercentage
  );
  amsTempPercentage = 100;
}

// Set target temp in UI
$("#amsTargetTempC").text("60");
$("#amsTargetTempF").text(amsTargetTemp);

// Set current temp in UI
var amsCurrentTemp = (telemetryObject.ams.ams[AMS_INDEX].temp * 9) / 5 + 32;
amsCurrentTemp = parseFloat(amsCurrentTemp.toFixed(1));
$("#amsCurrentTempF").text(amsCurrentTemp);
$("#amsCurrentTempC").text(telemetryObject.ams.ams[AMS_INDEX].temp);

log("amsCurrentTemp = " + amsCurrentTemp);
let progressamsParentWidth = $("#amsProgressBarParent").width();

log("progressamsParentWidth = " + progressamsParentWidth);
$("#amsProgressBar").width(
  (amsTempPercentage * progressamsParentWidth) / 100
);

if (amsTargetTemp === "OFF") {
  $("#amsProgressBar").css("background-color", "grey");


  $("#amsTargetTempC").hide();
  $("#amsTargetTempSymbolsF").hide();
  $("#amsTargetTempSymbolsC").hide();
} else {
  if (settings.BambuBoard_tempSetting === "Fahrenheit")
  {
    $("#amsTargetTempSymbolsF").show();
    $("#amsCurrentTempSymbolsF").show();
    $("#amsTargetTempF").show();
    $("#amsCurrentTempF").show();

    $("#amsCurrentTempC").hide();
    $("#amsTargetTempSymbolsC").hide();
    $("#amsCurrentTempSymbolsC").hide();
    $("#amsTargetTempC").hide();
  }
  else if (settings.BambuBoard_tempSetting === "Celsius")
  {
    $("#amsTargetTempSymbolsF").hide();
    $("#amsCurrentTempSymbolsF").hide();
    $("#amsTargetTempF").hide();
    $("#amsCurrentTempF").hide();

    $("#amsCurrentTempC").show();
    $("#amsTargetTempSymbolsC").show();
    $("#amsCurrentTempSymbolsC").show();
    $("#amsTargetTempC").show();
  }
  else if (settings.BambuBoard_tempSetting === "Both")
  {
    $("#amsTargetTempSymbolsF").show();
    $("#amsCurrentTempSymbolsF").show();
    $("#amsTargetTempF").show();
    $("#amsCurrentTempF").show();

    $("#amsCurrentTempC").show();
    $("#amsTargetTempSymbolsC").show();
    $("#amsCurrentTempSymbolsC").show();
    $("#amsTargetTempC").show();
  }

    if (currentState !== "RUNNING") {
      if (amsTempPercentage > 90) {
        $("#amsProgressBar").css("background-color", "gray");
      } else if (amsTempPercentage > 70) {
        $("#amsProgressBar").css("background-color", "gray");
      } else {
        $("#amsProgressBar").css("background-color", "gray");
      }
    }
    else
    {
      if (amsTempPercentage > 90) {
        $("#amsProgressBar").css("background-color", "red");
      } else if (amsTempPercentage > 70) {
        $("#amsProgressBar").css("background-color", "yellow");
      } else {
        $("#amsProgressBar").css("background-color", "#51a34f");
      }
    }
  }
}

function disableUI() {


  $("#amsProgressBar").css("background-color", "grey");
  $("#amsCurrentTempSymbolsF").hide();
  $("#amsCurrentTempSymbolsC").hide();

  let amsHumidity = telemetryObject.ams.ams[AMS_INDEX].humidity;
  //let amsHumidity = "1";

  $("#humidity1").css("background", "gray");
  $("#humidity2").css("background", "gray");
  $("#humidity3").css("background", "gray");
  $("#humidity4").css("background", "gray");
  $("#humidity5").css("background", "gray");

  if (amsHumidity === "5"){
    // One green bar
    $("#humidity1").css("background", "white");
    $("#humidityLevelText").text("Low");
  } else if (amsHumidity === "4"){
    // Two green bar
    $("#humidity1").css("background", "white");
    $("#humidity2").css("background", "white");
    $("#humidityLevelText").text("Low");
  } else if (amsHumidity === "3"){
    // 3 green bar
    $("#humidity1").css("background", "white");
    $("#humidity2").css("background", "white");
    $("#humidity3").css("background", "white");
    $("#humidityLevelText").text("Ok");
  } else if (amsHumidity === "2"){
    // 4 green bar
    $("#humidity1").css("background", "white");
    $("#humidity2").css("background", "white");
    $("#humidity3").css("background", "white");
    $("#humidity4").css("background", "white");

    $("#humidityLevelText").text("High");
  } else if (amsHumidity === "1"){
    // 5 green bar
    $("#humidity1").css("background", "white");
    $("#humidity2").css("background", "white");
    $("#humidity3").css("background", "white");
    $("#humidity4").css("background", "white");
    $("#humidity5").css("background", "white");
    $("#humidityLevelText").text("High");
  }
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
        await updateAMS(telemetryObject);
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
