// BambuBoard
// TZ | 11/20/23

//-------------------------------------------------------------------------------------------------------------
const protocol = window.location.protocol; // 'http:' or 'https:'
const serverURL = window.location.hostname; // IP of the computer running this dashboard
const serverPort = window.location.port;
//-------------------------------------------------------------------------------------------------------------

let currentState = "OFF";
let printModelName = "";
const consoleLogging = false;
let telemetryObjectMain;
let lastFetchTime = 0; // Timestamp of the last fetch
let lastNoteTime = 0; // Timestamp of the last note save
const fetchInterval = 240000; // 4 minutes interval in milliseconds
const noteInterval = 900000; // 10 minutes interval for note saving
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

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

      const currentTime = new Date().getTime();

      // Save note only when printing first starts or if it hasn't been updated recently
      if (currentTime - lastNoteTime > noteInterval && telemetryObject.layer_num === 0 && currentState === "RUNNING") {
        await saveNote(telemetryObject.subtask_name);
        lastNoteTime = currentTime;
      }

      // Ensure saveNote and loginAndFetchImage only run every 4 minutes
      if (currentTime - lastFetchTime > fetchInterval) {
        await loginAndFetchImage();
        lastFetchTime = currentTime;
      }
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
  return localTime.toLocaleString();
}

function log(logText) {
  if (consoleLogging) {
    console.log(logText);
  }
}

async function saveNote(data) {
  try {
    const response = await fetch(fullServerURL + '/note', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: data })
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

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
    await sleep(1000);
  }
}, 1000);

async function executeTask() {
  try {
    var telemetryObject = telemetryObjectMain;
    const currentTime = new Date().getTime();

    if (telemetryObject != null && telemetryObject != "Incomplete") {
      if (telemetryObject.layer_num === 0 && currentState === "RUNNING" && printModelName === "") {
        if (currentTime - lastNoteTime > noteInterval) {
          await saveNote(telemetryObject.subtask_name);
          lastNoteTime = currentTime;
        }
        if (currentTime - lastFetchTime > fetchInterval) {
          await loginAndFetchImage();
          lastFetchTime = currentTime;
        }
      }
    } else if (telemetryObject == null){
      await loginAndFetchImage();
    }
  } catch (error) {
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
    const response = await fetch(fullServerURL + "/login-and-fetch-image",
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
