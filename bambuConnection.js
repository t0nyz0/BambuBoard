//-------------------------------------------------------------------------------------------------------------
/// Configure your settings here:
let config = require('./config.json');

let httpPort = process.env.BAMBUBOARD_HTTP_PORT || config.BambuBoard_httpPort || 8080;
let printerURL = process.env.BAMBUBOARD_PRINTER_URL || config.BambuBoard_printerURL;
let printerPort = process.env.BAMBUBOARD_PRINTER_PORT || config.BambuBoard_printerPort;
let printerSN = process.env.BAMBUBOARD_PRINTER_SN || config.BambuBoard_printerSN;
let printerAccessCode = process.env.BAMBUBOARD_PRINTER_ACCESS_CODE || config.BambuBoard_printerAccessCode;
let tempSetting = process.env.BAMBUBOARD_TEMP_SETTING || config.BambuBoard_tempSetting;
let printerType = process.env.BAMBUBOARD_PRINTER_TYPE || config.BambuBoard_printerType || "X1"; // X1, P1, A1

//-------------------------------------------------------------------------------------------------------------
/// Preferences:

let displayFanPercentages = process.env.BAMBUBOARD_FAN_PERCENTAGES || config.BambuBoard_displayFanPercentages; // Use percentages instead of icons for the fans
let displayFanIcons = process.env.BAMBUBOARD_FAN_ICONS || config.BambuBoard_displayFanIcons; // Use percentages instead of icons for the fans
let consoleLogging = process.env.BAMBUBOARD_LOGGING || config.BambuBoard_logging || false; // Enable if you want to

//-------------------------------------------------------------------------------------------------------------

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
const tokenFilePath = path.join(__dirname, 'accessToken.json');
const configPath = path.join(__dirname, 'config.json');
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

let cache2 = {
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

app.post('/sendVerificationCode', async (req, res) => {
  const { username } = req.body;

  try {
    // Send the verification code request
    const sendCodeResponse = await fetch('https://api.bambulab.com/v1/user-service/user/sendemail/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: username, type: 'codeLogin' })
    });

    if (sendCodeResponse.ok) {
      res.status(200).send('Verification code sent successfully. Please check your email.');
    } else {
      throw new Error('Failed to send verification code');
    }
  } catch (error) {
    console.error('Error during sending verification code:', error);
    res.status(500).send('Failed to send verification code');
  }
});

app.get('/token-status', async (req, res) => {
  try {
    const data = await fsp.readFile(path.join(__dirname, 'accessToken.json'), 'utf-8');
    const tokenData = JSON.parse(data);
    if (tokenData && tokenData.accessToken) {
      return res.json({ loggedIn: true });
    } else {
      return res.json({ loggedIn: false });
    }
  } catch (error) {
    // If file doesn't exist or is invalid
    return res.json({ loggedIn: false });
  }
});


