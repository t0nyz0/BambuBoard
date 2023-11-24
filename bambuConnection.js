//-------------------------------------------------------------------------------------------------------------
/// Configure your settings here:

const httpPort = 8080; // (8080) Without admin on windows getting anything under like 1000 to work is challenging
const printerURL = '10.0.0.1'; // Bambu printer IP - (Located in settings on printer)
const printerPort = '8883'; // Bambu printer port - dont change
const printerSN = 'INSERT SERIAL NUMBER HERE'; // Bambu Serial Number (Located in settings on printer)
const printerAccessCode = 'INSERT ACCESS CODE HERE'; // Bambu Access Code (Located in settings on printer)

//-------------------------------------------------------------------------------------------------------------





// Removed some constant console.logs, re-enable for full verbosity

const mqtt = require('mqtt');
const fs = require('fs');
const http = require('http');
const url = require('url'); 
const path = require('path');
const protocol = 'mqtts';


// Build node.js http server to host dashboard

http.createServer(function (req, res) {

    const parsedUrl = url.parse(req.url);
    // extract URL path
    let pathname = `.${parsedUrl.pathname}`;

    if (pathname === './') {
        pathname = './index.html';
    }
    
    const ext = path.parse(pathname).ext;
    const map = {
      '.ico': 'image/x-icon',
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.css': 'text/css',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword'
    };
  
    fs.exists(pathname, function (exist) {
      if(!exist) {
        // if the file is not found, return 404
        res.statusCode = 404;
        res.end(`File ${pathname} not found!`);
        return;
      }
  
      // if is a directory search for index file matching the extension
      if (fs.statSync(pathname).isDirectory()) pathname += '/index';
  
      // read file from file system
      fs.readFile(pathname, function(err, data){
        if(err){
          res.statusCode = 500;
          res.end(`Error getting the file: ${err}.`);
        } else {
          // if the file is found, set Content-type and send data
          res.setHeader('Content-type', map[ext] || 'text/plain' );
          res.end(data);
        }
      });
    });

  
  }).listen(parseInt(httpPort));


const clientId = `mqtt_${Math.random().toString(16).slice(3)}`;

const connectUrl = `${protocol}://${printerURL}:${printerPort}`;

const client = mqtt.connect(connectUrl, {
    clientId,
    clean: true,
    connectTimeout: 3000,
    username: 'bblp',
    password: printerAccessCode,
    recconectPeriod: 1000,
    rejectUnauthorized: false,
});

//console.log('Starting new connection...');

client.on('connect', () => {
    //console.log('Client connected!');
    let topic = 'device/' + printerSN +'/report';
    client.subscribe(topic, () => {
        //console.log(`Subscribed to topic: ${topic}`);
    });
});

client.on('message', (topic, message) => {
    //console.log(`Received message from topic: ${topic}`);
    
    try {
        const jsonData = JSON.parse(message.toString());

        // Check if 'print' is present in the JSON data / verifies valid data / only writes data when it sees the full structure
        if (jsonData.print && 'gcode_state' in jsonData.print) {
            const dataToWrite = JSON.stringify(jsonData.print);

            if (dataToWrite) {
                fs.writeFile('data.json', dataToWrite, (err) => {
                    if (err) {
                        console.log('Error writing file:', err);
                    } else {
                        //console.log('Data written to file');
                    }
                });
            } else {
                //console.log('No data to write.');
            }
        } else {
            //console.log('No valid data found in the message. File not written.');
        }

    } catch (err) {
        console.log('Error parsing JSON:', err);
        fs.writeFile('error.json', err, (err) => {
            if (err) {
                console.log('Error writing error file:', err);
            } 
        });
    }

});