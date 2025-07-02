# Multi-Printer BambuBoard Setup Guide

## Overview

BambuBoard has been enhanced to support multiple BambuLab printers in a single dashboard. The application now runs completely offline (LAN-only) and can manage multiple printers simultaneously.

## Key Features

✅ **Multi-Printer Management**: Monitor multiple printers from one dashboard  
✅ **LAN-Only Operation**: No internet connection required  
✅ **Real-Time Status**: Live status indicators for each printer  
✅ **Tabbed Interface**: Easy switching between printer dashboards  
✅ **Overview Cards**: Quick status view of all printers  
✅ **Offline Assets**: All web resources are local  

## Quick Setup

### 1. Configuration

Copy the example configuration and customize it for your printers:

```bash
cp example.config.json config.json
```

Edit `config.json` with your printer details:

```json
{
  "BambuBoard_httpPort": 8080,
  "BambuBoard_tempSetting": "Both",
  "BambuBoard_displayFanPercentages": false,
  "BambuBoard_displayFanIcons": true,
  "BambuBoard_logging": false,
  "printers": [
    {
      "id": "printer1",
      "name": "X1 Carbon",
      "url": "192.168.1.100",
      "port": "8883",
      "serialNumber": "01S00A1234567890",
      "accessCode": "12345678",
      "type": "X1"
    },
    {
      "id": "printer2", 
      "name": "P1P",
      "url": "192.168.1.101",
      "port": "8883",
      "serialNumber": "01S00B1234567890",
      "accessCode": "87654321",
      "type": "P1P"
    }
  ]
}
```

### 2. Printer Information Required

For each printer, you need:
- **IP Address**: Your printer's local IP address
- **Serial Number**: Found on the printer or in Bambu Studio
- **Access Code**: Found in Bambu Studio under "Device" → "Access Code"
- **Type**: Printer model (X1, P1P, A1, P1)

### 3. Installation & Running

Install dependencies:
```bash
npm install
```

Start the application:
```bash
node bambuConnection.js
```

Access the dashboard:
```
http://localhost:8080
```

## Interface Overview

### Printer Tabs
- Switch between different printers
- Real-time status indicators
- Active printer highlighted

### Overview Cards
- Quick status of all printers
- Connection status (online/offline/error)
- Last update time
- Direct access to individual dashboards

### Individual Dashboards
- Full printer monitoring interface
- Temperature monitoring (bed, nozzle, chamber)
- Print progress and status
- AMS (Automatic Material System) status
- Fan speeds and animations
- WiFi signal strength

## Network Requirements

- **Local Network Access**: Direct access to printer IP addresses
- **MQTT Protocol**: Port 8883 (TLS encrypted)
- **No Internet**: Completely offline operation

## Troubleshooting

### Printer Not Connecting
1. Verify IP address is correct
2. Check serial number format
3. Ensure access code is correct
4. Verify printer is on the same network

### Status Indicators
- 🟢 **Green**: Printer online and connected
- 🔴 **Red**: Connection error
- ⚫ **Gray**: Printer offline
- 🟡 **Yellow**: Unknown status

### Common Issues
- **"Printer offline"**: Check network connectivity
- **"Access denied"**: Verify access code
- **"Connection timeout"**: Check IP address and port

## Configuration Options

### Global Settings
- `BambuBoard_httpPort`: Web interface port (default: 8080)
- `BambuBoard_tempSetting`: Temperature display ("C", "F", or "Both")
- `BambuBoard_displayFanPercentages`: Show fan percentages
- `BambuBoard_displayFanIcons`: Show fan icons
- `BambuBoard_logging`: Enable console logging

### Per-Printer Settings
- `id`: Unique identifier for the printer
- `name`: Display name in the interface
- `url`: Printer IP address
- `port`: MQTT port (usually 8883)
- `serialNumber`: Printer serial number
- `accessCode`: Printer access code
- `type`: Printer model type

## API Endpoints

The application provides several API endpoints:

- `GET /printers` - List all printers and their status
- `GET /printer/:id/data` - Get data for specific printer
- `GET /all-printers-data` - Get data for all printers
- `GET /settings` - Get current configuration
- `POST /settings/update` - Update configuration

## File Structure

```
BambuBoard/
├── bambuConnection.js          # Main application
├── config.json                 # Printer configuration
├── example.config.json         # Example configuration
├── public/
│   ├── index.html              # Main dashboard
│   ├── script.js               # Frontend JavaScript
│   ├── styles.css              # Styling
│   ├── assets/                 # Local web resources
│   │   ├── js/                 # JavaScript libraries
│   │   ├── css/                # Stylesheets
│   │   └── fonts/              # Font files
│   └── data_<printerId>.json   # Printer data files
```

## Security Notes

- Access codes are stored in plain text in config.json
- MQTT connections use TLS encryption
- No authentication required for web interface
- Consider firewall rules for production use

## Support

For issues or questions:
1. Check the troubleshooting section
2. Verify network connectivity
3. Review configuration settings
4. Check console logs if logging is enabled 