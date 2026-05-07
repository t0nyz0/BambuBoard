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

async function retrieveData() {
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

    if (printStatus === "RUNNING") {
      printStatus = "Printing";
    } else if (printStatus === "FINISH") {
      printStatus = "Print Complete";
    } else if (printStatus === "FAILED") {
    }

    /// Chamber Temperature
    let chamberTargetTempF = 200;
    let chamberTargetTempC = 93;
    let chamberTempPercentage = 1;

    // Newer Bambu firmware (H2D) packs current+target into device.ctc.info.temp
    // (low 16 bits current, high 16 bits target). Legacy firmware uses the
    // top-level chamber_temper field. Read whichever one's present.
    var chamberC = null;
    var packed = telemetryObject.device && telemetryObject.device.ctc
                 && telemetryObject.device.ctc.info && telemetryObject.device.ctc.info.temp;
    if (typeof packed === 'number') {
      chamberC = packed & 0xFFFF;
    } else if (typeof telemetryObject.chamber_temper === 'number') {
      chamberC = telemetryObject.chamber_temper;
    }

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

function disableUI() {
  $("#chamberProgressBar").css("background-color", "grey");
  $("#chamberTargetTempTempSymbols").hide();
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
