# BambuBoard Offline Setup

## Changes Made

### External Dependencies Localized

1. **jQuery 3.6.0**: Downloaded to `public/assets/js/jquery-3.6.0.min.js`
2. **Bootstrap 5.3.0**: Downloaded to `public/assets/css/bootstrap.min.css` and `public/assets/js/bootstrap.bundle.min.js`
3. **Material Symbols Font**: Downloaded to `public/assets/fonts/material-symbols-outlined.ttf`
4. **Google Fonts**: Downloaded IBM Plex Mono, Open Sans, Oxygen, and Red Hat Display fonts

### Multi-Printer Support Added

1. **Backend Changes**:
   - Complete rewrite of `bambuConnection.js` to support multiple printers
   - Each printer gets its own MQTT connection and data file (`data_<printerId>.json`)
   - New API endpoints for multi-printer management
   - LAN-only mode (no cloud authentication required)

2. **Frontend Changes**:
   - New tabbed interface for switching between printers
   - Printer overview cards showing status of all printers
   - Dynamic dashboard generation for each printer
   - Real-time status indicators

3. **Configuration**:
   - Updated `example.config.json` to support multiple printers
   - Each printer has its own settings (IP, port, serial number, access code)

### Files Updated

- All HTML files updated to use local assets instead of external URLs
- CSS files updated to import local font definitions
- Widget files automatically updated using sed commands
- New multi-printer JavaScript functionality
- Enhanced CSS for multi-printer interface

### Configuration Example

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
      "url": "10.0.0.1",
      "port": "8883",
      "serialNumber": "FILL_THIS_OUT",
      "accessCode": "FILL_THIS_OUT",
      "type": "X1"
    },
    {
      "id": "printer2", 
      "name": "P1P",
      "url": "10.0.0.2",
      "port": "8883",
      "serialNumber": "FILL_THIS_OUT",
      "accessCode": "FILL_THIS_OUT",
      "type": "P1P"
    }
  ]
}
```

### Remaining External Dependencies

Only BambuLab API endpoints remain (required for authentication and printer data):
- User login/authentication endpoints
- Printer data endpoints
- These are NOT needed for LAN-only operation

### Setup Instructions

1. Copy `example.config.json` to `config.json`
2. Fill in your printer details (IP, serial number, access code)
3. Add multiple printers to the `printers` array
4. Run the application: `node bambuConnection.js`
5. Access the dashboard at `http://localhost:8080`

### Features

- **Multi-Printer Management**: Monitor multiple printers from a single dashboard
- **Real-Time Status**: Live status indicators for each printer
- **Tabbed Interface**: Easy switching between printer dashboards
- **Overview Cards**: Quick status view of all printers
- **LAN-Only Operation**: No internet connection required
- **Offline Assets**: All web resources are local

### Network Requirements

- Local network access to printer IP addresses
- MQTT over TLS (port 8883) to each printer
- No internet connection required 