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
  const response = await fetch(fullServerURL+ "/version");

  let data = await response.text();
  let versionNumber = JSON.parse(data);

  return versionNumber;
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
    // Not important if goes wrong
  }
}

updateUI();