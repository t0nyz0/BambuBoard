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
      printStatus = "Printing" + "... " + telemetryObject.mc_percent + "%";

      if(telemetryObject.stg_cur != 0)
      {
        printStatus = get_stage_string(telemetryObject.stg_cur);
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
      $("#printStatus").text("Print failed" + "... ");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "#red");
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

function get_stage_string(stage)
{
    switch(stage) {
    case -1:
        return ("Working")
    case 0:
        return ("Printing");
    case 1:
        return ("Auto bed leveling");
    case 2:
        return ("Heatbed preheating");
    case 3:
        return ("Sweeping XY mech mode");
    case 4:
        return ("Changing filament");
    case 5:
        return ("M400 pause");
    case 6:
        return ("Paused due to filament runout");
    case 7:
        return ("Heating hotend");
    case 8:
        return ("Calibrating extrusion");
    case 9:
        return ("Scanning bed surface");
    case 10:
        return ("Inspecting first layer");
    case 11:
        return ("Identifying build plate type");
    case 12:
        return ("Calibrating Micro Lidar");
    case 13:
        return ("Homing toolhead");
    case 14:
        return ("Cleaning nozzle tip");
    case 15:
        return ("Checking extruder temperature");
    case 16:
        return ("Printing was paused by the user");
    case 17:
        return ("Pause of front cover falling");
    case 18:
        return ("Calibrating the micro lidar");
    case 19:
        return ("Calibrating extrusion flow");
    case 20:
        return ("Paused due to nozzle temperature malfunction");
    case 21:
        return ("Paused due to heat bed temperature malfunction");
    case 22:
        return ("Filament unloading");
    case 23:
        return ("Skip step pause");
    case 24:
        return ("Filament loading");
    case 25:
        return ("Motor noise calibration");
    case 26:
        return ("Paused due to AMS lost");
    case 27:
        return ("Paused due to low speed of the heat break fan");
    case 28:
        return ("Paused due to chamber temperature control error");
    case 29:
        return ("Cooling chamber");
    case 30:
        return ("Paused by the Gcode inserted by user");
    case 31:
        return ("Motor noise showoff");
    case 32:
        return ("Nozzle filament covered detected pause");
    case 33:
        return ("Cutter error pause");
    case 34:
        return ("First layer error pause");
    case 35:
        return ("Nozzle clog pause");
    default:
        ;
    }
    return "";
}
