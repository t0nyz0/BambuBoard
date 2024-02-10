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
let tempSetting = "Fahrenheit"; // Celsius or Both
let telemetryObjectMain;

async function loadSettings() {
  try {
      const serverURL = window.location.hostname;
      const response = await fetch('http://' + serverURL + ':3000/settings');
      if (response.ok) {
          const data = await response.json();
          tempSetting = data;
      } 
  } catch (error) {
      console.error('Error loading settings:', error);
  }
}

loadSettings();

async function retrieveData() {
  // Setting: Point this URL to your local server that is generating the telemetry data from Bambu
  const response = await fetch(
    "http://" + serverURL + ":" + window.location.port + "/data.json"
  );

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

async function updateAMS(telemetryObject) {
  /// AMS

  // AMS Humidity
  let amsHumidity = telemetryObject.ams.ams[0].humidity;
  //let amsHumidity = "1";



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

amsTempPercentage = (telemetryObject.ams.ams[0].temp / 60) * 100;

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
var amsCurrentTemp = (telemetryObject.ams.ams[0].temp * 9) / 5 + 32;
amsCurrentTemp = parseFloat(amsCurrentTemp.toFixed(1));
$("#amsCurrentTempF").text(amsCurrentTemp);
$("#amsCurrentTempC").text(telemetryObject.ams.ams[0].temp);

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
  if (tempSetting === "Fahrenheit")
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
  else if (tempSetting === "Celsius")
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
  else if (tempSetting === "Both")
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

  let amsHumidity = telemetryObject.ams.ams[0].humidity;
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
