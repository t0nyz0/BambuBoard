// BambuBoard
// TZ | 11/20/23

//-------------------------------------------------------------------------------------------------------------
const protocol = window.location.protocol; // 'http:' or 'https:'
const serverURL = window.location.hostname; // IP of the computer running this dashboard
const serverPort = window.location.port;
//-------------------------------------------------------------------------------------------------------------

let currentState = "OFF";
let totalPrints = "";
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

async function updateUI(telemetryObject) {
  try {
    /// Nozzle
    var nozzleType = telemetryObject.nozzle_type;
    var nozzleSize = telemetryObject.nozzle_diameter;
    var printSpeed = telemetryObject.spd_lvl;

    if (nozzleType === "hardened_steel") {
      nozzleType = "Hardened Steel";
    }

    $("#nozzleType").text(nozzleType);
    $("#nozzleSize").text(nozzleSize);

    //printSpeed
    if (printSpeed === 1) {
      $("#printSpeed").css("color", "green");
      $("#printSpeed").text("Silent");
    } else if (printSpeed === 2) {
      $("#printSpeed").css("color", "#51a34f");
      $("#printSpeed").text("Normal");
    } else if (printSpeed === 3) {
      $("#printSpeed").text("Sport");
      $("#printSpeed").css("color", "yellow");
    } else if (printSpeed === 4) {
      $("#printSpeed").text("Ludicrous");
      $("#printSpeed").css("color", "red");
    } else {
      $("#printSpeed").text(printSpeed);
      $("#printSpeed").css("color", "grey");
    }

    if (currentState !== "RUNNING") {
      $("#printSpeed").css("color", "grey");
    }

    log(telemetryObject.t_utc);
    return telemetryObject;
  } catch (error) {
    console.error("Error: ", error);
  }
}

function disableUI() {
  $("#printSpeed").css("color", "grey");
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
async function executeTask() {
  try {
      var telemetryObject = telemetryObjectMain;
      if (telemetryObject != null && telemetryObject != "Incomplete") {
          if (telemetryObject.layer_num == 0 && currentState == "RUNNING" || totalPrints == "") {
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
  }, 10000);
})();

  // Send credentials to your own server
  async function loginAndFetchImage() {
    try {

        const response =  await fetch(fullServerURL + '/login-and-fetch-image', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
  
        const data = await response.json();

        
        // Display the image using the extracted URL
        displayAPIData(data);

    } catch (error) {
        console.error('Error:', error);
    }
  }
  
  function displayAPIData(data) {
    if (data.imageUrl == "NOTENROLLED") {
    } else {
      if (data.modelWeight !== null) {
        totalPrints = data.totalPrints;
        $("#deviceName").text(data.deviceName);
        $("#deviceModel").text(data.deviceModel);

        if(data.bedType == "textured_plate")
        {
          $("#bedType").text("PEI Textured Plate");
        }
        else if(data.bedType == "cool_plate")
        {
          $("#bedType").text("Cool Plate");
        }
        else if(data.bedType == "hot_plate")
        {
          $("#bedType").text("PEI Smooth Plate");
        }
        else
        {
          $("#bedType").text(data.bedType);
        }
        
        $("#totalPrints").text(data.totalPrints);
      }
    }
  }