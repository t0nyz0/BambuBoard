# BambuBoard
Bambu Dashboard for viewing real time data from the Bambu X1 Carbon 3D printer. 

# Demonstration Videos:

Regular Speed Video: Observe the dashboard functionality at a standard pace.

https://github.com/t0nyz0/BambuBoard/assets/63085518/45ac9987-666e-457f-94ab-9478a71d4c6a

Accelerated Startup Video: Watch the dashboard in action at 2.5x speed during a printer startup sequence.

https://github.com/t0nyz0/BambuBoard/assets/63085518/abd8cd9c-779b-4f17-b1a1-a9392366b98e


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
4. Update the bambuConnection.js with your settings! This is important.
   ```
   sudo nano bambuConnection.js
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


# Future Development Plans:

### (Completed 11/24/23) ~~Investigating the integration of native MQTT capabilities using libraries like Paho or MQTT.js.~~
### (Completed) ~~Upcoming updates will include photos of the actual dashboard setup to demonstrate its real-world application.~~
Add instructions on how to make the raspberry pi automatically boot into kiosk mode. Many tutorials online if you need immediate direction. 

# Known Limitations:

The AMS (Automated Material System) filament remaining percentage displayed on the dashboard may not always be 100% accurate, as the printer estimates filament usage.
Stay tuned for updates and enhancements to BambuBoard, and feel free to contribute to its development. Your feedback and suggestions are always welcome!
