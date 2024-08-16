//-------------------------------------------------------------------------------------------------------------
/// Configure your settings here:

const serverURL = window.location.hostname; // IP of the computer running this dashboard
const serverPort = window.location.port;

// Note: If set to 127.0.0.1 you will not be able to view your plate image, weight or total prints.
//       Those features will only work if viewing the dashboard locally.

//-------------------------------------------------------------------------------------------------------------

// -- Dont touch below

// BambuBoard
// TZ | 11/20/23

let currentState = "OFF";
let printModelName = "";
const consoleLogging = false;
let telemetryObjectMain;

async function retrieveData() {
  // Setting: Point this URL to your local server that is generating the telemetry data from Bambu
  const response = await fetch(
    "http://" + serverURL + ":" + serverPort + "/data.json"
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

async function updateUI(telemetryObject) {
  try {
    let printStatus = telemetryObject.gcode_state;

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

    let modelName = telemetryObject.gcode_file;
    modelName = modelName.replace("/data/Metadata/", "");

    $("#printModelName").text(telemetryObject.subtask_name);
    $("#printCurrentLayer").text(
      telemetryObject.layer_num + " of " + telemetryObject.total_layer_num
    );

    if (printStatus === "RUNNING") {
      printStatus = "Printing";

      let readableTimeRemaining = convertMinutesToReadableTime(
        telemetryObject.mc_remaining_time
      );

      if (readableTimeRemaining == 0) {
        readableTimeRemaining = "...";
      }

      $("#printRemaining").text(readableTimeRemaining);
      $("#printETA").text(formattedTime);
    } else if (printStatus === "FINISH") {
      printStatus = "Print Complete";

      $("#printRemaining").text(telemetryObject.mc_remaining_time);
      $("#printETA").text("Done");
      $("#printRemaining").text("...");
    } else if (printStatus === "FAILED") {
      $("#printRemaining").text(telemetryObject.mc_remaining_time);
      $("#printETA").text("");
      $("#printRemaining").text("...");
    }

    log(telemetryObject.t_utc);
    return telemetryObject;
  } catch (error) {
    console.error("Error: ", error);
  }
}

function disableUI() {}

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

async function executeTask() {
  try {
      var telemetryObject = telemetryObjectMain;
      if (telemetryObject != null && telemetryObject != "Incomplete") {
          if (telemetryObject.layer_num == 0 && currentState == "RUNNING" || printModelName == "") {
              await loginAndFetchImage();
          }
      } 
      else if (telemetryObject == null){
        await loginAndFetchImage();
      }
  } catch (error) {
      //console.error(error);
      await sleep(12000);
  }
}

// Run the task immediately
executeTask();

// Then set it to run at intervals
(function scheduleTask() {
  setTimeout(() => {
      executeTask();
      scheduleTask(); // Reschedule the next run
  }, 5000);
})();


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

// Send credentials to your own server
async function loginAndFetchImage() {
  try {
    const response = await fetch(
      "http://" + serverURL + ':' + serverPort + "/login-and-fetch-image",
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }
    );

    const data = await response.json();

    // Display the image using the extracted URL
    displayAPIData(data);
  } catch (error) {
    console.error("Error:", error);
  }

  function displayAPIData(data) {
    if (data.imageUrl == "NOTENROLLED") {
    } else {
      if (data.printModelName !== null) {
        printModelName = data.modelTitle;
        if ($("#printModelName").text() != data.modelTitle) {
          $("#printModelName2").text(" | " + data.modelTitle);
        } else {
          $("#printModelName2").text("");
        }
        $("#modelWeight").text(data.modelWeight + "g");

        $("#totalPrints").text(data.totalPrints);
      }
    }
  }
}
