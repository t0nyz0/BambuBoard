#!/usr/bin/env node

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// Load configuration
const config = require('./config.json');
const printers = config.printers || [];

const app = express();
const PORT = process.env.VIDEO_STREAMER_PORT || 8081;

app.use(cors());
app.use(express.json());

// Store active streams
const activeStreams = new Map();

// Helper function to generate RTSP URL for Bambu Lab printers
function generateRTSPUrl(printer) {
    return `rtsps://bblp:${printer.accessCode}@${printer.url}:322/streaming/live/1`;
}

// Helper function to check if stream is active
function isStreamActive(printerId) {
    return activeStreams.has(printerId) && activeStreams.get(printerId).process && !activeStreams.get(printerId).process.killed;
}

// Start video stream for a printer
app.post('/stream/start/:printerId', (req, res) => {
    const printerId = req.params.printerId;
    const format = req.body.format || 'mjpeg'; // mjpeg, mp4, hls, webrtc
    const quality = req.body.quality || 'medium'; // low, medium, high
    
    const printer = printers.find(p => p.id === printerId);
    if (!printer) {
        return res.status(404).json({ error: 'Printer not found' });
    }
    
    if (isStreamActive(printerId)) {
        return res.status(400).json({ error: 'Stream already active', streamInfo: activeStreams.get(printerId) });
    }
    
    const rtspUrl = generateRTSPUrl(printer);
    const outputDir = path.join(__dirname, 'video_streams', printerId);
    
    // Create output directory
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    let ffmpegArgs = [];
    let outputPath = '';
    let streamUrl = '';
    
    // Configure FFmpeg based on format and quality
    switch (format) {
        case 'mjpeg':
            const qualitySettings = {
                low: { qv: 10, r: 10 },
                medium: { qv: 5, r: 15 },
                high: { qv: 2, r: 25 }
            };
            const settings = qualitySettings[quality];
            outputPath = path.join(outputDir, 'stream.mjpeg');
            streamUrl = `http://localhost:${PORT}/stream/${printerId}/mjpeg`;
            
            ffmpegArgs = [
                '-i', rtspUrl,
                '-f', 'mjpeg',
                '-q:v', settings.qv.toString(),
                '-r', settings.r.toString(),
                '-update', '1',
                outputPath
            ];
            break;
            
        case 'mp4':
            outputPath = path.join(outputDir, 'stream.mp4');
            streamUrl = `http://localhost:${PORT}/stream/${printerId}/mp4`;
            
            ffmpegArgs = [
                '-i', rtspUrl,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-crf', '23',
                '-f', 'mp4',
                '-movflags', 'frag_keyframe+empty_moov',
                outputPath
            ];
            break;
            
        case 'hls':
            const hlsDir = path.join(outputDir, 'hls');
            if (!fs.existsSync(hlsDir)) {
                fs.mkdirSync(hlsDir, { recursive: true });
            }
            streamUrl = `http://localhost:${PORT}/stream/${printerId}/hls/playlist.m3u8`;
            
            ffmpegArgs = [
                '-i', rtspUrl,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-crf', '23',
                '-f', 'hls',
                '-hls_time', '2',
                '-hls_list_size', '5',
                '-hls_flags', 'delete_segments',
                path.join(hlsDir, 'playlist.m3u8')
            ];
            break;
            
        default:
            return res.status(400).json({ error: 'Unsupported format' });
    }
    
    console.log(`Starting FFmpeg for printer ${printerId} with args:`, ffmpegArgs);
    
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Store stream information
    activeStreams.set(printerId, {
        process: ffmpegProcess,
        format: format,
        quality: quality,
        outputPath: outputPath,
        streamUrl: streamUrl,
        startTime: new Date(),
        rtspUrl: rtspUrl
    });
    
    // Handle FFmpeg output
    ffmpegProcess.stdout.on('data', (data) => {
        console.log(`FFmpeg stdout (${printerId}):`, data.toString());
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`FFmpeg stderr (${printerId}):`, data.toString());
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process for printer ${printerId} exited with code ${code}`);
        activeStreams.delete(printerId);
    });
    
    ffmpegProcess.on('error', (error) => {
        console.error(`FFmpeg error for printer ${printerId}:`, error);
        activeStreams.delete(printerId);
    });
    
    // Wait a moment for FFmpeg to start
    setTimeout(() => {
        if (isStreamActive(printerId)) {
            res.json({
                success: true,
                printerId: printerId,
                format: format,
                quality: quality,
                streamUrl: streamUrl,
                rtspUrl: rtspUrl,
                message: 'Stream started successfully'
            });
        } else {
            res.status(500).json({ error: 'Failed to start stream' });
        }
    }, 2000);
});

// Stop video stream
app.post('/stream/stop/:printerId', (req, res) => {
    const printerId = req.params.printerId;
    
    if (!isStreamActive(printerId)) {
        return res.status(404).json({ error: 'No active stream found' });
    }
    
    const streamInfo = activeStreams.get(printerId);
    streamInfo.process.kill('SIGTERM');
    
    activeStreams.delete(printerId);
    
    res.json({
        success: true,
        printerId: printerId,
        message: 'Stream stopped successfully'
    });
});

// Get stream status
app.get('/stream/status/:printerId', (req, res) => {
    const printerId = req.params.printerId;
    
    if (!isStreamActive(printerId)) {
        return res.json({
            active: false,
            printerId: printerId
        });
    }
    
    const streamInfo = activeStreams.get(printerId);
    const uptime = Date.now() - streamInfo.startTime.getTime();
    
    res.json({
        active: true,
        printerId: printerId,
        format: streamInfo.format,
        quality: streamInfo.quality,
        streamUrl: streamInfo.streamUrl,
        rtspUrl: streamInfo.rtspUrl,
        uptime: uptime,
        startTime: streamInfo.startTime
    });
});

// Get all active streams
app.get('/streams', (req, res) => {
    const streams = [];
    
    for (const [printerId, streamInfo] of activeStreams) {
        if (isStreamActive(printerId)) {
            const uptime = Date.now() - streamInfo.startTime.getTime();
            streams.push({
                printerId: printerId,
                format: streamInfo.format,
                quality: streamInfo.quality,
                streamUrl: streamInfo.streamUrl,
                uptime: uptime,
                startTime: streamInfo.startTime
            });
        }
    }
    
    res.json({
        activeStreams: streams,
        total: streams.length
    });
});

// Serve MJPEG stream
app.get('/stream/:printerId/mjpeg', (req, res) => {
    const printerId = req.params.printerId;
    
    if (!isStreamActive(printerId)) {
        return res.status(404).json({ error: 'Stream not active' });
    }
    
    const streamInfo = activeStreams.get(printerId);
    const outputPath = streamInfo.outputPath;
    
    if (!fs.existsSync(outputPath)) {
        return res.status(404).json({ error: 'Stream file not found' });
    }
    
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'close');
    
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    
    req.on('close', () => {
        stream.destroy();
    });
});

// Serve MP4 stream
app.get('/stream/:printerId/mp4', (req, res) => {
    const printerId = req.params.printerId;
    
    if (!isStreamActive(printerId)) {
        return res.status(404).json({ error: 'Stream not active' });
    }
    
    const streamInfo = activeStreams.get(printerId);
    const outputPath = streamInfo.outputPath;
    
    if (!fs.existsSync(outputPath)) {
        return res.status(404).json({ error: 'Stream file not found' });
    }
    
    const stat = fs.statSync(outputPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(outputPath, { start, end });
        
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        });
        fs.createReadStream(outputPath).pipe(res);
    }
});

// Serve HLS stream
app.use('/stream/:printerId/hls', express.static(path.join(__dirname, 'video_streams')));

// Test RTSP connection
app.post('/test-rtsp/:printerId', async (req, res) => {
    const printerId = req.params.printerId;
    const printer = printers.find(p => p.id === printerId);
    
    if (!printer) {
        return res.status(404).json({ error: 'Printer not found' });
    }
    
    const rtspUrl = generateRTSPUrl(printer);
    
    // Test RTSP connection using FFmpeg
    const ffmpegTest = spawn('ffmpeg', [
        '-i', rtspUrl,
        '-t', '5', // Test for 5 seconds
        '-f', 'null',
        '-'
    ], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let errorOutput = '';
    let success = false;
    
    ffmpegTest.stderr.on('data', (data) => {
        errorOutput += data.toString();
    });
    
    ffmpegTest.on('close', (code) => {
        success = code === 0;
        res.json({
            printerId: printerId,
            rtspUrl: rtspUrl,
            success: success,
            errorOutput: errorOutput,
            message: success ? 'RTSP connection successful' : 'RTSP connection failed'
        });
    });
    
    ffmpegTest.on('error', (error) => {
        res.json({
            printerId: printerId,
            rtspUrl: rtspUrl,
            success: false,
            error: error.message,
            message: 'Failed to test RTSP connection'
        });
    });
});

// Get printer information
app.get('/printers', (req, res) => {
    const printerInfo = printers.map(printer => ({
        id: printer.id,
        name: printer.name,
        url: printer.url,
        rtspUrl: generateRTSPUrl(printer),
        hasActiveStream: isStreamActive(printer.id)
    }));
    
    res.json(printerInfo);
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeStreams: activeStreams.size,
        uptime: process.uptime()
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down video streamer...');
    
    // Stop all active streams
    for (const [printerId, streamInfo] of activeStreams) {
        if (streamInfo.process) {
            streamInfo.process.kill('SIGTERM');
        }
    }
    
    activeStreams.clear();
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log(`Video Streamer running on port ${PORT}`);
    console.log(`Available printers: ${printers.map(p => p.name).join(', ')}`);
    console.log('Endpoints:');
    console.log(`  POST /stream/start/:printerId - Start video stream`);
    console.log(`  POST /stream/stop/:printerId - Stop video stream`);
    console.log(`  GET /stream/status/:printerId - Get stream status`);
    console.log(`  GET /streams - List all active streams`);
    console.log(`  GET /stream/:printerId/mjpeg - MJPEG stream`);
    console.log(`  GET /stream/:printerId/mp4 - MP4 stream`);
    console.log(`  GET /stream/:printerId/hls/playlist.m3u8 - HLS stream`);
    console.log(`  POST /test-rtsp/:printerId - Test RTSP connection`);
    console.log(`  GET /printers - List all printers`);
    console.log(`  GET /health - Health check`);
}); 