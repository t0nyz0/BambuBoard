# BambuBoard
Bambu Dashboard for viewing real time data from the Bambu X1 Carbon 3D printer. 

This project uses the telemetry.json data generated from this python project:
https://github.com/MikeSiekkinen/BambuLabOBSOverlay

# Demonstration Videos:

Regular Speed Video: Observe the dashboard functionality at a standard pace.

https://github.com/t0nyz0/BambuBoard/assets/63085518/45ac9987-666e-457f-94ab-9478a71d4c6a

Accelerated Startup Video: Watch the dashboard in action at 2.5x speed during a printer startup sequence.

https://github.com/t0nyz0/BambuBoard/assets/63085518/abd8cd9c-779b-4f17-b1a1-a9392366b98e


# Data Integration:
This project seamlessly integrates with the BambuLabOBSOverlay Python project, which generates the essential telemetry.json data file. For more information on this integration, visit BambuLabOBSOverlay on GitHub.

# System Setup:

Prepare your Raspberry Pi (or any compatible machine) to run the BambuLabOBSOverlay Python script.
Ensure the script is configured to generate the telemetry.json file.
Web Server Installation:

Install an Apache web server instance on your machine.
Modify the BambuLabOBSOverlay project settings to output data to your Apache root web directory (e.g., /var/www/html).

# Dashboard Configuration:

Update the scripts.js file in BambuBoard to point to your Apache server's address, where the telemetry.json file is hosted (e.g., http://10.0.0.69/telemetry.json).
Note: The entire setup, including the Linux server running the Python script and the Raspberry Pi 4 operating the BambuBoard dashboard, can be consolidated onto a single machine if desired.

# Future Development Plans:

(Completed 11/24/23) Investigating the integration of native MQTT capabilities using libraries like Paho or MQTT.js. Testing is currently underway in a dedicated branch.
(Completed) Upcoming updates will include photos of the actual dashboard setup to demonstrate its real-world application.

# Known Limitations:

The AMS (Automated Material System) filament remaining percentage displayed on the dashboard may not always be 100% accurate, as the printer estimates filament usage.
Stay tuned for updates and enhancements to BambuBoard, and feel free to contribute to its development. Your feedback and suggestions are always welcome!
