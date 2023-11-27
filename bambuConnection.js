//-------------------------------------------------------------------------------------------------------------
/// Configure your settings here:

const httpPort = 8080; // (8080) Without admin on windows getting anything under like 1000 to work is challenging
const printerURL = '10.0.0.1'; // Bambu printer IP - (Located in settings on printer)
const printerPort = '8883'; // Bambu printer port - dont change
const printerSN = 'INSERT SERIAL NUMBER HERE'; // Bambu Serial Number (Located in settings on printer)
const printerAccessCode = 'INSERT ACCESS CODE HERE'; // Bambu Access Code (Located in settings on printer)

//-------------------------------------------------------------------------------------------------------------



const consoleLogging = false;

// Removed some constant console.logs, re-enable for full verbosity

const mqtt = require("mqtt");
const fs = require("fs");
const http = require("http");
const url = require("url");
const path = require("path");
const protocol = "mqtts";
let SequenceID = 20000;
let topic = "device/" + printerSN + "/report";
let topicRequest = "device/" + printerSN + "/request";

// Build node.js http server to host dashboard

http
  .createServer(function (req, res) {
    const parsedUrl = url.parse(req.url);
    // extract URL path
    let pathname = `.${parsedUrl.pathname}`;

    if (pathname === "./") {
      pathname = "./index.html";
    }

    const ext = path.parse(pathname).ext;
    const map = {
      ".ico": "image/x-icon",
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".doc": "application/msword",
    };

    fs.exists(pathname, function (exist) {
      if (!exist) {
        // if the file is not found, return 404
        res.statusCode = 404;
        res.end(`File ${pathname} not found!`);
        return;
      }

      // if is a directory search for index file matching the extension
      if (fs.statSync(pathname).isDirectory()) pathname += "/index";

      // read file from file system
      fs.readFile(pathname, function (err, data) {
        if (err) {
          res.statusCode = 500;
          res.end(`Error getting the file: ${err}.`);
        } else {
          // if the file is found, set Content-type and send data
          res.setHeader("Content-type", map[ext] || "text/plain");
          res.end(data);
        }
      });
    });
  })
  .listen(parseInt(httpPort));

const clientId = `mqtt_${Math.random().toString(16)}`;

const connectUrl = `${protocol}://${printerURL}:${printerPort}`;

function connectClient() {
  const client = mqtt.connect(connectUrl, {
    clientId,
    clean: true,
    connectTimeout: 3000,
    username: "bblp",
    password: printerAccessCode,
    recconectPeriod: 1000,
    rejectUnauthorized: false,
  });

  client.on("connect", () => {
    log("Client connected!");
    SequenceID = SequenceID + 1;
    client.subscribe(topic, () => {
      log(`Subscribed to topic: ${topic}`);
    });

    client.publish(
      topic,
      '{"pushing": {"command": "start", "sequence_id": ' + 0 + "}}"
    );

    const returnMsg = {
      pushing: {
        sequence_id: SequenceID,
        command: "pushall",
      },
      user_id: "9586569",
    };

    client.publish(topicRequest, JSON.stringify(returnMsg));
  });

  client.on("message", (topic, message) => {
    log(`Received message from topic: ${topic}`);

    try {
      const jsonData = JSON.parse(message.toString());

      // Check if 'print' is present in the JSON data / verifies valid data / only writes data when it sees the full structure
      const dataToWrite = JSON.stringify(jsonData);

      let lastUpdate = convertUtc(jsonData.t_utc);

      if (jsonData.print) {
        fs.writeFile("data.json", dataToWrite, (err) => {
          if (err) {
            log("Error writing file:" + err);
          } else {
            log('Data written to file');
          }
        });
      } else {
        // Since we are only getting a date time stamp back, lets force it to send everything
        const returnMsg = {
          pushing: {
            sequence_id: SequenceID,
            command: "pushall",
          },
          user_id: "123456789",
        };

        client.publish(topicRequest, JSON.stringify(returnMsg));
      }
    } catch (err) {
      log("Error parsing JSON:" + err);
      fs.writeFile("error.json", err, (err) => {
        if (err) {
          log("Error writing error file: " + err);
        }
      });
    }
  });

  client.on("error", async (error) => {
    console.error(`Connection error: ${error}`);
    client.end();
    await sleep(1000);
  });

  client.on("close", async () => {
    log("Connection closed. Reconnecting...");
    await sleep(1000);
    connectClient; // Reconnect after 5 seconds
  });

  client.on("reconnect", async () => {
    log("Reconnecting...");
    await sleep(1000);
    connectClient; // Reconnect after 5 seconds
  });

  client.on("offline", async () => {
    log("Client is offline");
    await sleep(1000);
    connectClient;
  });
}

// Initial connection
connectClient();

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))


function convertUtc(timestampUtcMs) {
  var localTime = new Date(timestampUtcMs);

  // Formatting the date to a readable string in local time
  return localTime.toLocaleString();
}

function log(logText) {
  if(consoleLogging)
  {
    console.log(logText);
  }
}
