//-------------------------------------------------------------------------------------------------------------
/// Multi-Printer BambuBoard Configuration
let config = require('./config.json');

let httpPort = process.env.BAMBUBOARD_HTTP_PORT || config.BambuBoard_httpPort || 8080;
let tempSetting = process.env.BAMBUBOARD_TEMP_SETTING || config.BambuBoard_tempSetting;
let displayFanPercentages = process.env.BAMBUBOARD_FAN_PERCENTAGES || config.BambuBoard_displayFanPercentages;
let displayFanIcons = process.env.BAMBUBOARD_FAN_ICONS || config.BambuBoard_displayFanIcons;
let consoleLogging = process.env.BAMBUBOARD_LOGGING || config.BambuBoard_logging || false;

// Multi-printer configuration
let printers = config.printers || [];

//-------------------------------------------------------------------------------------------------------------

const mqtt = require("mqtt");
const fs = require("fs");
const fsp = require('fs').promises;
const path = require("path");
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const expressWs = require('express-ws');

const app = express();
const server = require('http').createServer(app);
const wsInstance = expressWs(app, server);

app.use(express.json());
app.use(cors({ origin: '*' }));

process.env.UV_THREADPOOL_SIZE = 128;

const configPath = path.join(__dirname, 'config.json');
const protocol = "mqtts";

// Multi-printer MQTT clients and data storage
let printerClients = {};
let printerData = {};
let printerSequenceIDs = {};

