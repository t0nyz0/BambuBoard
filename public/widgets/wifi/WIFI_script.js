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
  const response = await fetch(fullServerURL + "/data.json");

  let data = await response.text();
  let telemetryObject = JSON.parse(data);

  if (telemetryObject.print && 'gcode_state' in telemetryObject.print) {
    currentState = telemetryObject.print.gcode_state;
    telemetryObject = telemetryObject.print;
  }
  else if (telemetryObject.print)
  {
    telemetryObject = "Incomplete";
  } 
  else
  {
    telemetryObject = null;
  }

  return telemetryObject;
}

async function updateWifi(telemetryObject) {
  /// Wifi
  const wifiValue = telemetryObject.wifi_signal;

  log("Wifi Signal: " + wifiValue);
  const wifiFormated = wifiValue.replace("dBm", "");
  const signalPercentage = dBmToPercentage(parseInt(wifiFormated));
  log("Wifi percentage: " + signalPercentage);

  let wifiNozzleParentWidth = $("#wifiProgressBarParent").width();

  $("#wifiProgressBar").width((signalPercentage * wifiNozzleParentWidth) / 100);

  if (signalPercentage > 80) {
    $("#wifiProgressBar").css("background-color", "#51a34f");
  } else if (signalPercentage > 40) {
    $("#wifiProgressBar").css("background-color", "yellow");
  } else if (signalPercentage > 30) {
    $("#wifiProgressBar").css("background-color", "red");
  }

  if (currentState !== "RUNNING") {
    $("#wifiProgressBar").css("background-color", "grey");
  }

  $("#wifiValue").text(signalPercentage);
}

  function disableUI(){
    $("#wifiProgressBar").css("background-color", "grey");
  }

  function log(logText)
  {
    if (consoleLogging)
    {
      console.log(logText);
    }
  }
  
  const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))

// Pulled from GPT, my printer is VERY close to my router, so to make this more interesting,
// I have updated the maxSignal from -50 dBm to -40 dBm making it more difficult to reach max.

function dBmToPercentage(dBm) {
  // Define the minimum and maximum dBm values for mapping
  const minSignal = -100;
  const maxSignal = -50;

  // Ensure that dBm is within the defined range
  if (dBm < minSignal) {
    return 0; // Signal is weaker than -100 dBm
  } else if (dBm > maxSignal) {
    return 100; // Signal is stronger than -50 dBm
  }

  // Calculate the percentage based on the mapping
  const percentage = ((dBm - minSignal) / (maxSignal - minSignal)) * 100;

  return Math.round(percentage);
}

// Call the updateLog function to fetch and parse the data
setInterval(async () => {
  try {
    var telemetryObject = await retrieveData();
    telemetryObjectMain = telemetryObject;
    if (telemetryObject != null) {
      if (telemetryObject != "Incomplete"){
        await updateWifi(telemetryObject);
      }
    }
    else if (telemetryObject != "Incomplete")
    {
      // Data is incomplete, but we did get something, just skip for now
    }else
    {
      disableUI();
    }

  } catch (error) {
    //console.error(error);
    await sleep(1000);
  }
}, 1000);