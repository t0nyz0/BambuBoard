// BambuBoard
// TZ | 11/20/23

//-------------------------------------------------------------------------------------------------------------
const protocol = window.location.protocol; // 'http:' or 'https:'
const serverURL = window.location.hostname; // IP of the computer running this dashboard
const serverPort = window.location.port;
//-------------------------------------------------------------------------------------------------------------

let currentState = "OFF";
let modelImage = "";
let settings = ""; 
const consoleLogging = false;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

async function loadSettings() {
  try {
      const serverURL = window.location.hostname;
      const response = await fetch(fullServerURL+ '/settings');
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
async function updateUI(telemetryObject) {
  try {
    let printStatus = telemetryObject.gcode_state;
    let progressParentWidth = $("#printParentProgressBar").width();

    // mc_remaining_time in minutes
    const mcRemainingTime = telemetryObject.mc_remaining_time;

    const now = new Date();
    const futureTime = new Date(now.getTime() + mcRemainingTime * 60 * 1000); // Convert minutes to milliseconds

    // Extract hours and minutes
    const hours = futureTime.getHours();
    const minutes = futureTime.getMinutes();

    // Determine AM or PM suffix
    const ampm = hours >= 12 ? "pm" : "am";

    // Format hours for 12-hour format and handle midnight/noon cases
    const formattedHours = hours % 12 === 0 ? 12 : hours % 12;

    // Ensure minutes are two digits
    const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;

    // Format the future time
    const formattedTime = `${formattedHours}:${formattedMinutes}${ampm}`;

    log(formattedTime);

    if (printStatus === "RUNNING") {
      printStatus = "Printing";
    } else if (printStatus === "FINISH") {
      printStatus = "Print Complete";
    } else if (printStatus === "FAILED") {
    }

    /// Bed Temp

    const targetC = BBTelemetry.number(telemetryObject.bed_target_temper);
    const bedTargetTemp = targetC === 0 ? "OFF" : targetC === null ? "—" : (targetC * 9) / 5 + 32;
    let bedTempPercentage = targetC > 0 ? (telemetryObject.bed_temper / targetC) * 100 : 0;
    log("bedTargetTemp = " + bedTargetTemp);
    log("bedTempPercentage = " + bedTempPercentage);

    if (bedTempPercentage > 100) {
      log(
        "Bed percentage over 100, adjusting..." + bedTempPercentage
      );
      bedTempPercentage = 100;
    }

    // Set target temp in UI
    $("#bedTargetTempF").text(bedTargetTemp);
    $("#bedTargetTempC").text(targetC ?? "—");

    // Set current temp in UI
    var bedCurrentTempF = Math.round((telemetryObject.bed_temper * 9) / 5 + 32);
    $("#bedCurrentTempF").text(bedCurrentTempF);

    var bedCurrentTempC = Math.round(telemetryObject.bed_temper);
    $("#bedCurrentTempC").text(bedCurrentTempC);

    log("bedCurrentTemp = " + bedCurrentTempF);
    let progressBedParentWidth = $("#bedProgressBarParent").width();

    log("progressBedParentWidth = " + progressBedParentWidth);
    $("#bedProgressBar").width(
      (bedTempPercentage * progressBedParentWidth) / 100
    );

    if (bedTargetTemp === "OFF") {
      $("#bedProgressBar").css("background-color", "grey");

      $("#bedTargetTempC").hide();
      $("#bedTargetTempSymbolsF").hide();
      $("#bedTargetTempSymbolsC").hide();
    } else {
      if (settings.BambuBoard_tempSetting === "Fahrenheit")
      {
        $("#bedTargetTempSymbolsF").show();
        $("#bedCurrentTempSymbolsF").show();
        $("#bedTargetTempF").show();
        $("#bedCurrentTempF").show();

        $("#bedCurrentTempC").hide();
        $("#bedTargetTempSymbolsC").hide();
        $("#bedCurrentTempSymbolsC").hide();
        $("#bedTargetTempC").hide();
      }
      else if (settings.BambuBoard_tempSetting === "Celsius")
      {
        $("#bedTargetTempSymbolsF").hide();
        $("#bedCurrentTempSymbolsF").hide();
        $("#bedTargetTempF").hide();
        $("#bedCurrentTempF").hide();

        $("#bedCurrentTempC").show();
        $("#bedTargetTempSymbolsC").show();
        $("#bedCurrentTempSymbolsC").show();
        $("#bedTargetTempC").show();
      }
      else if (settings.BambuBoard_tempSetting === "Both")
      {
        $("#bedTargetTempSymbolsF").show();
        $("#bedCurrentTempSymbolsF").show();
        $("#bedTargetTempF").show();
        $("#bedCurrentTempF").show();

        $("#bedCurrentTempC").show();
        $("#bedTargetTempSymbolsC").show();
        $("#bedCurrentTempSymbolsC").show();
        $("#bedTargetTempC").show();
      }

      if (bedTempPercentage > 80) {
        $("#bedProgressBar").css("background-color", "red");
      } else if (bedTempPercentage > 50) {
        $("#bedProgressBar").css("background-color", "yellow");
      } else {
        $("#bedProgressBar").css("background-color", "#51a34f");
      }
    }

    log(telemetryObject.t_utc);
    return telemetryObject;
  } catch (error) {
    console.error("Error: ", error);
  }
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

BBTelemetry.poll(print => {
  currentState = print.gcode_state;
  return updateUI(print);
}, { ready: print => BBTelemetry.number(print.bed_temper) !== null });
