# BambuBoard
Bambu Dashboard for viewing real time data from the Bambu X1 Carbon 3D printer. Are you looking for the best Bambu printer OBS overlay? Scroll to the bottom, we have OBS support also!

# Screenshots:

Screenshot (Updated version: 1/14/24):
![image](https://github.com/t0nyz0/BambuBoard/assets/63085518/33ebcaa1-a80b-4372-b218-1b22901b0695)



# BambuBoard Setup Guide

Welcome to the BambuBoard Setup Guide. This document will walk you through the process of cloning the BambuBoard repository and setting up Node.js on your Raspberry Pi to run the BambuBoard dashboard.


## Step 1: Install Node.js

Node.js is required to run the BambuBoard application. Here's how to install it on your Raspberry Pi:

1. Open a terminal on your Raspberry Pi.
2. Update your package list:
   ```
   sudo apt update
   ```
3. Upgrade your packages to their latest versions:
   ```
   sudo apt full-upgrade
   ```
4. Install Node.js:
   ```
   sudo apt install nodejs
   ```
5. (Optional) Install npm, Node.js' package manager:
   ```
   sudo apt install npm
   ```
6. Verify the installation by checking the version of Node.js and npm:
   ```
   node -v
   npm -v
   ```

## Step 2: Clone the BambuBoard Repository

To get the BambuBoard code, you need to clone its repository from GitHub:

1. Navigate to the directory where you want to clone the repository:
   ```
   cd /path/to/directory
   ```
2. Clone the repository:
   ```
   git clone https://github.com/t0nyz0/BambuBoard.git
   ```
3. Change into the cloned repository's directory:
   ```
   cd BambuBoard
   ```
4. Update the config.json with your settings! This is important.
   ```
   sudo nano config.json
   ```
  Note: CTRL+X to exit nano, make sure to hit Y to confirm saving changes.

## Step 3: Install Dependencies

BambuBoard may have Node.js dependencies that need to be installed:

1. Within the BambuBoard directory, install the dependencies:
   ```
   npm install
   ```

## Step 4: Run the Application

To start the BambuBoard dashboard:

1. Run the application:
   ```
   node bambuConnection.js
   ```

## Step 5: Accessing the Dashboard

Once the application is running, you can access the BambuBoard dashboard via a web browser on the Raspberry Pi or another device on the same network. Open your browser and navigate to:
   ```
   http://raspberrypi.local:8080
   ```
Replace `8080` with the actual port number if BambuBoard runs on a different port. (Configured in bambuConnection.js)

Note: If this doesnt work, try IP address of Raspberry Pi.

## Troubleshooting

If you encounter any issues, consider the following:

- Check that you have the correct permissions to clone the repository and install Node.js packages.
- Verify that the Raspberry Pi's firewall settings are not blocking the BambuBoard application.



## OBS mode

OBS widgets are now supported as of 1/7/24

![image](https://github.com/t0nyz0/BambuBoard/assets/63085518/6a8f19e5-6c56-43e4-8c77-a0e36ca53f13)



I have provided a sample scene file that you can import into OBS, using "Scene Collection > Import".

Note: Before importing, you will need to open the JSON and replace the IP address listed with your server IP. 
Also make sure to update the media feed to the ffmpeg provided to you from the Bambu software folder. Please refer to the Bambu GO Live documentation for more: https://wiki.bambulab.com/en/software/bambu-studio/virtual-camera

In the "OBS_Settings" folder in the project root you will find the scene file for importing. If you run into any widgets not working, first check case sensitivity of the widget URL's. Depending on setup this can be an issue. 

List of all widget addresses:
```
"AMS widget": "http://127.0.0.1:8080/widgets/ams/index.html"
"Bed Temp widget": "http://127.0.0.1:8080/widgets/bed-temp/index.html"
"Chamber Temp widget": "http://127.0.0.1:8080/widgets/chamber-temp/index.html"
"Fan widget": "http://127.0.0.1:8080/widgets/fans/index.html"
"Model image widget": "http://127.0.0.1:8080/widgets/model-image/index.html"
"Nozzle temperature widget": "http://127.0.0.1:8080/widgets/nozzle-temp/index.html"
"Nozzle info widget": "http://127.0.0.1:8080/widgets/nozzle-info/index.html"
"Print info widget": "http://127.0.0.1:8080/widgets/print-info/index.html"
"Progress bar widget": "http://127.0.0.1:8080/widgets/progress-info/index.html"
"Wifi widget": "http://127.0.0.1:8080/widgets/wifi/index.html"
"Notes EDIT widget": "http://127.0.0.1:8080/widgets/notes/edit.html"
"Notes VIEW widget": "http://127.0.0.1:8080/widgets/notes/index.html"
"Version widget": "http://127.0.0.1:8080/widgets/version/index.html"
```

Note: If you want to EDIT notes go to this URL: http:/{server}:8080/widgets/notes/edit.html

# Future Development Plans:

### (Completed 11/24/23) ~~Investigating the integration of native MQTT capabilities using libraries like Paho or MQTT.js.~~
### (Completed) ~~Upcoming updates will include photos of the actual dashboard setup to demonstrate its real-world application.~~
1. Add instructions on how to make the raspberry pi automatically boot into kiosk mode. Many tutorials online if you need immediate direction.
~~2. Webcam feed from inside the printer added to the dashboard? (Currently in development)~~ In order to use webcam please use OBS mode, this will allow you to add the RTSP to your dashboard and place the dashboard widgets how you like.

# Known Limitations:

The AMS (Automated Material System) filament remaining percentage displayed on the dashboard may not always be 100% accurate, as the printer estimates filament usage.
Stay tuned for updates and enhancements to BambuBoard, and feel free to contribute to its development. Your feedback and suggestions are always welcome!
