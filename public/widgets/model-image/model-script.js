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
let calibration = false;
let modelGeneration = 0;
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

async function retrieveData() {
  const response = await fetch(fullServerURL + "/data.json", { signal: AbortSignal.timeout(5000) });

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

  function convertUtc(timestampUtcMs) {
    var localTime = new Date(timestampUtcMs);

    // Formatting the date to a readable string in local time
    return localTime.toLocaleString();
  } 
  function log(logText)
  {
    if (consoleLogging)
    {
      console.log(logText);
    }
  }
  
  const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))

// Call the updateLog function to fetch and parse the data
async function refreshTelemetry() {
  try {
    const telemetryObject = await retrieveData();
    telemetryObjectMain = telemetryObject;
    // Incomplete reports cannot restore the image of the preceding model.
    if (!telemetryObject || telemetryObject === 'Incomplete' || telemetryObject._bb_job_pending) return;
    const isCalibration = BBGcodeJob.describe(telemetryObject).calibration;
    if (isCalibration === calibration) return;
    calibration = isCalibration;
    modelGeneration++;
    if (calibration) {
      modelImage = '';
      $('#modelImage').hide().removeAttr('src');
    } else {
      void executeTask();
    }
  } catch (error) {
    //console.error(error);
    await sleep(1000);
  }
}

async function pollTelemetry() {
  await refreshTelemetry();
  setTimeout(pollTelemetry, 1000);
}

async function executeTask() {
  if (calibration) return;
  try {
      var telemetryObject = telemetryObjectMain;
      if (telemetryObject != null && telemetryObject != "Incomplete") {
          if (telemetryObject.layer_num == 0 && currentState == "RUNNING" || modelImage == "") {
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

// Confirm the current print before requesting cloud model data.
pollTelemetry().then(executeTask);

// Then set it to run at intervals
(function scheduleTask() {
  setTimeout(() => {
      executeTask();
      scheduleTask(); // Reschedule the next run
  }, 5000);
})();

  // Send credentials to your own server
  async function loginAndFetchImage() {
    const generation = modelGeneration;
    try {
        const response =  await fetch(fullServerURL + '/login-and-fetch-image', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
  
        if (generation !== modelGeneration || calibration) return;
        let data;

        if (response.status == 401)
        {
          window.location.href = 'login.html';
        }
        else
        {
          data = await response.json();
        }

        if (generation !== modelGeneration || calibration) return;
        // Display the image using the extracted URL
        displayAPIData(data);

    } catch (error) {
        console.error('Error:', error);
    }
  
  
  function displayAPIData(data) {

    if (data.imageUrl == "NOTENROLLED")
    {
      $('#modelImage').hide();
    }
    else
    {
      const imageElement = $('#modelImage').attr('src', data.imageUrl);
      $('#modelImage').show();
      modelImage = data.imageUrl;
    }

  }
 }
