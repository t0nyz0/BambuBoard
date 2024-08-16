//-------------------------------------------------------------------------------------------------------------
/// Configure your settings here:
const config = require('./config.json');

const httpPort = process.env.BAMBUBOARD_HTTP_PORT || config.BambuBoard_httpPort || 8080;
const printerURL = process.env.BAMBUBOARD_PRINTER_URL || config.BambuBoard_printerURL;
const printerPort = process.env.BAMBUBOARD_PRINTER_PORT || config.BambuBoard_printerPort;
const printerSN = process.env.BAMBUBOARD_PRINTER_SN || config.BambuBoard_printerSN;
const printerAccessCode = process.env.BAMBUBOARD_PRINTER_ACCESS_CODE || config.BambuBoard_printerAccessCode;
const bambuUsername = process.env.BAMBUBOARD_BAMBU_USERNAME || config.BambuBoard_bambuUsername;
const bambuPassword = process.env.BAMBUBOARD_BAMBU_PASSWORD || config.BambuBoard_bambuPassword;
const tempSetting = process.env.BAMBUBOARD_TEMP_SETTING || config.BambuBoard_tempSetting;

//-------------------------------------------------------------------------------------------------------------
/// Preferences:

const displayFanPercentages = process.env.BAMBUBOARD_FAN_PERCENTAGES || config.BambuBoard_displayFanPercentages; // Use percentages instead of icons for the fans
const displayFanIcons = process.env.BAMBUBOARD_FAN_ICONS || config.BambuBoard_displayFanIcons; // Use percentages instead of icons for the fans
const consoleLogging = process.env.BAMBUBOARD_LOGGING || config.BambuBoard_logging || false; // Enable if you want to

//-------------------------------------------------------------------------------------------------------------

// -- Dont touch below

const mqtt = require("mqtt");
const fs = require("fs");
const fsp = require('fs').promises;
const path = require("path");
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();

app.use(express.json());
app.use(cors({ origin: '*' })); // CORS setup

process.env.UV_THREADPOOL_SIZE = 128;

function extractToken(cookies) {
  return cookies.split('; ').find(row => row.startsWith('token=')).split('=')[1];
}

const protocol = "mqtts";
let SequenceID = 20000;
let topic = "device/" + printerSN + "/report";
let topicRequest = "device/" + printerSN + "/request";

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

let cache = {
  lastRequestTime: 0,
  data: null
};
const cacheDuration = 60000; // Cache duration set to 60 seconds

// Helper function for fetch with timeout
async function fetchWithTimeout(resource, options = {}, timeout = 7000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(resource, {
    ...options,
    signal: controller.signal  
  }).then(response => {
    clearTimeout(id);
    return response;
  });
}

// Your existing API routes here (e.g., login-and-fetch-image, settings, etc.)
app.get('/login-and-fetch-image', async (req, res) => {
  try {
    const currentTime = new Date().getTime();

    // Check if cached data is valid and return it if valid
    if (currentTime - cache.lastRequestTime < cacheDuration && cache.data) {
      return res.json(cache.data);
    }

    if (bambuUsername != '') {
        const authResponse = await fetchWithTimeout('https://bambulab.com/api/sign-in/form', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: bambuUsername, password: bambuPassword, apiError: '' })
        }, 7000);

        if (!authResponse.ok) {
            throw new Error('Authentication failed');
        }

        const cookies = authResponse.headers.raw()['set-cookie'][1];
        const token = extractToken(cookies);

        const apiResponse = await fetchWithTimeout('https://api.bambulab.com/v1/user-service/my/tasks', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        }, 7000);

        if (!apiResponse.ok) {
            throw new Error('API request failed');
        }

        const data = await apiResponse.json();
        const responseObject = {
          imageUrl: data.hits[0].cover,
          modelTitle: data.hits[0].title,
          modelWeight: data.hits[0].weight,
          modelCostTime: data.hits[0].costTime,
          totalPrints: data.total,
          deviceName: data.hits[0].deviceName,
          deviceModel: data.hits[0].deviceModel,
          bedType: data.hits[0].bedType
        };

        // Update cache
        cache = {
          lastRequestTime: new Date().getTime(),
          data: responseObject
        };

        res.json(responseObject);
    } else {
        const responseObject = {
          imageUrl: 'NOTENROLLED',
          modelTitle: '',
          modelWeight: '',
          modelCostTime: '',
          totalPrints: '',
          deviceName: '',
          deviceModel: '',
          bedType: ''
        };

        // Update cache with default response
        cache = {
          lastRequestTime: new Date().getTime(),
          data: responseObject
        };
      
        res.json(responseObject);
    }
  } catch (error) {
      console.error('Error:', error);
  }
});

