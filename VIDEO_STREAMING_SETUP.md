# BambuBoard Video Streaming Setup

This document explains how to set up and use video streaming functionality in BambuBoard for Bambu Lab printers.

## Overview

BambuBoard now includes video streaming capabilities that allow you to:
1. View real-time status updates via WebSocket
2. Access RTSP stream information for external tools
3. Monitor your printer's camera feed using third-party applications

## Prerequisites

### 1. Enable LAN Mode Liveview on Your Printer

Before you can access the camera feed, you must enable LAN Mode Liveview on your Bambu Lab printer:

1. On your printer's touchscreen, go to **Settings → General**
2. Turn on the **"LAN Mode Liveview"** option
3. Note the **LAN Access Code** that appears - this is your password for the RTSP stream
4. The username is always `bblp` (Bambu Lab's default user)

**Note:** This feature requires firmware version 01.06.00.00 or newer.

### 2. Update Your Configuration

Make sure your `config.json` includes the correct access code:

```json
{
  "printers": [
    {
      "id": "printer1",
      "name": "X1 Carbon dual ams",
      "url": "192.168.178.72",
      "port": "8883",
      "serialNumber": "00M09D490202752",
      "accessCode": "8fb2d151",  // Your LAN Access Code
      "type": "X1"
    }
  ]
}
```

## Video Streaming Features

### 1. Real-Time Status Display

BambuBoard provides a WebSocket-based status display that shows:
- Printer connection status
- Last update time
- RTSP stream information
- Instructions for external tools

**To use:**
1. Open BambuBoard in your browser
2. Navigate to your printer's dashboard
3. Click "Start Status" in the video section
4. View real-time status updates on the canvas

### 2. RTSP Stream Access

The printer's camera feed is available via RTSP over TLS (RTSPS) at:
```
rtsps://bblp:<access_code>@<printer_ip>:322/streaming/live/1
```

For your printer, this would be:
```
rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1
```

## External Tools for Video Streaming

### 1. VLC Media Player

**Installation:**
- macOS: `brew install vlc`
- Windows: Download from https://www.videolan.org/
- Linux: `sudo apt install vlc`

**Usage:**
```bash
vlc rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1
```

### 2. FFmpeg

**Installation:**
- macOS: `brew install ffmpeg`
- Windows: Download from https://ffmpeg.org/
- Linux: `sudo apt install ffmpeg`

**Usage Examples:**

Convert to MJPEG stream:
```bash
ffmpeg -i "rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1" -f mjpeg -q:v 5 -r 15 output.mjpeg
```

Save to file:
```bash
ffmpeg -i "rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1" -c copy recording.mp4
```

Stream to HTTP server:
```bash
ffmpeg -i "rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1" -f mjpeg -q:v 5 -r 15 http://localhost:8081/stream.mjpeg
```

### 3. Advanced Streaming Solutions

For more advanced setups, consider these tools:

#### go2rtc
A powerful streaming server that can convert RTSP to various formats:

```yaml
# go2rtc.yaml
streams:
  bambu_cam: rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1
```

#### MediaMTX (rtsp-simple-server)
Another streaming server with WebRTC support:

```yaml
# mediamtx.yml
paths:
  bambu:
    source: rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1
    sourceProtocol: tcp
```

## API Endpoints

### 1. Stream Information
```
GET /printer/{printerId}/stream-info
```

Returns information about the video stream including:
- RTSP URL
- WebSocket URL
- Instructions for setup
- External tool commands

### 2. WebSocket Status Stream
```
WS /printer/{printerId}/stream
```

Provides real-time status updates via WebSocket.

## Troubleshooting

### Common Issues

1. **"Video feed not available"**
   - Ensure LAN Mode Liveview is enabled on the printer
   - Check that the access code in config.json matches the printer's code
   - Verify the printer is on the same network

2. **"Connection refused" errors**
   - Check that the printer IP address is correct
   - Ensure the printer is powered on and connected to the network
   - Try restarting the printer

3. **RTSP stream not working**
   - Verify the access code is correct
   - Check that LAN Mode Liveview is enabled
   - Try using VLC to test the RTSP URL directly

4. **WebSocket connection issues**
   - Check that the BambuBoard server is running
   - Verify the WebSocket URL in the browser console
   - Check for firewall blocking WebSocket connections

### Testing RTSP Stream

To test if your RTSP stream is working:

1. **Using VLC:**
   ```bash
   vlc rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1
   ```

2. **Using FFmpeg:**
   ```bash
   ffmpeg -i "rtsps://bblp:8fb2d151@192.168.178.72:322/streaming/live/1" -t 10 test.mp4
   ```

3. **Using curl (for stream info):**
   ```bash
   curl -s http://localhost:8080/printer/printer1/stream-info
   ```

## Security Considerations

1. **Network Security:**
   - The RTSP stream is only accessible on your local network
   - Do not expose the stream to the internet
   - Use a VPN if you need remote access

2. **Access Code Security:**
   - Keep your LAN access code secure
   - Do not share it in public repositories
   - Generate a new code if compromised

3. **Printer Security:**
   - Enable LAN Only Mode for complete isolation
   - Regularly update printer firmware
   - Monitor network access

## Future Enhancements

Potential improvements for video streaming:

1. **Integrated Video Player:**
   - Add a built-in video player using WebRTC
   - Implement MJPEG streaming directly in the browser
   - Add video recording capabilities

2. **Advanced Features:**
   - Motion detection
   - Time-lapse recording
   - Video archiving
   - Multiple camera support

3. **Mobile Support:**
   - Mobile-optimized video interface
   - Push notifications for events
   - Touch-friendly controls

## Support

For issues with video streaming:

1. Check the BambuBoard console for error messages
2. Verify your printer's LAN Mode Liveview settings
3. Test the RTSP stream with external tools
4. Check the printer's network connectivity
5. Review the troubleshooting section above

## References

- [Bambu Lab X1C MQTT Community Thread](https://community.home-assistant.io/t/bambu-lab-x1-x1c-mqtt/489510/22)
- [go2rtc Documentation](https://github.com/AlexxIT/go2rtc)
- [MediaMTX Documentation](https://github.com/bluenviron/mediamtx)
- [JSMpeg Library](https://github.com/phoboslab/jsmpeg)
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html) 