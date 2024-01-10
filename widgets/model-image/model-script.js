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
setInterval(async () => {
  try {
    var telemetryObject = await retrieveData();
    telemetryObjectMain = telemetryObject;
  } catch (error) {
    //console.error(error);
    await sleep(1000);
  }
}, 1000);

async function executeTask() {
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

// Run the task immediately
executeTask();

// Then set it to run at intervals
(function scheduleTask() {
  setTimeout(() => {
      executeTask();
      scheduleTask(); // Reschedule the next run
  }, 5000);
})();


  // Send credentials to your own server
  async function loginAndFetchImage() {
    try {
        const response =  await fetch('http://' + serverURL + ':3000/login-and-fetch-image', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
  
        const data = await response.json();

        
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
