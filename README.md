# BambuBoard
Bambu Dashboard for viewing real time data from the Bambu X1 Carbon 3D printer. Are you looking for the best Bambu printer OBS overlay? Scroll to the bottom. 
Also make sure to check out a live stream here: https://www.youtube.com/channel/UChDOFv_-8TxYOfkteSlvAqA/live

### For more detailed project information visit: https://t0nyz.com/projects/bambuboard
> [!WARNING]  
> Update to version 1.1.6: As of 11/4/2024 Bambu updated the API to require verification code. Once you have the application setup, go to `http://(bambuboard-ip):8080/login.html` to login to Bambu and which will cache your login token for one year.
> 
# Screenshots:

OBS Mode (Using widgets)
<img width="1506" alt="image" src="https://github.com/user-attachments/assets/ed0432a5-e6fb-47f3-a8a5-8285d4289a0d">

Standard Mode
![image](https://github.com/t0nyz0/BambuBoard/assets/63085518/33ebcaa1-a80b-4372-b218-1b22901b0695)


# Installation Option 1 (Docker)

## Step 1: Install Docker

Before running the BambuBoard in Docker, ensure that Docker is installed on your system.

### Instructions:

- **Windows and macOS:**
  1. Download and install Docker Desktop from [Docker's official website](https://www.docker.com/products/docker-desktop).
  2. Follow the installation instructions provided on the website.

- **Linux:**
  1. Open a terminal and run the following commands to install Docker:
     ```cpp
     sudo apt-get update
     sudo apt-get install docker-ce docker-ce-cli containerd.io
     ```
  2. Start the Docker service:
     ```cpp
     sudo systemctl start docker
     sudo systemctl enable docker
     ```

For detailed instructions, visit the [Docker installation documentation](https://docs.docker.com/get-docker/).


## Step 2: Run the Docker Container

### Run the Docker container using the following command:

```ccp
docker run -d \
-p 8080:8080 \
-e BAMBUBOARD_HTTP_PORT=8080 \
-e BAMBUBOARD_PRINTER_URL=10.0.0.1 \
-e BAMBUBOARD_PRINTER_PORT=8883 \
-e BAMBUBOARD_PRINTER_SN=bambu_serialnumber \
-e BAMBUBOARD_PRINTER_ACCESS_CODE=bambu_accesscode \
-e BAMBUBOARD_TEMP_SETTING=both \
-e BAMBUBOARD_FAN_PERCENTAGES=false \
-e BAMBUBOARD_FAN_ICONS=true \
-e BAMBUBOARD_LOGGING=false \
--name bambuboard-instance \
ghcr.io/t0nyz0/bambuboard:latest
```

## Step 3: Login and setup configuration 
### Goto: (http://(bambuboard-ip):8080/login.html) and login to your BambuLab account. 
- Setup your printer IP, Access Code and Serial Number if you have not done so already.

  <img width="1094" alt="image" src="https://github.com/user-attachments/assets/1146c413-3920-4a16-8ac4-c18216a62018">


# Installation Option 2 (Manual install)

## Step 1: Install Node.js

Node.js is required to run the BambuBoard application. Here's how to install it on your Raspberry Pi:

1. Open a terminal on your Raspberry Pi.
2. Update your package list:
   ```ccp
   sudo apt update
   ```
3. Upgrade your packages to their latest versions:
   ```ccp
   sudo apt full-upgrade
   ```
4. Install Node.js:
   ```ccp
   sudo apt install nodejs
   ```
5. (Optional) Install npm, Node.js' package manager:
   ```ccp
   sudo apt install npm
   ```
6. Verify the installation by checking the version of Node.js and npm:
   ```ccp
   node -v
   npm -v
   ```
## Step 2: Clone the BambuBoard Repository

To get the BambuBoard code, you need to clone its repository from GitHub:

1. Navigate to the directory where you want to clone the repository:
   ```ccp
   cd /path/to/directory
   ```
2. Clone the repository:
   ```ccp
   git clone https://github.com/t0nyz0/BambuBoard.git
   ```
3. Change into the cloned repository's directory:
   ```ccp
   cd BambuBoard
   ```

## Step 3: Install Dependencies

BambuBoard may have Node.js dependencies that need to be installed:

1. Within the BambuBoard directory, install the dependencies:
   ```ccp
   npm install
   ```

## Step 4: Run the Application

To start the BambuBoard dashboard:

1. Run the application:
   ```ccp
   node bambuConnection.js
   ```

# Accessing the Dashboard

Once the application is running, you can access the BambuBoard dashboard. Open your browser and navigate to:
   ```ccp
   http://ipaddress:8080
   ```
Replace `8080` with the actual port number if BambuBoard runs on a different port. (Configured in bambuConnection.js)

Once you have the application setup, go to /login.html to login to Bambu and which will cache your login token for one year.

## Troubleshooting

If you encounter any issues, consider the following:

- Check that you have the correct permissions to clone the repository and install Node.js packages.
- Verify that the firewall settings are not blocking the BambuBoard application.
- Important: Bambu Account 2-factor authentication currently does not allow this program to communicate with Bambu API, right now 2FA is not supported. If you have 2FA on the program might fail to load, or freeze.


## OBS mode

OBS widgets are now supported as of 1/7/24

https://github.com/t0nyz0/BambuBoard/assets/63085518/716d8832-ae8d-49e3-84d7-3cdb1adbddbc



I have provided a sample scene file that you can import into OBS, using "Scene Collection > Import".

Note: Before importing, you will need to open the JSON and replace the IP address listed with your server IP. 
Also make sure to update the media feed to the ffmpeg provided to you from the Bambu software folder. Please refer to the Bambu GO Live documentation for more: https://wiki.bambulab.com/en/software/bambu-studio/virtual-camera

In the "OBS_Settings" folder in the project root you will find the scene file for importing. If you run into any widgets not working, first check case sensitivity of the widget URL's. Depending on setup this can be an issue. 

List of all widget addresses:
```
"AMS widget": "http://127.0.0.1:8080/widgets/ams/index.html"
"AMS Temp widget: "http://127.0.0.1:8080/widgets/ams-temp/index.html"
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

Note: If you want to EDIT notes go to this URL: http://server:8080/widgets/notes/edit.html

# Future Development Plans:

- ~~Celcius / Fahrenheit preference setting~~
- Rebuild using React?
- Better settings configuration
- ~~Add AMS humidty / temp~~
- ~~AMS Active tray tracking~~
- Address bug with the "Total Prints" data point, the API does not appear to keep an entire record of all cloud prints. Total print count might always been inaccurate and may need to be removed in future versions.

# Known Limitations:

The AMS (Automated Material System) filament remaining percentage displayed on the dashboard may not always be 100% accurate, as the printer estimates filament usage.
Stay tuned for updates and enhancements to BambuBoard, and feel free to contribute to its development. Your feedback and suggestions are always welcome!