// Initialize printer data
printers.forEach(printer => {
  printerData[printer.id] = {
    lastUpdate: null,
    status: 'offline',
    data: null
  };
  printerSequenceIDs[printer.id] = 20000;
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to log messages
function log(logText) {
  if (consoleLogging) {
    console.log(logText);
  }
}

// LAN-only mode: Simplified token status - always return logged in
app.get('/token-status', async (req, res) => {
  res.json({ loggedIn: true });
});

// Get all printers status
app.get('/printers', async (req, res) => {
  try {
    const printerStatus = printers.map(printer => ({
      id: printer.id,
      name: printer.name,
      url: printer.url,
      status: printerData[printer.id]?.status || 'offline',
      lastUpdate: printerData[printer.id]?.lastUpdate || null
    }));
    res.json(printerStatus);
  } catch (error) {
    console.error('Error getting printer status:', error);
    res.status(500).json({ error: 'Failed to get printer status' });
  }
});

// Get data for a specific printer
app.get('/printer/:printerId/data', async (req, res) => {
  try {
    const printerId = req.params.printerId;
    const dataPath = path.join(__dirname, 'public', `data_${printerId}.json`);
    
    try {
      const data = await fsp.readFile(dataPath, 'utf-8');
      try {
        res.json(JSON.parse(data));
      } catch (parseErr) {
        console.error(`Corrupt JSON in ${dataPath}, deleting file. Error:`, parseErr.message);
        await fsp.unlink(dataPath).catch(() => {});
        res.json({ error: 'Corrupt data file was deleted. Waiting for new data from printer.' });
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.json({ error: 'No data available for this printer' });
      } else {
        throw err;
      }
    }
  } catch (error) {
    console.error('Error getting printer data:', error);
    res.status(500).json({ error: 'Failed to get printer data' });
  }
});

// Get data for all printers
app.get('/all-printers-data', async (req, res) => {
  try {
    const allData = {};
    
    for (const printer of printers) {
      const dataPath = path.join(__dirname, 'public', `data_${printer.id}.json`);
      try {
        const data = await fsp.readFile(dataPath, 'utf-8');
        allData[printer.id] = JSON.parse(data);
      } catch (err) {
        if (err.code === 'ENOENT') {
          allData[printer.id] = { error: 'No data available' };
        } else {
          allData[printer.id] = { error: 'Failed to read data' };
        }
      }
    }
    
    res.json(allData);
  } catch (error) {
    console.error('Error getting all printers data:', error);
    res.status(500).json({ error: 'Failed to get all printers data' });
  }
});

// LAN-only mode: Simplified settings endpoint
app.get('/settings', async (req, res) => {
  try {
    const configData = await fsp.readFile(configPath, 'utf-8');
    const settings = JSON.parse(configData);
    res.json(settings);
  } catch (error) {
    console.error('Error reading config:', error);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

// LAN-only mode: Settings update endpoint
app.post('/settings/update', async (req, res) => {
  try {
    const newSettings = req.body;
    await fsp.writeFile(configPath, JSON.stringify(newSettings, null, 2));
    
    // Update local variables
    printers = newSettings.printers || [];
    httpPort = newSettings.BambuBoard_httpPort || 8080;
    tempSetting = newSettings.BambuBoard_tempSetting;
    displayFanPercentages = newSettings.BambuBoard_displayFanPercentages;
    displayFanIcons = newSettings.BambuBoard_displayFanIcons;
    consoleLogging = newSettings.BambuBoard_logging;
    
    // Reinitialize printer data
    printers.forEach(printer => {
      if (!printerData[printer.id]) {
        printerData[printer.id] = {
          lastUpdate: null,
          status: 'offline',
          data: null
        };
        printerSequenceIDs[printer.id] = 20000;
      }
    });
    
    // Reconnect all printers
    reconnectAllPrinters();
    
    res.status(200).json({ message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// LAN-only mode: Simplified login endpoint - always succeed
app.post('/login', async (req, res) => {
  res.status(200).json({ message: 'LAN-only mode: No authentication required' });
});

// LAN-only mode: Simplified verification endpoint - always succeed
app.post('/verify', async (req, res) => {
  res.status(200).json({ message: 'LAN-only mode: No verification required' });
});

// LAN-only mode: Simplified MFA endpoint - always succeed
app.post('/mfa', async (req, res) => {
  res.status(200).json({ message: 'LAN-only mode: No MFA required' });
});

// LAN-only mode: Simplified image fetch - return default plate image
app.get('/login-and-fetch-image', async (req, res) => {
  try {
    const defaultImageData = {
      image_url: "/plate.png",
      model_name: "LAN Printer Model"
    };
    res.json(defaultImageData);
  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

// Get fan display preferences
app.get('/fan-display', async (req, res) => {
  try {
    res.json({
      displayFanPercentages: displayFanPercentages,
      displayFanIcons: displayFanIcons
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

// Get version info
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

// Notes functionality
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

app.put('/note', async (req, res) => {
  let dataToWrite = JSON.stringify(req.body);
  fs.writeFile("note.json", dataToWrite, (err) => {
    if (err) {
      console.error(err);
      res.status(500).send('Error writing file');
    } else {
      res.status(200).send('Note updated successfully');
    }
  });
});

// Video feed proxy endpoint
app.get('/printer/:printerId/video', async (req, res) => {
  try {
    const printerId = req.params.printerId;
    const printer = printers.find(p => p.id === printerId);
    
    if (!printer) {
      return res.status(404).json({ error: 'Printer not found' });
    }
    
    // Try different video feed URLs for BambuLab printers
    const videoUrls = [
      `http://${printer.url}:8080/video`,
      `http://${printer.url}:80/video`,
      `http://${printer.url}/video`,
      `http://${printer.url}:8080/`,
      `http://${printer.url}:80/`
    ];
    
    let availableUrl = null;
    let status = 0;
    
    // Test each URL
    for (const videoUrl of videoUrls) {
      try {
        const response = await fetch(videoUrl, { 
          method: 'HEAD',
          timeout: 3000 
        });
        
        if (response.ok) {
          availableUrl = videoUrl;
          status = response.status;
          break;
        }
      } catch (err) {
        // Continue to next URL
        continue;
      }
    }
    
    res.json({
      available: !!availableUrl,
      url: availableUrl || videoUrls[0],
      status: status,
      testedUrls: videoUrls
    });
  } catch (error) {
    console.error('Error checking video status:', error);
    const printerId = req.params.printerId;
    const printer = printers.find(p => p.id === printerId);
    const defaultUrl = printer ? `http://${printer.url}:8080/video` : 'http://unknown/video';
    const testedUrls = printer ? [
      `http://${printer.url}:8080/video`, 
      `http://${printer.url}:80/video`, 
      `http://${printer.url}/video`
    ] : [];
    
    res.json({
      available: false,
      url: defaultUrl,
      error: error.message,
      testedUrls: testedUrls
    });
  }
});

// Video feed status endpoint
app.get('/printer/:printerId/video-status', async (req, res) => {
  const printerId = req.params.printerId;
  const printer = printers.find(p => p.id === printerId);
  
  if (!printer) {
    return res.status(404).json({ error: 'Printer not found' });
  }
  
  try {
    // Try different video feed URLs for BambuLab printers
    const videoUrls = [
      `http://${printer.url}:8080/video`,
      `http://${printer.url}:80/video`,
      `http://${printer.url}/video`,
      `http://${printer.url}:8080/`,
      `http://${printer.url}:80/`
    ];
    
    let availableUrl = null;
    let status = 0;
    
    // Test each URL
    for (const videoUrl of videoUrls) {
      try {
        const response = await fetch(videoUrl, { 
          method: 'HEAD',
          timeout: 3000 
        });
        
        if (response.ok) {
          availableUrl = videoUrl;
          status = response.status;
          break;
        }
      } catch (err) {
        // Continue to next URL
        continue;
      }
    }
    
    res.json({
      available: !!availableUrl,
      url: availableUrl || videoUrls[0],
      status: status,
      testedUrls: videoUrls
    });
  } catch (error) {
    console.error('Error checking video status:', error);
    res.json({
      available: false,
      url: `http://${printer.url}:8080/video`,
      error: error.message,
      testedUrls: [`http://${printer.url}:8080/video`, `http://${printer.url}:80/video`, `http://${printer.url}/video`]
    });
  }
});

// Video stream endpoint using WebSocket for status
app.ws('/printer/:printerId/stream', (ws, req) => {
  const printerId = req.params.printerId;
  const printer = printers.find(p => p.id === printerId);
  
  if (!printer) {
    ws.close();
    return;
  }
  
  console.log(`WebSocket connection established for printer ${printerId}`);
  
  // Send initial connection message
  ws.send(JSON.stringify({
    type: 'connection',
    message: 'WebSocket connected for video stream',
    printerId: printerId,
    printerName: printer.name
  }));
  
  // Handle incoming messages
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      console.log(`Received message from printer ${printerId}:`, data);
      
      // Handle different message types
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        case 'status':
          // Send current printer status
          const printerData = printerData[printerId] || { status: 'offline', data: null };
          ws.send(JSON.stringify({
            type: 'status',
            printerId: printerId,
            status: printerData.status,
            lastUpdate: printerData.lastUpdate
          }));
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch (error) {
      console.error(`Error handling WebSocket message for printer ${printerId}:`, error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });
  
  // Handle WebSocket close
  ws.on('close', () => {
    console.log(`WebSocket closed for printer ${printerId}`);
  });
  
  ws.on('error', (err) => {
    console.error(`WebSocket error for printer ${printerId}:`, err);
  });
});

// Video stream info endpoint
app.get('/printer/:printerId/stream-info', (req, res) => {
  const printerId = req.params.printerId;
  const printer = printers.find(p => p.id === printerId);
  
  if (!printer) {
    return res.status(404).json({ error: 'Printer not found' });
  }
  
  const rtspUrl = `rtsps://bblp:${printer.accessCode}@${printer.url}:322/streaming/live/1`;
  const wsUrl = `ws://${req.get('host')}/printer/${printerId}/stream`;
  
  res.json({
    printerId: printerId,
    printerName: printer.name,
    rtspUrl: rtspUrl,
    wsUrl: wsUrl,
    available: true,
    instructions: {
      enableLanMode: "Enable 'LAN Mode Liveview' in printer settings",
      accessCode: `Use access code: ${printer.accessCode}`,
      streaming: "WebSocket connection available for real-time status updates",
      note: "For full video streaming, use external tools like VLC with the RTSP URL"
    },
    externalTools: {
      vlc: `vlc ${rtspUrl}`,
      ffmpeg: `ffmpeg -i "${rtspUrl}" -f mjpeg -q:v 5 -r 15 output.mjpeg`,
      note: "These commands can be used to test the RTSP stream externally"
    }
  });
});

// Fallback route to serve index.html for any route not handled by the above routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
server.listen(httpPort, '0.0.0.0', () => {
  console.log(`Multi-Printer BambuBoard running on port ${httpPort}`);
  console.log(`Managing ${printers.length} printers`);
});

// Multi-printer MQTT connection management
function connectPrinter(printer) {
  if (printerClients[printer.id]) {
    printerClients[printer.id].end(true);
  }

  const clientId = `mqtt_${printer.id}_${Math.random().toString(16)}`;
  const connectUrl = `${protocol}://${printer.url}:${printer.port}`;
  const topic = `device/${printer.serialNumber}/report`;
  const topicRequest = `device/${printer.serialNumber}/request`;
  
  log(`Connecting to printer ${printer.name} (${printer.id}) at ${connectUrl}`);
  
  printerClients[printer.id] = mqtt.connect(connectUrl, {
    clientId,
    clean: true,
    connectTimeout: 5000,
    username: "bblp",
    password: printer.accessCode,
    reconnectPeriod: 0,
    rejectUnauthorized: false,
  });

  printerClients[printer.id].on("connect", () => {
    log(`Printer ${printer.name} (${printer.id}) connected!`);
    printerData[printer.id].status = 'online';
    printerSequenceIDs[printer.id]++;
    
    printerClients[printer.id].subscribe(topic, () => {
      log(`Subscribed to topic: ${topic}`);
    });

    const returnMsg = {
      pushing: {
        sequence_id: printerSequenceIDs[printer.id],
        command: "pushall",
      },
      user_id: "9586569",
    };

    printerClients[printer.id].publish(topicRequest, JSON.stringify(returnMsg));
  });

  // Track the last execution time of the pushall command for each printer
  let lastPushallTime = 0;
  const PUSHALL_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
  
  printerClients[printer.id].on("message", (topic, message) => {
    log(`Received message from printer ${printer.name} (${printer.id})`);
    try {
      const jsonData = JSON.parse(message.toString());
      const dataToWrite = JSON.stringify(jsonData);
      const lastUpdate = jsonData.t_utc && !isNaN(jsonData.t_utc)
        ? convertUtc(jsonData.t_utc)
        : new Date().toLocaleString();
      
      // Update printer data
      printerData[printer.id].lastUpdate = lastUpdate;
      printerData[printer.id].data = jsonData;
  
      if (jsonData.print) {
        // Write data to printer-specific file
        const dataPath = path.join(__dirname, 'public', `data_${printer.id}.json`);
        fs.writeFile(dataPath, dataToWrite, (err) => {
          if (err) {
            log(`Error writing file for printer ${printer.id}: ${err}`);
          } else {
            log(`Data written to file for printer ${printer.id}`);
          }
        });
      } else {
        // Determine if we should send the pushall command
        const printerModel = printer.type || "X1";
        const currentTime = Date.now();
  
        if (
          printerModel === "X1" || // For X1, always execute the command
          (["P1P", "A1", "P1"].includes(printerModel) &&
            currentTime - lastPushallTime >= PUSHALL_INTERVAL) // For P1 and A1, ensure interval has passed
        ) {
          const returnMsg = {
            pushing: {
              sequence_id: printerSequenceIDs[printer.id],
              command: "pushall",
            },
            user_id: "123456789",
          };
          printerClients[printer.id].publish(topicRequest, JSON.stringify(returnMsg));
          lastPushallTime = currentTime;
        } else if (["P1", "A1", "P1P"].includes(printerModel)) {
          log(`Skipping pushall command for ${printerModel} (${printer.id}), waiting for the interval to pass.`);
        }
      }
    } catch (err) {
      log(`Error parsing JSON for printer ${printer.id}: ${err}`);
      const errorPath = path.join(__dirname, `error_${printer.id}.json`);
      fs.writeFile(errorPath, err.toString(), (err) => {
        if (err) {
          log(`Error writing error file for printer ${printer.id}: ${err}`);
        }
      });
    }
  });

  printerClients[printer.id].on("error", async (error) => {
    console.error(`Connection error for printer ${printer.id}: ${error}`);
    printerData[printer.id].status = 'error';
    await handlePrinterReconnection(printer);
  });

  printerClients[printer.id].on("close", async () => {
    log(`Connection closed for printer ${printer.id}. Reconnecting...`);
    printerData[printer.id].status = 'offline';
    await handlePrinterReconnection(printer);
  });

  printerClients[printer.id].on("disconnect", async () => {
    log(`Connection disconnected for printer ${printer.id}. Reconnecting...`);
    printerData[printer.id].status = 'offline';
    await handlePrinterReconnection(printer);
  });

  printerClients[printer.id].on("offline", async () => {
    log(`Client is offline for printer ${printer.id}. Reconnecting...`);
    printerData[printer.id].status = 'offline';
    await handlePrinterReconnection(printer);
  });

  printerClients[printer.id].on("reconnect", async () => {
    log(`Reconnecting to printer ${printer.id}...`);
  });
}

async function handlePrinterReconnection(printer) {
  if (!printerData[printer.id].reconnecting) {
    printerData[printer.id].reconnecting = true;
    await sleep(3000);
    connectPrinter(printer);
    printerData[printer.id].reconnecting = false;
  }
}

function reconnectAllPrinters() {
  log('Reconnecting all printers...');
  printers.forEach(printer => {
    connectPrinter(printer);
  });
}

// Helper functions
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

function convertUtc(timestampUtcMs) {
  var localTime = new Date(timestampUtcMs);
  return localTime.toLocaleString();
}

// Initial connection for all printers
console.log('Initializing connections for all printers...');
printers.forEach(printer => {
  connectPrinter(printer);
});
