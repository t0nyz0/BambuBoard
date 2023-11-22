# BambuBoard
Bambu Dashboard for viewing real time data from the Bambu X1 Carbon 3D printer.

This project uses the telemetry.json data generated from this python project:
https://github.com/MikeSiekkinen/BambuLabOBSOverlay

Video at regular speed:

https://github.com/t0nyz0/BambuBoard/assets/63085518/dcb52ef7-1618-423a-8f2e-9ade0b3ef51b

Video (2.5x) during startup of a print

https://github.com/t0nyz0/BambuBoard/assets/63085518/abd8cd9c-779b-4f17-b1a1-a9392366b98e


Installation

1. Setup machine (raspberry pi in my case) running the BambuLabOBSOverlay python script that generates the telemetry.json file.
2. Install Apache instance
3. Change configuration of BambuLabOBSOverlay prjoject so that the output is /var/www/html or whatever your Apache root web directory is.
4. Point the scripts.js in the BambuBoard to the address of your apache server (10.0.0.69/telemetry.json for me).
