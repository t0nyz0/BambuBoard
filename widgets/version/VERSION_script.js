//-------------------------------------------------------------------------------------------------------------
/// Configure your settings here:

const serverURL = window.location.hostname; // IP of the computer running this dashboard

// Note: If set to 127.0.0.1 you will not be able to view your plate image, weight or total prints.
//       Those features will only work if viewing the dashboard locally.

//-------------------------------------------------------------------------------------------------------------

// -- Dont touch below

// BambuBoard
// TZ | 11/20/23

let currentState = "OFF";
let modelImage = "";
const consoleLogging = false;
let telemetryObjectMain;

async function retrieveData() {
  // Setting: Point this URL to your local server that is generating the telemetry data from Bambu
  const response = await fetch(
    "http://" + serverURL + ":" + window.location.port + "/package.json"
  );

  let data = await response.text();
  let telemetryObject = JSON.parse(data);

  return telemetryObject;
}

function setVersion(telemetryObject) {
  $("#versionNumber").text("BambuBoard Version: " + telemetryObject.version);
}

function log(logText) {
  if (consoleLogging) {
    console.log(logText);
  }
}

async function updateUI() {
  try {
    var telemetryObject = await retrieveData();
    telemetryObjectMain = telemetryObject;
    if (telemetryObject != null) {
      setVersion(telemetryObject);
    }
  } catch (error) {
    //console.error(error);
  }
}

updateUI();