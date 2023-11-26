// BambuBoard
// TZ | 11/20/23
//const mqtt = require('mqtt');
//const fs = require('fs');

let currentState = "OFF";

async function retrieveData() {
  // Setting: Point this URL to your local server that is generating the telemetry data from Bambu
  const response = await fetch("data.json");

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
    console.log(telemetryObject.ams.ams[0].humidity);
    console.log(telemetryObject.ams.ams[0].temp);

    let printStatus = telemetryObject.gcode_state;
    let progressParentWidth = $("#printParentProgressBar").width();

    // mc_remaining_time in minutes
    const mcRemainingTime = telemetryObject.mc_remaining_time;

    const now = new Date();
    const futureTime = new Date(now.getTime() + mcRemainingTime * 60 * 1000); // Convert minutes to milliseconds

    // Format the future_time as H:MMam/pm with no spaces
    const hour = futureTime.getHours();
    const minute = futureTime.getMinutes();
    const ampm = hour >= 12 ? "pm" : "am";

    const formattedTime = `${hour % 12}:${
      minute < 10 ? "0" : ""
    }${minute}${ampm}`;

    console.log(formattedTime);

    let modelName = telemetryObject.gcode_file;
    modelName = modelName.replace("/data/Metadata/", "");

    $("#printModelName").text(telemetryObject.subtask_name);
    $("#printCurrentLayer").text(
      telemetryObject.layer_num + "/" + telemetryObject.total_layer_num
    );

    if (printStatus === "RUNNING") {
      printStatus = "Printing";
      $("#printProgressBar").css("background-color", "#51a34f");
      $("#printStatus").text(
        printStatus + "... " + telemetryObject.mc_percent + "%"
      );
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printRemaining").text(telemetryObject.mc_remaining_time);
      $("#printETA").text("Around " + formattedTime);
    } else if (printStatus === "FINISH") {
      printStatus = "Print Complete";
      $("#printStatus").text(printStatus + "... ");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "grey");
      $("#printRemaining").text(telemetryObject.mc_remaining_time);
      $("#printETA").text("Done");
    } else if (printStatus === "FAILED") {
      $("#printStatus").text("Print failed" + "... ");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "#red");
      $("#printRemaining").text(telemetryObject.mc_remaining_time);
      $("#printETA").text("");
    }

    /// Bed Temp

    let bedTargetTemp = 0;
    let bedTempPercentage = 1;
    // Bed Target Temp
    if (telemetryObject.bed_target_temper === 0) {
      bedTargetTemp = "OFF";
    } else {
      bedTargetTemp = (telemetryObject.bed_target_temper * 9) / 5 + 32;
      bedTempPercentage =
        (telemetryObject.bed_temper / telemetryObject.bed_target_temper) * 100;
    }
    console.log("bedTargetTemp = " + bedTargetTemp);
    console.log("bedTempPercentage = " + bedTempPercentage);

    if (bedTempPercentage > 100) {
      console.log(
        "Bed percentage over 100, adjusting..." + nozzleTempPercentage
      );
      bedTempPercentage = 100;
    }

    // Set target temp in UI
    $("#bedTargetTemp").text(bedTargetTemp);

    // Set current temp in UI
    var bedCurrentTemp = (telemetryObject.bed_temper * 9) / 5 + 32;
    $("#bedCurrentTemp").text(bedCurrentTemp);
    console.log("bedCurrentTemp = " + bedCurrentTemp);
    let progressBedParentWidth = $("#bedProgressBarParent").width();
    console.log("progressBedParentWidth = " + progressBedParentWidth);
    $("#bedProgressBar").width(
      (bedTempPercentage * progressBedParentWidth) / 100
    );

    if (bedTargetTemp === "OFF") {
      $("#bedProgressBar").css("background-color", "grey");
      $("#bedTargetTempTempSymbols").hide();
    } else {
      $("#bedTargetTempTempSymbols").show();
      if (bedTempPercentage > 80) {
        $("#bedProgressBar").css("background-color", "red");
      } else if (bedTempPercentage > 50) {
        $("#bedProgressBar").css("background-color", "yellow");
      } else {
        $("#bedProgressBar").css("background-color", "#51a34f");
      }
    }

    /// Nozzle Temp

    let nozzleTargetTemp = 0;
    let nozzleTempPercentage = 1;
    // Bed Target Temp
    if (telemetryObject.nozzle_target_temper === 0) {
      nozzleTargetTemp = "OFF";
    } else {
      nozzleTargetTemp = (telemetryObject.nozzle_target_temper * 9) / 5 + 32;
      nozzleTempPercentage =
        (telemetryObject.nozzle_temper / telemetryObject.nozzle_target_temper) *
        100;
    }

    if (nozzleTempPercentage > 100) {
      console.log(
        "Nozzle percentage over 100, adjusting..." + nozzleTempPercentage
      );
      nozzleTempPercentage = 100;
    }

    console.log("nozzleTargetTemp = " + nozzleTargetTemp);
    console.log("nozzleTempPercentage = " + nozzleTempPercentage);

    // Set target temp in UI
    $("#nozzleTargetTemp").text(nozzleTargetTemp);

    // Set current temp in UI
    var nozzleCurrentTemp = (telemetryObject.nozzle_temper * 9) / 5 + 32;
    $("#nozzleCurrentTemp").text(nozzleCurrentTemp);

    console.log("nozzleCurrentTemp = " + nozzleCurrentTemp);

    let progressNozzleParentWidth = $("#nozzleProgressBarParent").width();
    console.log("progressNozzleParentWidth = " + progressNozzleParentWidth);
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

    /// Chamber Temperature
    let chamberTargetTemp = 140;
    let chamberTempPercentage = 1;
    // Bed Target Temp

    // Set target temp in UI
    $("#chamberTargetTemp").text(chamberTargetTemp);

    // Set current temp in UI
    var chamberCurrentTemp = (telemetryObject.chamber_temper * 9) / 5 + 32;
    $("#chamberCurrentTemp").text(chamberCurrentTemp);
    console.log("chamberCurrentTemp = " + chamberCurrentTemp);

    chamberTempPercentage = (chamberCurrentTemp / chamberTargetTemp) * 100;

    let progressChamberParentWidth = $("#chamberProgressBarParent").width();
    console.log("progressChamberParentWidth = " + progressChamberParentWidth);
    $("#chamberProgressBar").width(
      (chamberTempPercentage * progressChamberParentWidth) / 100
    );

    $("#chamberTargetTempTempSymbols").show();
    if (chamberCurrentTemp > 110) {
      $("#chamberProgressBar").css("background-color", "red");
    } else if (chamberCurrentTemp > 100) {
      $("#chamberProgressBar").css("background-color", "yellow");
    } else {
      $("#chamberProgressBar").css("background-color", "#51a34f");
    }

    if (currentState !== "RUNNING") {
      $("#chamberProgressBar").css("background-color", "grey");
    }

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

    console.log(telemetryObject.t_utc);
    return telemetryObject;
  } catch (error) {
    console.error("Error:", error);
  }
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

    if (fan1Speed === "0") {
      $("#fan1").removeClass("fan-spin-slow");
      $("#fan1").removeClass("fan-spin-slower");
      $("#fan1").removeClass("fan-spin-normal");
      $("#fan1").removeClass("fan-spin-fast");
      $("#fan1").removeClass("fan-spin-faster");
      $("#fan1").removeClass("fan-spin-veryfast");
    } else {
      if (fan1Speed === "1" || fan1Speed === "2") {
        if (!$("#fan1").hasClass("fan-spin-slow")) {
          $("#fan1").addClass("fan-spin-slow");
          $("#fan1").removeClass("fan-spin-slower");
          $("#fan1").removeClass("fan-spin-normal");
          $("#fan1").removeClass("fan-spin-fast");
          $("#fan1").removeClass("fan-spin-faster");
          $("#fan1").removeClass("fan-spin-veryfast");
        }
      } else if (fan1Speed === "3" || fan1Speed === "4") {
        if (!$("#fan1").hasClass("fan-spin-slower")) {
          $("#fan1").addClass("fan-spin-slower");
          $("#fan1").removeClass("fan-spin-slow");
          $("#fan1").removeClass("fan-spin-normal");
          $("#fan1").removeClass("fan-spin-fast");
          $("#fan1").removeClass("fan-spin-faster");
          $("#fan1").removeClass("fan-spin-veryfast");
        }
      } else if (fan1Speed === "5" || fan1Speed === "6") {
        if (!$("#fan1").hasClass("fan-spin-normal")) {
          $("#fan1").addClass("fan-spin-normal");
          $("#fan1").removeClass("fan-spin-slower");
          $("#fan1").removeClass("fan-spin-slow");
          $("#fan1").removeClass("fan-spin-fast");
          $("#fan1").removeClass("fan-spin-faster");
          $("#fan1").removeClass("fan-spin-veryfast");
        }
      } else if (fan1Speed === "7" || fan1Speed === "8" || fan1Speed === "9") {
        if (!$("#fan1").hasClass("fan-spin-fast")) {
          $("#fan1").addClass("fan-spin-fast");
          $("#fan1").removeClass("fan-spin-slower");
          $("#fan1").removeClass("fan-spin-slow");
          $("#fan1").removeClass("fan-spin-normal");
          $("#fan1").removeClass("fan-spin-faster");
          $("#fan1").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan1Speed === "10" ||
        fan1Speed === "11" ||
        fan1Speed === "12"
      ) {
        if (!$("#fan1").hasClass("fan-spin-faster")) {
          $("#fan1").addClass("fan-spin-faster");
          $("#fan1").removeClass("fan-spin-slower");
          $("#fan1").removeClass("fan-spin-slow");
          $("#fan1").removeClass("fan-spin-fast");
          $("#fan1").removeClass("fan-spin-normal");
          $("#fan1").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan1Speed === "13" ||
        fan1Speed === "14" ||
        fan1Speed === "15"
      ) {
        if (!$("#fan1").hasClass("fan-spin-veryfast")) {
          $("#fan1").addClass("fan-spin-veryfast");
          $("#fan1").removeClass("fan-spin-slower");
          $("#fan1").removeClass("fan-spin-slow");
          $("#fan1").removeClass("fan-spin-fast");
          $("#fan1").removeClass("fan-spin-normal");
          $("#fan1").removeClass("fan-spin-faster");
        }
      }
    }

    // Fan 2
    if (fan2Speed === "0") {
      $("#fan2").removeClass("fan-spin-slow");
      $("#fan2").removeClass("fan-spin-slower");
      $("#fan2").removeClass("fan-spin-normal");
      $("#fan2").removeClass("fan-spin-fast");
      $("#fan2").removeClass("fan-spin-faster");
      $("#fan2").removeClass("fan-spin-veryfast");
    } else {
      if (fan2Speed === "1" || fan2Speed === "2") {
        if (!$("#fan2").hasClass("fan-spin-slow")) {
          $("#fan2").addClass("fan-spin-slow");
          $("#fan2").removeClass("fan-spin-slower");
          $("#fan2").removeClass("fan-spin-normal");
          $("#fan2").removeClass("fan-spin-fast");
          $("#fan2").removeClass("fan-spin-faster");
          $("#fan2").removeClass("fan-spin-veryfast");
        }
      } else if (fan2Speed === "3" || fan2Speed === "4") {
        if (!$("#fan2").hasClass("fan-spin-slower")) {
          $("#fan2").addClass("fan-spin-slower");
          $("#fan2").removeClass("fan-spin-slow");
          $("#fan2").removeClass("fan-spin-normal");
          $("#fan2").removeClass("fan-spin-fast");
          $("#fan2").removeClass("fan-spin-faster");
          $("#fan2").removeClass("fan-spin-veryfast");
        }
      } else if (fan2Speed === "5" || fan2Speed === "6") {
        if (!$("#fan2").hasClass("fan-spin-normal")) {
          $("#fan2").addClass("fan-spin-normal");
          $("#fan2").removeClass("fan-spin-slower");
          $("#fan2").removeClass("fan-spin-slow");
          $("#fan2").removeClass("fan-spin-fast");
          $("#fan2").removeClass("fan-spin-faster");
          $("#fan2").removeClass("fan-spin-veryfast");
        }
      } else if (fan2Speed === "7" || fan2Speed === "8" || fan2Speed === "9") {
        if (!$("#fan2").hasClass("fan-spin-fast")) {
          $("#fan2").addClass("fan-spin-fast");
          $("#fan2").removeClass("fan-spin-slower");
          $("#fan2").removeClass("fan-spin-slow");
          $("#fan2").removeClass("fan-spin-normal");
          $("#fan2").removeClass("fan-spin-faster");
          $("#fan2").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan2Speed === "10" ||
        fan2Speed === "11" ||
        fan2Speed === "12"
      ) {
        if (!$("#fan2").hasClass("fan-spin-faster")) {
          $("#fan2").addClass("fan-spin-faster");
          $("#fan2").removeClass("fan-spin-slower");
          $("#fan2").removeClass("fan-spin-slow");
          $("#fan2").removeClass("fan-spin-fast");
          $("#fan2").removeClass("fan-spin-normal");
          $("#fan2").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan2Speed === "13" ||
        fan2Speed === "14" ||
        fan2Speed === "15"
      ) {
        if (!$("#fan2").hasClass("fan-spin-veryfast")) {
          $("#fan2").addClass("fan-spin-veryfast");
          $("#fan2").removeClass("fan-spin-slower");
          $("#fan2").removeClass("fan-spin-slow");
          $("#fan2").removeClass("fan-spin-fast");
          $("#fan2").removeClass("fan-spin-normal");
          $("#fan2").removeClass("fan-spin-faster");
        }
      }
    }

    // Fan 3
    if (fan3Speed === "0") {
      $("#fan3").removeClass("fan-spin-slow");
      $("#fan3").removeClass("fan-spin-slower");
      $("#fan3").removeClass("fan-spin-normal");
      $("#fan3").removeClass("fan-spin-fast");
      $("#fan3").removeClass("fan-spin-faster");
      $("#fan3").removeClass("fan-spin-veryfast");
    } else {
      if (fan3Speed === "1" || fan3Speed === "2") {
        if (!$("#fan3").hasClass("fan-spin-slow")) {
          $("#fan3").addClass("fan-spin-slow");
          $("#fan3").removeClass("fan-spin-slower");
          $("#fan3").removeClass("fan-spin-normal");
          $("#fan3").removeClass("fan-spin-fast");
          $("#fan3").removeClass("fan-spin-faster");
          $("#fan3").removeClass("fan-spin-veryfast");
        }
      } else if (fan3Speed === "3" || fan3Speed === "4") {
        if (!$("#fan3").hasClass("fan-spin-slower")) {
          $("#fan3").addClass("fan-spin-slower");
          $("#fan3").removeClass("fan-spin-slow");
          $("#fan3").removeClass("fan-spin-normal");
          $("#fan3").removeClass("fan-spin-fast");
          $("#fan3").removeClass("fan-spin-faster");
          $("#fan3").removeClass("fan-spin-veryfast");
        }
      } else if (fan3Speed === "5" || fan3Speed === "6") {
        if (!$("#fan3").hasClass("fan-spin-normal")) {
          $("#fan3").addClass("fan-spin-normal");
          $("#fan3").removeClass("fan-spin-slower");
          $("#fan3").removeClass("fan-spin-slow");
          $("#fan3").removeClass("fan-spin-fast");
          $("#fan3").removeClass("fan-spin-faster");
          $("#fan3").removeClass("fan-spin-veryfast");
        }
      } else if (fan3Speed === "7" || fan3Speed === "8" || fan3Speed === "9") {
        if (!$("#fan3").hasClass("fan-spin-fast")) {
          $("#fan3").addClass("fan-spin-fast");
          $("#fan3").removeClass("fan-spin-slower");
          $("#fan3").removeClass("fan-spin-slow");
          $("#fan3").removeClass("fan-spin-normal");
          $("#fan3").removeClass("fan-spin-faster");
          $("#fan3").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan3Speed === "10" ||
        fan3Speed === "11" ||
        fan3Speed === "12"
      ) {
        if (!$("#fan3").hasClass("fan-spin-faster")) {
          $("#fan3").addClass("fan-spin-faster");
          $("#fan3").removeClass("fan-spin-slower");
          $("#fan3").removeClass("fan-spin-slow");
          $("#fan3").removeClass("fan-spin-fast");
          $("#fan3").removeClass("fan-spin-normal");
          $("#fan3").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan3Speed === "13" ||
        fan3Speed === "14" ||
        fan3Speed === "15"
      ) {
        if (!$("#fan3").hasClass("fan-spin-veryfast")) {
          $("#fan3").addClass("fan-spin-veryfast");
          $("#fan3").removeClass("fan-spin-slower");
          $("#fan3").removeClass("fan-spin-slow");
          $("#fan3").removeClass("fan-spin-fast");
          $("#fan3").removeClass("fan-spin-normal");
          $("#fan3").removeClass("fan-spin-faster");
        }
      }
    }

    // Fan 4
    if (fan4Speed === "0") {
      $("#fan4").removeClass("fan-spin-slow");
      $("#fan4").removeClass("fan-spin-slower");
      $("#fan4").removeClass("fan-spin-normal");
      $("#fan4").removeClass("fan-spin-fast");
      $("#fan4").removeClass("fan-spin-faster");
      $("#fan4").removeClass("fan-spin-veryfast");
    } else {
      if (fan4Speed === "1" || fan4Speed === "2") {
        if (!$("#fan4").hasClass("fan-spin-slow")) {
          $("#fan4").addClass("fan-spin-slow");
          $("#fan4").removeClass("fan-spin-slower");
          $("#fan4").removeClass("fan-spin-normal");
          $("#fan4").removeClass("fan-spin-fast");
          $("#fan4").removeClass("fan-spin-faster");
          $("#fan4").removeClass("fan-spin-veryfast");
        }
      } else if (fan4Speed === "3" || fan4Speed === "4") {
        if (!$("#fan4").hasClass("fan-spin-slower")) {
          $("#fan4").addClass("fan-spin-slower");
          $("#fan4").removeClass("fan-spin-slow");
          $("#fan4").removeClass("fan-spin-normal");
          $("#fan4").removeClass("fan-spin-fast");
          $("#fan4").removeClass("fan-spin-faster");
          $("#fan4").removeClass("fan-spin-veryfast");
        }
      } else if (fan4Speed === "5" || fan4Speed === "6") {
        if (!$("#fan4").hasClass("fan-spin-normal")) {
          $("#fan4").addClass("fan-spin-normal");
          $("#fan4").removeClass("fan-spin-slower");
          $("#fan4").removeClass("fan-spin-slow");
          $("#fan4").removeClass("fan-spin-fast");
          $("#fan4").removeClass("fan-spin-faster");
          $("#fan4").removeClass("fan-spin-veryfast");
        }
      } else if (fan4Speed === "7" || fan4Speed === "8" || fan4Speed === "9") {
        if (!$("#fan4").hasClass("fan-spin-fast")) {
          $("#fan4").addClass("fan-spin-fast");
          $("#fan4").removeClass("fan-spin-slower");
          $("#fan4").removeClass("fan-spin-slow");
          $("#fan4").removeClass("fan-spin-normal");
          $("#fan4").removeClass("fan-spin-faster");
          $("#fan4").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan4Speed === "10" ||
        fan4Speed === "11" ||
        fan4Speed === "12"
      ) {
        if (!$("#fan4").hasClass("fan-spin-faster")) {
          $("#fan4").addClass("fan-spin-faster");
          $("#fan4").removeClass("fan-spin-slower");
          $("#fan4").removeClass("fan-spin-slow");
          $("#fan4").removeClass("fan-spin-fast");
          $("#fan4").removeClass("fan-spin-normal");
          $("#fan4").removeClass("fan-spin-veryfast");
        }
      } else if (
        fan4Speed === "13" ||
        fan4Speed === "14" ||
        fan4Speed === "15"
      ) {
        if (!$("#fan4").hasClass("fan-spin-veryfast")) {
          $("#fan4").addClass("fan-spin-veryfast");
          $("#fan4").removeClass("fan-spin-slower");
          $("#fan4").removeClass("fan-spin-slow");
          $("#fan4").removeClass("fan-spin-fast");
          $("#fan4").removeClass("fan-spin-normal");
          $("#fan4").removeClass("fan-spin-faster");
        }
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

async function updateWifi(telemetryObject) {
  /// Wifi
  const wifiValue = telemetryObject.wifi_signal;

  console.log("Wifi Signal: " + wifiValue);
  const wifiFormated = wifiValue.replace("dBm", "");
  const signalPercentage = dBmToPercentage(parseInt(wifiFormated));
  console.log("Wifi percentage: " + signalPercentage);

  let wifiNozzleParentWidth = $("#wifiProgressBarParent").width();

  $("#wifiProgressBar").width((signalPercentage * wifiNozzleParentWidth) / 100);

  if (signalPercentage > 80) {
    $("#wifiProgressBar").css("background-color", "#51a34f");
  } else if (signalPercentage > 40) {
    $("#wifiProgressBar").css("background-color", "yellow");
  } else if (signalPercentage > 30) {
    $("#wifiProgressBar").css("background-color", "red");
  }

  if (currentState !== "RUNNING") {
    $("#wifiProgressBar").css("background-color", "grey");
  }

  $("#wifiValue").text(signalPercentage);
}

async function updateAMS(telemetryObject) {
  /// AMS

  // Tray 1

  var tray1Color = telemetryObject.ams.ams[0].tray[0].tray_color;
  var tray1Material = telemetryObject.ams.ams[0].tray[0].tray_sub_brands;
  var tray1FilamentType = telemetryObject.ams.ams[0].tray[0].tray_type;
  var tray1Type = "";
  var tray1UID = telemetryObject.ams.ams[0].tray[0].tag_uid;
  var tray1Remaining = telemetryObject.ams.ams[0].tray[0].remain;

  if (!tray1Remaining) {
    $("#tray1Remaining").text("Unknown");
    $("#tray1ProgressBar").css("background-color", "grey");
  } else {
    if (!tray1FilamentType) {
      tray1FilamentType = "Unknown";
    }

    console.log(tray1Color);
    $("#tray1Color").css("background-color", "#" + tray1Color);
    $("#tray1Material").text(tray1Material);

    if (!tray1UID) {
      tray1Type = tray1FilamentType;
    } else if (tray1UID === "0000000000000000") {
      tray1Type = "Unknown • " + tray1FilamentType;
    } else {
      tray1Type = "Bambu • " + tray1FilamentType;
    }

    $("#tray1Type").text(tray1Type);
    $("#tray1Remaining").text(tray1Remaining + "%");
    let tray1ProgressBarParent = $("#tray1ProgressBarParent").width();
    if (tray1Remaining < 0) {
      tray1Remaining = 0;
    }
    $("#tray1ProgressBar").width(
      (tray1Remaining * tray1ProgressBarParent) / 100
    );

    if (tray1Remaining >= 30) {
      $("#tray1ProgressBar").css("background-color", "#51a34f");
    } else if (tray1Remaining < 30) {
      $("#tray1ProgressBar").css("background-color", "yellow");
    } else if (tray1Remaining < 5) {
      $("#tray1ProgressBar").css("background-color", "red");
    } else if (tray1Remaining === -1) {
      $("#tray1Remaining").text("Unknown");
      $("#tray1ProgressBar").css("background-color", "grey");
    } else {
      $("#tray1Remaining").text("LOW");
      $("#tray1ProgressBar").css("background-color", "red");
    }

    if (currentState !== "RUNNING") {
      $("#tray1ProgressBar").css("background-color", "grey");
    }
  }
  // Tray 2

  var tray2Color = telemetryObject.ams.ams[0].tray[1].tray_color;
  var tray2Material = telemetryObject.ams.ams[0].tray[1].tray_sub_brands;
  var tray2FilamentType = telemetryObject.ams.ams[0].tray[1].tray_type;
  var tray2Type = "";
  var tray2UID = telemetryObject.ams.ams[0].tray[1].tag_uid;
  var tray2Remaining = telemetryObject.ams.ams[0].tray[1].remain;

  if (!tray2Remaining) {
    $("#tray2Remaining").text("Unknown");
    $("#tray2ProgressBar").css("background-color", "grey");
  } else {
    if (!tray2FilamentType) {
      tray2FilamentType = "Unknown";
    }

    console.log(tray2Color);
    $("#tray2Color").css("background-color", "#" + tray2Color);
    $("#tray2Material").text(tray2Material);

    if (!tray2UID) {
      tray2Type = tray2FilamentType;
    } else if (tray2UID === "0000000000000000") {
      tray2Type = "Unknown • " + tray2FilamentType;
    } else {
      tray2Type = "Bambu • " + tray2FilamentType;
    }

    $("#tray2Type").text(tray2Type);
    $("#tray2Remaining").text(tray2Remaining + "%");
    let tray2ProgressBarParent = $("#tray2ProgressBarParent").width();
    if (tray2Remaining < 0) {
      tray2Remaining = 0;
    }
    $("#tray2ProgressBar").width(
      (tray2Remaining * tray2ProgressBarParent) / 100
    );

    if (tray2Remaining >= 30) {
      $("#tray2ProgressBar").css("background-color", "#51a34f");
    } else if (tray2Remaining < 30) {
      $("#tray2ProgressBar").css("background-color", "yellow");
    } else if (tray2Remaining < 5) {
      $("#tray2ProgressBar").css("background-color", "red");
    } else if (tray2Remaining === -1) {
      $("#tray2Remaining").text("Unknown");
      $("#tray2ProgressBar").css("background-color", "grey");
    } else {
      $("#tray2Remaining").text("LOW");
      $("#tray2ProgressBar").css("background-color", "red");
    }

    if (currentState !== "RUNNING") {
      $("#tray2ProgressBar").css("background-color", "grey");
    }
  }

  // Tray 3

  var tray3Color = telemetryObject.ams.ams[0].tray[2].tray_color;
  var tray3Material = telemetryObject.ams.ams[0].tray[2].tray_sub_brands;
  var tray3FilamentType = telemetryObject.ams.ams[0].tray[2].tray_type;
  var tray3Type = "";
  var tray3UID = telemetryObject.ams.ams[0].tray[2].tag_uid;
  var tray3Remaining = telemetryObject.ams.ams[0].tray[2].remain;

  // Does not exist
  if (!tray3Remaining) {
    $("#tray3Remaining").text("Unknown");
    $("#tray3ProgressBar").css("background-color", "grey");
  } else {
    if (!tray3FilamentType) {
      tray3FilamentType = "Unknown";
    }

    console.log(tray3Color);
    $("#tray3Color").css("background-color", "#" + tray3Color);
    $("#tray3Material").text(tray3Material);

    if (!tray3UID) {
      tray3Type = tray3FilamentType;
    } else if (tray3UID === "0000000000000000") {
      tray3Type = "Unknown • " + tray3FilamentType;
    } else {
      tray3Type = "Bambu • " + tray3FilamentType;
    }

    $("#tray3Type").text(tray3Type);
    $("#tray3Remaining").text(tray3Remaining + "%");
    let tray3ProgressBarParent = $("#tray3ProgressBarParent").width();
    if (tray3Remaining < 0) {
      tray3Remaining = 0;
    }
    $("#tray3ProgressBar").width(
      (tray3Remaining * tray3ProgressBarParent) / 100
    );

    if (tray3Remaining >= 30) {
      $("#tray3ProgressBar").css("background-color", "#51a34f");
    } else if (tray3Remaining < 30) {
      $("#tray3ProgressBar").css("background-color", "yellow");
    } else if (tray3Remaining < 5) {
      $("#tray3ProgressBar").css("background-color", "red");
    } else if (tray3Remaining === -1) {
      $("#tray3Remaining").text("Unknown");
      $("#tray3ProgressBar").css("background-color", "grey");
    } else {
      $("#tray3Remaining").text("LOW");
      $("#tray3ProgressBar").css("background-color", "red");
    }

    if (currentState !== "RUNNING") {
      $("#tray3ProgressBar").css("background-color", "grey");
    }
  }
  // Tray 4

  var tray4Color = telemetryObject.ams.ams[0].tray[3].tray_color;
  var tray4Material = telemetryObject.ams.ams[0].tray[3].tray_sub_brands;
  var tray4FilamentType = telemetryObject.ams.ams[0].tray[3].tray_type;
  var tray4Type = "";
  var tray4UID = telemetryObject.ams.ams[0].tray[3].tag_uid;
  var tray4Remaining = telemetryObject.ams.ams[0].tray[3].remain;

  if (!tray4Remaining) {
    $("#tray4Remaining").text("Unknown");
    $("#tray4ProgressBar").css("background-color", "grey");
  } else {
    if (!tray4FilamentType) {
      tray4FilamentType = "Unknown";
    }

    console.log(tray4Color);
    $("#tray4Color").css("background-color", "#" + tray4Color);
    $("#tray4Material").text(tray4Material);

    if (!tray4UID) {
      tray4Type = tray4FilamentType;
    } else if (tray4UID === "0000000000000000") {
      tray4Type = "Unknown • " + tray4FilamentType;
    } else {
      tray4Type = "Bambu • " + tray4FilamentType;
    }

    $("#tray4Type").text(tray4Type);
    $("#tray4Remaining").text(tray4Remaining + "%");
    let tray4ProgressBarParent = $("#tray4ProgressBarParent").width();
    if (tray4Remaining < 0) {
      tray4Remaining = 0;
    }
    $("#tray4ProgressBar").width(
      (tray4Remaining * tray4ProgressBarParent) / 100
    );

    if (tray4Remaining >= 30) {
      $("#tray4ProgressBar").css("background-color", "#51a34f");
    } else if (tray4Remaining < 30) {
      $("#tray4ProgressBar").css("background-color", "yellow");
    } else if (tray4Remaining < 5) {
      $("#tray4ProgressBar").css("background-color", "red");
    } else if (tray4Remaining === -1) {
      $("#tray4Remaining").text("Unknown");
      $("#tray4ProgressBar").css("background-color", "grey");
    } else {
      $("#tray4Remaining").text("LOW");
      $("#tray4ProgressBar").css("background-color", "red");
    }

    if (currentState !== "RUNNING") {
      $("#tray4ProgressBar").css("background-color", "grey");
    }
  }

  // AMS active
  var amsActiveTrayValue = telemetryObject.ams.tray_now;
  console.log("AMS Active tray: " + amsActiveTrayValue);

  $("#tray1Active").hide();
  $("#tray2Active").hide();
  $("#tray3Active").hide();
  $("#tray4Active").hide();

  if (currentState !== "RUNNING") {
    $("#tray1Active").css("background-color", "grey");
    $("#tray2Active").css("background-color", "grey");
    $("#tray3Active").css("background-color", "grey");
    $("#tray4Active").css("background-color", "grey");
  } else {
    $("#tray1Active").css("background-color", "#51a34f");
    $("#tray2Active").css("background-color", "#51a34f");
    $("#tray3Active").css("background-color", "#51a34f");
    $("#tray4Active").css("background-color", "#51a34f");
  }

  if (amsActiveTrayValue === null) {
  } else if (amsActiveTrayValue === 255) {
  } else if (amsActiveTrayValue === "0") {
    $("#tray1Active").show();
  } else if (amsActiveTrayValue === "1") {
    $("#tray2Active").show();
  } else if (amsActiveTrayValue === "2") {
    $("#tray3Active").show();
  } else if (amsActiveTrayValue === "3") {
    $("#tray4Active").show();
  }
}

// Call the updateLog function to fetch and parse the data
setInterval(async () => {
  try {
    var telemetryObject = await retrieveData();
    if (telemetryObject != null) {
      await updateUI(telemetryObject);
      await updateFans(telemetryObject);
      await updateWifi(telemetryObject);
      await updateAMS(telemetryObject);
    }
    else if (telemetryObject != "Incomplete")
    {
      // Data is incomplete, but we did get something, just skip for now
    }else
    {
      disableUI();
    }

  } catch (error) {
    console.error(error);
  }
}, 1000);

// Pulled from GPT, my printer is VERY close to my router, so to make this more interesting,
// I have updated the maxSignal from -50 dBm to -40 dBm making it more difficult to reach max.

function dBmToPercentage(dBm) {
  // Define the minimum and maximum dBm values for mapping
  const minSignal = -100;
  const maxSignal = -50;

  // Ensure that dBm is within the defined range
  if (dBm < minSignal) {
    return 0; // Signal is weaker than -100 dBm
  } else if (dBm > maxSignal) {
    return 100; // Signal is stronger than -50 dBm
  }

  // Calculate the percentage based on the mapping
  const percentage = ((dBm - minSignal) / (maxSignal - minSignal)) * 100;

  return Math.round(percentage);
}

  function disableUI(){
    $("#bedProgressBar").css("background-color", "grey");
    $("#bedTargetTempTempSymbols").hide();

    $("#nozzleProgressBar").css("background-color", "grey");
    $("#nozzleTargetTempTempSymbols").hide();

    $("#chamberProgressBar").css("background-color", "grey");
    $("#chamberTargetTempTempSymbols").hide();

    $("#printSpeed").css("color", "grey");

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
    $("#wifiProgressBar").css("background-color", "grey");
    $("#tray1ProgressBar").css("background-color", "grey");
    $("#tray2ProgressBar").css("background-color", "grey");
    $("#tray3ProgressBar").css("background-color", "grey");
    $("#tray4ProgressBar").css("background-color", "grey");
    $("#tray1Active").hide();
    $("#tray2Active").hide();
    $("#tray3Active").hide();
    $("#tray4Active").hide();
    $("#tray1Active").css("background-color", "grey");
    $("#tray2Active").css("background-color", "grey");
    $("#tray3Active").css("background-color", "grey");
    $("#tray4Active").css("background-color", "grey");
  }


  function convertUtc(timestampUtcMs) {
    var localTime = new Date(timestampUtcMs);

    // Formatting the date to a readable string in local time
    return localTime.toLocaleString();
  } 

