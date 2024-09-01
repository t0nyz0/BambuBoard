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

// Preferences
let displayFanPercentages = true; // Use percentages instead of icons for the fans
let displayFanIcons = true; // Use percentages instead of icons for the fans

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

  function convertToPercentage(value) {
    if (value < 0 || value > 15) {
      return 0;
    }
    let percentage = (value / 15) * 100;
    return percentage.toFixed(2) + "%";
  }

async function loadPreferences() {
  try {
      const serverURL = window.location.hostname;
      const response = await fetch(fullServerURL +'/preference-fan-icons');
      if (response.ok) {
          const data = await response.json();
          displayFanIcons = data;
      } 

      const response2 = await fetch(fullServerURL + '/preference-fan-percentages');
      if (response.ok) {

          const data = await response2.json();

          console.log(data);
          displayFanPercentages = data;
      } 
  } catch (error) {
      console.error('Error loading preferences:', error);
  }
}

async function updateFans(telemetryObject) {
  try {
    /// Update preferences 
    if (displayFanIcons == true || displayFanIcons == "true")
      {
        $("#fan1").show();
        $("#fan2").show();
        $("#fan3").show();
        $("#fan4").show();
      }
      else
      {
        $("#fan1").hide();
        $("#fan2").hide();
        $("#fan3").hide();
        $("#fan4").hide();
      }
    if (displayFanPercentages == true || displayFanPercentages == "true")
    {
      $("#fan1-percent").show();
      $("#fan2-percent").show();
      $("#fan3-percent").show();
      $("#fan4-percent").show();
    }
    else
    {
      $("#fan1-percent").hide();
      $("#fan2-percent").hide();
      $("#fan3-percent").hide();
      $("#fan4-percent").hide();
    }

    /// Fans
    let fan1Speed = telemetryObject.big_fan1_speed;
    let fan2Speed = telemetryObject.big_fan2_speed;
    let fan3Speed = telemetryObject.cooling_fan_speed;
    let fan4Speed = telemetryObject.heatbreak_fan_speed;

    // Fan 1
    $("#fan1-percent").text(convertToPercentage(fan1Speed));

    switch (fan1Speed) {
      case "0":
        $("#fan1").css({ "-webkit-animation": "" });
        break;
      case "1":
        updateAnimation("#fan1", "spin 5s infinite linear");
        break;
      case "2":
        updateAnimation("#fan1", "spin 4.5s infinite linear");
        break;
      case "3":
        updateAnimation("#fan1", "spin 4s infinite linear");
        break;
      case "4":
        updateAnimation("#fan1", "spin 3.5s infinite linear");
        break;
      case "5":
        updateAnimation("#fan1", "spin 3s infinite linear");
        break;
      case "6":
        updateAnimation("#fan1", "spin 2.5s infinite linear");
        break;
      case "7":
        updateAnimation("#fan1", "spin 2s infinite linear");
        break;
      case "8":
        updateAnimation("#fan1", "spin 1.8s infinite linear");
        break;
      case "9":
        updateAnimation("#fan1", "spin 1.5s infinite linear");
        break;
      case "10":
        updateAnimation("#fan1", "spin 1.2s infinite linear");
        break;
      case "11":
        updateAnimation("#fan1", "spin 1.0s infinite linear");
        break;
      case "12":
        updateAnimation("#fan1", "spin .5s infinite linear");
        break;
      case "13":
        updateAnimation("#fan1", "spin .45s infinite linear");
        break;
      case "14":
        updateAnimation("#fan1", "spin .4s infinite linear");
        break;
      case "15":
        updateAnimation("#fan1", "spin .37s infinite linear");
        break;
      default:
        break;
    }

    // Fan 2
    $("#fan2-percent").text(convertToPercentage(fan2Speed));

    switch (fan2Speed) {
      case "0":
        $("#fan2").css({ "-webkit-animation": "" });
        break;
      case "1":
        updateAnimation("#fan2", "spin 5s infinite linear");
        break;
      case "2":
        updateAnimation("#fan2", "spin 4.5s infinite linear");
        break;
      case "3":
        updateAnimation("#fan2", "spin 4s infinite linear");
        break;
      case "4":
        updateAnimation("#fan2", "spin 3.5s infinite linear");
        break;
      case "5":
        updateAnimation("#fan2", "spin 3s infinite linear");
        break;
      case "6":
        updateAnimation("#fan2", "spin 2.5s infinite linear");
        break;
      case "7":
        updateAnimation("#fan2", "spin 2s infinite linear");
        break;
      case "8":
        updateAnimation("#fan2", "spin 1.8s infinite linear");
        break;
      case "9":
        updateAnimation("#fan2", "spin 1.5s infinite linear");
        break;
      case "10":
        updateAnimation("#fan2", "spin 1.2s infinite linear");
        break;
      case "11":
        updateAnimation("#fan2", "spin 1.0s infinite linear");
        break;
      case "12":
        updateAnimation("#fan2", "spin .5s infinite linear");
        break;
      case "13":
        updateAnimation("#fan2", "spin .45s infinite linear");
        break;
      case "14":
        updateAnimation("#fan2", "spin .4s infinite linear");
        break;
      case "15":
        updateAnimation("#fan2", "spin .37s infinite linear");
        break;
      default:
        break;
    }

    // Fan 3
    $("#fan3-percent").text(convertToPercentage(fan3Speed));

    switch (fan3Speed) {
      case "0":
        $("#fan3").css({ "-webkit-animation": "" });
        break;
      case "1":
        updateAnimation("#fan3", "spin 5s infinite linear");
        break;
      case "2":
        updateAnimation("#fan3", "spin 4.5s infinite linear");
        break;
      case "3":
        updateAnimation("#fan3", "spin 4s infinite linear");
        break;
      case "4":
        updateAnimation("#fan3", "spin 3.5s infinite linear");
        break;
      case "5":
        updateAnimation("#fan3", "spin 3s infinite linear");
        break;
      case "6":
        updateAnimation("#fan3", "spin 2.5s infinite linear");
        break;
      case "7":
        updateAnimation("#fan3", "spin 2s infinite linear");
        break;
      case "8":
        updateAnimation("#fan3", "spin 1.8s infinite linear");
        break;
      case "9":
        updateAnimation("#fan3", "spin 1.5s infinite linear");
        break;
      case "10":
        updateAnimation("#fan3", "spin 1.2s infinite linear");
        break;
      case "11":
        updateAnimation("#fan3", "spin 1.0s infinite linear");
        break;
      case "12":
        updateAnimation("#fan3", "spin .5s infinite linear");
        break;
      case "13":
        updateAnimation("#fan3", "spin .45s infinite linear");
        break;
      case "14":
        updateAnimation("#fan3", "spin .4s infinite linear");
        break;
      case "15":
        updateAnimation("#fan3", "spin .37s infinite linear");
        break;
      default:
        break;
    }

    // Fan 4
    $("#fan4-percent").text(convertToPercentage(fan4Speed));

    switch (fan4Speed) {
      case "0":
        $("#fan4").css({ "-webkit-animation": "" });
        break;
      case "1":
        updateAnimation("#fan4", "spin 5s infinite linear");
        break;
      case "2":
        updateAnimation("#fan4", "spin 4.5s infinite linear");
        break;
      case "3":
        updateAnimation("#fan4", "spin 4s infinite linear");
        break;
      case "4":
        updateAnimation("#fan4", "spin 3.5s infinite linear");
        break;
      case "5":
        updateAnimation("#fan4", "spin 3s infinite linear");
        break;
      case "6":
        updateAnimation("#fan4", "spin 2.5s infinite linear");
        break;
      case "7":
        updateAnimation("#fan4", "spin 2s infinite linear");
        break;
      case "8":
        updateAnimation("#fan4", "spin 1.8s infinite linear");
        break;
      case "9":
        updateAnimation("#fan4", "spin 1.5s infinite linear");
        break;
      case "10":
        updateAnimation("#fan4", "spin 1.2s infinite linear");
        break;
      case "11":
        updateAnimation("#fan4", "spin 1.0s infinite linear");
        break;
      case "12":
        updateAnimation("#fan4", "spin .5s infinite linear");
        break;
      case "13":
        updateAnimation("#fan4", "spin .45s infinite linear");
        break;
      case "14":
        updateAnimation("#fan4", "spin .4s infinite linear");
        break;
      case "15":
        updateAnimation("#fan4", "spin .37s infinite linear");
        break;
      default:
        break;
    }
  } catch (error) {
    console.error("Error: ", error);
  }
}

