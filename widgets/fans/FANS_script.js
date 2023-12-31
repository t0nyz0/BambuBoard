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

// Some issues were found lumping all the DOM updates into the updateUI() function, split fans into their own function.
async function updateFans(telemetryObject) {
  try {
    /// Fans
    let fan1Speed = telemetryObject.big_fan1_speed;
    let fan2Speed = telemetryObject.big_fan2_speed;
    let fan3Speed = telemetryObject.cooling_fan_speed;
    let fan4Speed = telemetryObject.heatbreak_fan_speed;

    // Fan 1
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
