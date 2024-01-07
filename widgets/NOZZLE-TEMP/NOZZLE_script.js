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
  const response = await fetch("http://" + serverURL + ":" + window.location.port + "/data.json");

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

async function updateUI(telemetryObject) {
  try {
    
    let printStatus = telemetryObject.gcode_state;
  
    let modelName = telemetryObject.gcode_file;
    modelName = modelName.replace("/data/Metadata/", "");

    $("#printModelName").text(telemetryObject.subtask_name);
    $("#printCurrentLayer").text(
      telemetryObject.layer_num + " of " + telemetryObject.total_layer_num
    );

    if (printStatus === "RUNNING") {
      printStatus = "Printing";
    } else if (printStatus === "FINISH") {
      printStatus = "Print Complete";
    } else if (printStatus === "FAILED") {

    }


    /// Nozzle Temp

    let nozzleTargetTemp = 0;
    let nozzleTempPercentage = 1;

    if (telemetryObject.nozzle_target_temper === 0) {
      nozzleTargetTemp = "OFF";
    } else {
      nozzleTargetTemp = (telemetryObject.nozzle_target_temper * 9) / 5 + 32;
      nozzleTempPercentage =
        (telemetryObject.nozzle_temper / telemetryObject.nozzle_target_temper) *
        100;
    }

    if (nozzleTempPercentage > 100) {
      log(
        "Nozzle percentage over 100, adjusting..." + nozzleTempPercentage
      );
      nozzleTempPercentage = 100;
    }

    log("nozzleTargetTemp = " + nozzleTargetTemp);
    log("nozzleTempPercentage = " + nozzleTempPercentage);

    // Set target temp in UI
    $("#nozzleTargetTemp").text(nozzleTargetTemp);

    // Set current temp in UI
    var nozzleCurrentTemp = (telemetryObject.nozzle_temper * 9) / 5 + 32;
    $("#nozzleCurrentTemp").text(nozzleCurrentTemp);

    log("nozzleCurrentTemp = " + nozzleCurrentTemp);

    let progressNozzleParentWidth = $("#nozzleProgressBarParent").width();
    log("progressNozzleParentWidth = " + progressNozzleParentWidth);
    $("#nozzleProgressBar").width(
      (nozzleTempPercentage * progressNozzleParentWidth) / 100
    );

    if (nozzleTargetTemp === "OFF") {
      $("#nozzleProgressBar").css("background-color", "grey");
      $("#nozzleTargetTempTempSymbols").hide();
    } else {
      $("#nozzleTargetTempTempSymbols").show();
      if (nozzleTempPercentage > 80) {
        $("#nozzleProgressBar").css("background-color", "red");
      } else if (nozzleTempPercentage > 50) {
        $("#nozzleProgressBar").css("background-color", "yellow");
      } else {
        $("#nozzleProgressBar").css("background-color", "#51a34f");
      }
    }

    log(telemetryObject.t_utc);
    return telemetryObject;
  } catch (error) {
    console.error("Error: ", error);
  }
}


  function disableUI(){
    $("#nozzleProgressBar").css("background-color", "grey");
    $("#nozzleTargetTempTempSymbols").hide();
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
    if (telemetryObject != null) {
      if (telemetryObject != "Incomplete"){
        await updateUI(telemetryObject);
      }
    }
    else if (telemetryObject != "Incomplete")
    {
      // Data is incomplete, but we did get something, just skip for now
    }else
    {
      disableUI();
    }

  } catch (error) {
    //console.error(error);
    await sleep(1000);
  }
}, 1000);