app.post('/verify', async (req, res) => {
  const { username, code } = req.body;

  const headers = {
    "Content-Type": "application/json",
  };

  try {
    // Perform verification request
    const verifyPayload = {
      account: username,
      code: code,
    };

    const verifyResponse = await fetch('https://api.bambulab.com/v1/user-service/user/login', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(verifyPayload)
    });

    if (!verifyResponse.ok) {
      throw new Error('Verification failed');
    }

    const verifyData = await verifyResponse.json();
    const token = verifyData.accessToken;
    const refreshToken = verifyData.refreshToken;
    const expiresIn = verifyData.expiresIn; 
    const currentTime = Date.now();

    // Save access token, refresh token, and expiration info
    const tokenInfo = {
      accessToken: token,
      refreshToken: refreshToken,
      tokenExpiration: currentTime + expiresIn * 1000, // Calculate expiration time in ms
    };

    await fsp.writeFile(tokenFilePath, JSON.stringify(tokenInfo));
    res.status(200).send('Verification successful');
  } catch (error) {
    console.error('Error during verification:', error);
    res.status(401).send('Verification failed');
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

app.get('/profile-info', async (req, res) => {
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
    const apiResponse = await fetch('https://api.bambulab.com/v1/design-user-service/my/preference', {
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
      uid: data.uid
    };
        // Use the token to perform the API request
        log('Attempting to use token for API request...');
        const apiResponse2 = await fetch('https://api.bambulab.com/v1/design-user-service/user/profile/' + responseObject.uid, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
    
        if (!apiResponse2.ok) {
          console.error('API request failed with status:', apiResponse2.status);
          throw new Error('API request failed');
        }
    
        const data2 = await apiResponse2.json();
        log(`API response data: ${JSON.stringify(data)}`);


        //"uid":4244313862
        //"name":"t0nyz"
        //"handle":"t0nyz"
        //"avatar":"https://public-cdn.bblmw.com/avatar/4244313862/2024-06-22_563e3d7dca03e.jpg",
        //"fanCount":109
        //"followCount":5
        //"isFollowed":false
        //"likeCount":931
        //"collectionCount":1686
        //"downloadCount":4199
        //"boostGained":189
        

    const responseObject2 = {
      handle: data2.handle,
      avatar: data2.avatar,
      fanCount: data2.fanCount,
      followCount: data2.followCount,
      likeCount: data2.likeCount,
      collectionCount: data2.collectionCount,
      downloadCount: data2.downloadCount,
      boostGained: data2.boostGained
    };

    // Update cache
    cache2 = {
      lastRequestTime: currentTime,
      data: responseObject2
    };

    res.json(responseObject2);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('An error occurred');
  }
});

let storedTfaKey = null;

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const authResponse = await fetchWithTimeout('https://api.bambulab.com/v1/user-service/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: username, password, apiError: '' }),
    }, 7000);

    const authData = await authResponse.json();

    if (authData.success) {
      const token = authData.accessToken;
      await fs.writeFile(tokenFilePath, JSON.stringify({ accessToken: token }), 'utf-8');
      res.status(200).send('Login successful');
    } else if (authData.loginType === 'verifyCode') {
      const sendCodeResponse = await fetch('https://api.bambulab.com/v1/user-service/user/sendemail/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: username, type: 'codeLogin' })
      });

      if (sendCodeResponse.ok) {
        res.status(401).send('Verification code required');
      } else {
        throw new Error('Failed to send verification code');
      }
    } else if (authData.loginType === 'tfa') {
      storedTfaKey = authData.tfaKey; // Store the tfaKey for later use
      res.status(401).send('MFA code required');
    } else {
      throw new Error('Authentication failed');
    }
  } catch (error) {
    console.error('Error during login:', error);
    res.status(401).send('Login failed');
  }
});

app.post('/mfa', async (req, res) => {
  const { code } = req.body;

  const headers = {
    "Content-Type": "application/json",
  };

  try {
    // Perform MFA verification request
    const verifyPayload = {
      tfaKey: storedTfaKey, // Use the stored tfaKey from the login step
      tfaCode: code,
    };

    const tfaResponse = await fetch('https://bambulab.com/api/sign-in/tfa', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(verifyPayload),
    });

    if (!tfaResponse.ok) {
      throw new Error('MFA verification failed');
    }

    const setCookies = tfaResponse.headers.get('set-cookie');

    if (!setCookies) {
      throw new Error('No cookies found in response');
    }

    const cookiesArray = setCookies.split(',');
    const tokenCookie = cookiesArray.find(cookie => cookie.trim().startsWith('token='));
    if (!tokenCookie) {
      throw new Error('Token cookie not found');
    }

    const token = tokenCookie.split('=')[1].split(';')[0];

    if (!token) {
      throw new Error('Token extraction failed');
    }
        await fsp.writeFile(tokenFilePath, JSON.stringify({ accessToken: token,  }), 'utf-8');
        res.status(200).send('MFA verification successful');
      } catch (error) {
        console.error('Error during MFA verification:', error);
        res.status(401).send('MFA verification failed');
      }
    });

