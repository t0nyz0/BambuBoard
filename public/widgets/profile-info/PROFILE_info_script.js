// BambuBoard
// TZ | 11/28/24

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
  } catch (error) {
    //console.error(error);
    await sleep(5000);
  }
}, 1000);

async function executeTask() {
  try {
    var telemetryObject = telemetryObjectMain;
    if (telemetryObject != null && telemetryObject != "Incomplete") {
      if (
        (telemetryObject.layer_num == 0 && currentState == "RUNNING") ||
        modelImage == ""
      ) {
        await get_profile_info();
      }
    } else if (telemetryObject == null) {
      await get_profile_info();
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
  }, 600000);
})();

// Send credentials to your own server
async function get_profile_info() {
  try {
    const response = await fetch(fullServerURL + "/profile-info", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    const data = await response.json();

    // Display the image using the extracted URL
    displayAPIData(data);
  } catch (error) {
    console.error("Error:", error);
  }

  function displayAPIData(data) {
    const imageElement = $("#profileAvatar").attr("src", data.avatar);
    $("#modelImage").show();

    $("#profileHandle").text(data.handle);
    $("#profileFanCount").text(data.fanCount);
    $("#profileFollowCount").text(data.followCount);
    $("#profileLikeCount").text(data.likeCount);
    $("#profileCollectionCount").text(data.collectionCount);
    $("#profileDownloadCount").text(data.downloadCount);
    $("#profileBoostGained").text(data.boostGained);
  }
}