app.get('/settings', async (req, res) => {
  try {
    res.json({
      tempSetting,
      displayFanIcons,
      displayFanPercentages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

app.put('/note', async (req, res) => {
  let dataToWrite = JSON.stringify(req.body);

  try {
    await fsp.writeFile("note.json", dataToWrite);
    res.send('Note updated');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error writing note');
  }
});

app.get('/preference-fan-icons', async (req, res) => {
  try {
    res.json(displayFanIcons);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

app.get('/preference-fan-percentages', async (req, res) => {
  try {
    res.json(displayFanPercentages);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

app.get('/version', async (req, res) => {
  try {
    const data = await fsp.readFile("package.json", "utf8");
    res.json(JSON.parse(data));
  } catch (err) {
    console.error(err);

    if (err.code === 'ENOENT') {
      res.status(404).send('File not found');
    } else {
      res.status(500).send('Error reading the file');
    }
  }
});

app.get('/note', async (req, res) => {
  try {
    const data = await fsp.readFile("note.json", "utf8");
    res.json(JSON.parse(data));
  } catch (err) {
    console.error(err);

    if (err.code === 'ENOENT') {
      res.status(404).send('File not found');
    } else {
      res.status(500).send('Error reading the file');
    }
  }
});

// Fallback route to serve index.html for any route not handled by the above routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(httpPort, () => {
    console.log(`BambuBoard running on port ${httpPort}`);
});

let client;

let reconnecting = false;
const reconnectInterval = 3000;

function connectClient() {
  if (client) {
    client.end(true); 
  }

  const clientId = `mqtt_${Math.random().toString(16)}`;
  const connectUrl = `${protocol}://${printerURL}:${printerPort}`;
  
  client = mqtt.connect(connectUrl, {
    clientId,
    clean: true,
    connectTimeout: 3000,
    username: "bblp",
    password: printerAccessCode,
    reconnectPeriod: 0,
    rejectUnauthorized: false,
  });

  client.on("connect", () => {
    log("Client connected!");
    reconnecting = false;
    SequenceID++;
    client.subscribe(topic, () => {
      log(`Subscribed to topic: ${topic}`);
    });

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
    await handleReconnection();
  });

  client.on("close", async () => {
    log("Connection closed. Reconnecting...");
    await handleReconnection();
  });

  client.on("disconnect", async () => {
    log("Connection disconnected. Reconnecting...");
    await handleReconnection();
  });

  client.on("offline", async () => {
    log("Client is offline. Reconnecting...");
    await handleReconnection();
  });

  client.on("reconnect", async () => {
    log("Reconnecting...");
  });
}

async function handleReconnection() {
  if (!reconnecting) {
    reconnecting = true;
    await sleep(reconnectInterval);
    connectClient(); // Reconnect using the `connectClient` function
    reconnecting = false; // Reset the flag after attempting to reconnect
  }
}

// Initial connection
connectClient();

// Helper functions
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

function convertUtc(timestampUtcMs) {
  var localTime = new Date(timestampUtcMs);
  return localTime.toLocaleString();
}

function log(logText) {
  if (consoleLogging) {
    console.log(logText);
  }
}
