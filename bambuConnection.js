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

const mqtt = require("mqtt");
const fs = require("fs");
const fsp = require('fs').promises;
const path = require("path");
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();

app.use(express.json());
app.use(cors({ origin: '*' })); 

process.env.UV_THREADPOOL_SIZE = 128;

function extractToken(cookies) {
  return cookies.split('; ').find(row => row.startsWith('token=')).split('=')[1];
}
const tokenFilePath = path.join(__dirname, 'accessToken.json');
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
// Why do we cache? So that we don't slam Bambu's API, ever.

// Helper function for fetch with timeout
async function fetchWithTimeout(resource, options = {}, timeout = 7000) {
  return new Promise((resolve, reject) => {
    // Set up the timeout
    const timeoutId = setTimeout(() => {
      console.error('Request timed out'); // Log the timeout error
      resolve(null); // Resolve with null or a default value
    }, timeout);

    fetch(resource, options).then(response => {
      clearTimeout(timeoutId);
      resolve(response);
    }).catch(error => {
      clearTimeout(timeoutId);
      console.error('Fetch error:', error); // Log the fetch error
      resolve(null); // Resolve with null or a default value
    });
  });
}

// Use the stealth plugin to make Puppeteer harder to detect

app.post('/login', async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: false,
      args: [
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
      ],
    });
    const page = await browser.newPage();

    const loginUrl = 'https://bambulab.com/en/sign-in';
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    // Fill login form
    await page.type('[name="account"]', bambuUsername); // Use the attribute 'name' to select the username field
    await page.type('[name="password"]', bambuPassword); // Use the attribute 'name' to select the password field
    await page.click('button[type="submit"]'); // Adjust this selector if necessary
    

    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    const cookies = await page.cookies();
    console.log('Cookies:', cookies);

    const tokenCookie = cookies.find(cookie => cookie.name === 'token'); 
    const expireTime = cookies.find(cookie => cookie.name === 'expiresIn'); 
    if (tokenCookie) {
      console.log('Access token retrieved:', tokenCookie.value);

      // Save token to file
      const tokenData = {
        accessToken: tokenCookie.value,
        tokenExpiration: expireTime.value,
      };
      await fsp.writeFile(tokenFilePath, JSON.stringify(tokenData, null, 2));

      res.status(200).send('Login successful');
    } else {
      throw new Error('Token not found in cookies');
    }

    await browser.close();
  } catch (error) {
    console.error('Error during login:', error);
    res.status(401).send('Login failed');
  }
});


app.get('/login-and-fetch-image', async (req, res) => {
  try {
    const currentTime = Date.now();
    let token = null;

    // Check if access token file exists and read the token
    try {
      log(`Checking if token file exists: ${tokenFilePath}`);
      await fsp.access(tokenFilePath); 

      log(`Reading token file: ${tokenFilePath}`);
      const tokenFileData = await fsp.readFile(tokenFilePath, 'utf-8');
      log(`Token file data: ${tokenFileData}`);

      const tokenData = JSON.parse(tokenFileData);
      log(`Parsed token data: ${JSON.stringify(tokenData)}`);

      if (tokenData && tokenData.accessToken) {
        token = tokenData.accessToken; 
        log(`Valid token found: ${token}`);
      } else {
        throw new Error('Token expired or invalid');
      }
    } catch (err) {
      log(`No valid token file found, or token expired: ${err.message}`);
      return res.status(401).send('No valid token. Please login first.');
    }

    // Use the token to perform the API request
    log('Attempting to use token for API request...');
    const apiResponse = await fetch('https://api.bambulab.com/v1/user-service/my/tasks', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!apiResponse.ok) {
      console.error('API request failed with status:', apiResponse.status);
      throw new Error('API request failed');
    }

    const data = await apiResponse.json();
    log(`API response data: ${JSON.stringify(data)}`);

    const responseObject = {
      imageUrl: data.hits[0]?.cover,
      modelTitle: data.hits[0]?.title,
      modelWeight: data.hits[0]?.weight,
      modelCostTime: data.hits[0]?.costTime,
      totalPrints: data.total,
      deviceName: data.hits[0]?.deviceName,
      deviceModel: data.hits[0]?.deviceModel,
      bedType: data.hits[0]?.bedType
    };

    // Update cache
    cache = {
      lastRequestTime: currentTime,
      data: responseObject
    };

    res.json(responseObject);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('An error occurred');
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

// Endpoint to check token status
app.get('/auth/status', async (req, res) => {
  try {
    // Read the token file to check the current token status
    const tokenFileData = await fsp.readFile(tokenFilePath, 'utf-8');
    const tokenData = JSON.parse(tokenFileData);
    const currentTime = Date.now();

    if (tokenData && tokenData.accessToken) {
      console.log('Token available:', tokenData.accessToken);
      res.status(200).json({ accessToken: tokenData.accessToken });
    } else {
      console.log('No valid token available.');
      res.status(204).send(); // No content
    }
  } catch (error) {
    console.error('Error reading token file:', error);
    res.status(204).send(); // No content
  }
});
  

// Fallback route to serve index.html for any route not handled by the above routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/data.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'data.json'));
});

app.listen(httpPort, '0.0.0.0', () => {
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
        fs.writeFile("./public/data.json", dataToWrite, (err) => {
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