app.get('/settings', async (req, res) => {
  try {
    // Re-read config to get the latest values
    const currentConfig = JSON.parse(await fsp.readFile(configPath, 'utf8'));

    res.json({
      BambuBoard_httpPort: currentConfig.BambuBoard_httpPort,
      BambuBoard_printerURL: currentConfig.BambuBoard_printerURL,
      BambuBoard_printerPort: currentConfig.BambuBoard_printerPort,
      BambuBoard_printerSN: currentConfig.BambuBoard_printerSN,
      BambuBoard_printerAccessCode: currentConfig.BambuBoard_printerAccessCode,
      BambuBoard_tempSetting: currentConfig.BambuBoard_tempSetting,
      BambuBoard_displayFanPercentages: currentConfig.BambuBoard_displayFanPercentages,
      BambuBoard_displayFanIcons: currentConfig.BambuBoard_displayFanIcons
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error reading settings');
  }
});

app.post('/settings/update', async (req, res) => {
  const {
    BambuBoard_httpPort,
    BambuBoard_printerURL,
    BambuBoard_printerPort,
    BambuBoard_printerSN,
    BambuBoard_printerAccessCode,
    BambuBoard_tempSetting,
    BambuBoard_displayFanPercentages,
    BambuBoard_displayFanIcons
  } = req.body;

  try {
    let currentConfig = JSON.parse(await fsp.readFile(configPath, 'utf8'));

    // Update only if values are provided
    if (BambuBoard_httpPort !== undefined) currentConfig.BambuBoard_httpPort = BambuBoard_httpPort;
    if (BambuBoard_printerURL !== undefined) currentConfig.BambuBoard_printerURL = BambuBoard_printerURL;
    if (BambuBoard_printerPort !== undefined) currentConfig.BambuBoard_printerPort = BambuBoard_printerPort;
    if (BambuBoard_printerSN !== undefined) currentConfig.BambuBoard_printerSN = BambuBoard_printerSN;
    if (BambuBoard_printerAccessCode !== undefined) currentConfig.BambuBoard_printerAccessCode = BambuBoard_printerAccessCode;
    if (BambuBoard_tempSetting !== undefined) currentConfig.BambuBoard_tempSetting = BambuBoard_tempSetting;
    if (BambuBoard_displayFanPercentages !== undefined) currentConfig.BambuBoard_displayFanPercentages = BambuBoard_displayFanPercentages;
    if (BambuBoard_displayFanIcons !== undefined) currentConfig.BambuBoard_displayFanIcons = BambuBoard_displayFanIcons;

    httpPort = BambuBoard_httpPort;
    printerURL = BambuBoard_printerURL;
    printerPort = BambuBoard_printerPort;
    printerSN = BambuBoard_printerSN;
    printerAccessCode = BambuBoard_printerAccessCode;
    tempSetting = BambuBoard_tempSetting;
    displayFanPercentages = BambuBoard_displayFanPercentages; // Use percentages instead of icons for the fans
    displayFanIcons = BambuBoard_displayFanIcons; // Use percentages instead of icons for the fans
    
    await fsp.writeFile(configPath, JSON.stringify(currentConfig, null, 2), 'utf8');
    // Reload configuration in memory
    delete require.cache[require.resolve('./config.json')];
    currentConfig = require('./config.json');
    config = require('./config.json');

    
    res.status(200).send('Settings updated successfully');
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).send('Failed to update settings');
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
  
  client = new mqtt.connect(connectUrl, {
    clientId,
    clean: true,
    connectTimeout: 5000,
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

  // Track the last execution time of the pushall command
  let lastPushallTime = 0;
  const PUSHALL_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
  
  client.on("message", (topic, message) => {
    log(`Received message from topic: ${topic}`);
    try {
      const jsonData = JSON.parse(message.toString());
      const dataToWrite = JSON.stringify(jsonData);
      const lastUpdate = convertUtc(jsonData.t_utc);
  
      if (jsonData.print) {
        // Write data to file
        fs.writeFile("./public/data.json", dataToWrite, (err) => {
          if (err) {
            log("Error writing file:" + err);
          } else {
            log("Data written to file");
          }
        });
      } else {
        // Determine if we should send the pushall command
        const printerModel = printerType || "X1"; // Default to X1
        const currentTime = Date.now();
  
        if (
          printerModel === "X1" || // For X1, always execute the command
          (["P1P", "A1", "P1"].includes(printerModel) &&
            currentTime - lastPushallTime >= PUSHALL_INTERVAL) // For P1 and A1, ensure interval has passed
        ) {
          const returnMsg = {
            pushing: {
              sequence_id: SequenceID,
              command: "pushall",
            },
            user_id: "123456789",
          };
          client.publish(topicRequest, JSON.stringify(returnMsg));
          lastPushallTime = currentTime; // Update the last execution time
        } else if (["P1", "A1", "P1P"].includes(printerModel)) {
          log(
            `Skipping pushall command for ${printerModel}, waiting for the interval to pass.`
          );
        }
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