function disableUI() {
  $("#fan1").removeClass("fan-spin-slow");
  $("#fan1").removeClass("fan-spin-slower");
  $("#fan1").removeClass("fan-spin-normal");
  $("#fan1").removeClass("fan-spin-fast");
  $("#fan1").removeClass("fan-spin-faster");
  $("#fan1").removeClass("fan-spin-veryfast");

  $("#fan2").removeClass("fan-spin-slow");
  $("#fan2").removeClass("fan-spin-slower");
  $("#fan2").removeClass("fan-spin-normal");
  $("#fan2").removeClass("fan-spin-fast");
  $("#fan2").removeClass("fan-spin-faster");
  $("#fan2").removeClass("fan-spin-veryfast");

  $("#fan3").removeClass("fan-spin-slow");
  $("#fan3").removeClass("fan-spin-slower");
  $("#fan3").removeClass("fan-spin-normal");
  $("#fan3").removeClass("fan-spin-fast");
  $("#fan3").removeClass("fan-spin-faster");
  $("#fan3").removeClass("fan-spin-veryfast");

  $("#fan4").removeClass("fan-spin-slow");
  $("#fan4").removeClass("fan-spin-slower");
  $("#fan4").removeClass("fan-spin-normal");
  $("#fan4").removeClass("fan-spin-fast");
  $("#fan4").removeClass("fan-spin-faster");
  $("#fan4").removeClass("fan-spin-veryfast");
}

function updateAnimation(selector, newValue) {
  var currentAnimation = $(selector).css("-webkit-animation");
  if (currentAnimation !== newValue) {
    $(selector).css({ "-webkit-animation": newValue });
  }
}

function convertToPercentage(value) {
  if (value < 0 || value > 15) {
    throw new Error("Value must be between 0 and 15");
  }
  let percentage = (value / 15) * 100;
  return percentage.toFixed(0) + "%"; // Returns percentage with '%' sign and 2 decimal places
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

loadPreferences();

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

// Call the updateLog function to fetch and parse the data
setInterval(async () => {
  try {
    var telemetryObject = await retrieveData();
    telemetryObjectMain = telemetryObject;
    if (telemetryObject != null) {
      if (telemetryObject != "Incomplete") {
        await updateFans(telemetryObject);
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

