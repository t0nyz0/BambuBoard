# BambuBoard
Bambu Dashboard for viewing real time data from the Bambu X1 Carbon 3D printer.

This project uses the telemetry.json data generated from this python project:
https://github.com/MikeSiekkinen/BambuLabOBSOverlay

Video at regular speed:

https://github.com/t0nyz0/BambuBoard/assets/63085518/45ac9987-666e-457f-94ab-9478a71d4c6a

Video (2.5x) during startup of a print

https://github.com/t0nyz0/BambuBoard/assets/63085518/abd8cd9c-779b-4f17-b1a1-a9392366b98e


# Installation

1. Setup machine (raspberry pi in my case) running the BambuLabOBSOverlay python script that generates the telemetry.json file.
2. Install Apache instance
3. Change configuration of BambuLabOBSOverlay prjoject so that the output is /var/www/html or whatever your Apache root web directory is.
4. Point the scripts.js in the BambuBoard to the address of your apache server (10.0.0.69/telemetry.json for me).

Note: You can run it all on the same machine. I have a linux server (running the python script to generate telemtry.json file) and a rapsberry pi 4 running the BambuBoard dashboard to reaches out to that server to get the file. There is no reason you cant run this all on one machine. 

# Future growth
1. Native MQTT ability using Paho or MQTT.js library perhaps. Created branch to do some testing but havent had much luck.
