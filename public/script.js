// BambuBoard
// TZ | 11/20/23

//-------------------------------------------------------------------------------------------------------------
const protocol = window.location.protocol; // 'http:' or 'https:'
const serverURL = window.location.hostname; // IP of the computer running this dashboard
const serverPort = window.location.port;
//-------------------------------------------------------------------------------------------------------------

let currentState = "OFF";
let modelImage = "";
let tempSetting = "Fahrenheit"; // Celsius or Both
const consoleLogging = false;
let telemetryObjectMain;

// Preferences // Keep in mind these sdefault values overwrote in the next few steps
let displayFanPercentages = false; // Use percentages instead of icons for the fans
let displayFanIcons = true; // Use percentages instead of icons for the fans
const fullServerURL = `${protocol}//${serverURL}:${serverPort}`;

// Multi-Printer BambuBoard JavaScript
let printers = [];
let currentPrinterId = null;
let updateInterval;

// Initialize the multi-printer dashboard
$(document).ready(function() {
    loadPrinters();
    setInterval(loadPrinters, 5000); // Refresh printer list every 5 seconds
});

// Load printers and their status
async function loadPrinters() {
    try {
        const response = await fetch('/printers');
        if (response.ok) {
            printers = await response.json();
            updatePrinterTabs();
            updatePrinterOverview();
            
            // Load data for all printers
            await loadAllPrinterData();
        }
    } catch (error) {
        console.error('Error loading printers:', error);
    }
}

// Update printer tabs
function updatePrinterTabs() {
    const tabContainer = $('#printerTabs');
    tabContainer.empty();
    
    printers.forEach((printer, index) => {
        const tabClass = index === 0 ? 'tab active' : 'tab';
        const statusClass = getStatusClass(printer.status);
        
        const tab = $(`
            <div class="${tabClass}" data-printer-id="${printer.id}">
                <span class="printer-name">${printer.name}</span>
                <span class="status-indicator ${statusClass}"></span>
            </div>
        `);
        
        tab.click(function() {
            switchPrinter(printer.id);
        });
        
        tabContainer.append(tab);
    });
    
    // Set first printer as active if none selected
    if (printers.length > 0 && !currentPrinterId) {
        currentPrinterId = printers[0].id;
    }
}

// Update printer overview cards
function updatePrinterOverview() {
    const overviewContainer = $('#printerOverview');
    overviewContainer.empty();
    
    // Remove the dashboard selector buttons section entirely
    // The progress bar tiles will now serve as the dashboard selector
}

// Load data for all printers
async function loadAllPrinterData() {
    try {
        const response = await fetch('/all-printers-data');
        if (response.ok) {
            const allData = await response.json();
            
            // Update each printer's dashboard
            Object.keys(allData).forEach(printerId => {
                updatePrinterDashboard(printerId, allData[printerId]);
            });
        }
    } catch (error) {
        console.error('Error loading all printer data:', error);
    }
}

// Switch to a specific printer
function switchPrinter(printerId) {
    currentPrinterId = printerId;
    
    // Update tab selection
    $('.tab').removeClass('active');
    $(`.tab[data-printer-id="${printerId}"]`).addClass('active');
    
    // Show/hide dashboards
    $('.printer-dashboard').hide();
    $(`#dashboard-${printerId}`).show();
    
    // Load specific printer data
    loadPrinterData(printerId);
    
    // Initialize video feed for the selected printer
    initializeVideoFeed(printerId);
}

// Load data for a specific printer
async function loadPrinterData(printerId) {
    try {
        const response = await fetch(`/printer/${printerId}/data`);
        if (response.ok) {
            const data = await response.json();
            updatePrinterDashboard(printerId, data);
        }
    } catch (error) {
        console.error(`Error loading data for printer ${printerId}:`, error);
    }
}

// Update a specific printer's dashboard
function updatePrinterDashboard(printerId, data) {
    const dashboard = $(`#dashboard-${printerId}`);
    
    if (!dashboard.length) {
        // Create dashboard if it doesn't exist
        createPrinterDashboard(printerId);
    }
    
    if (data.error) {
        dashboard.html(`<div class="error-message">${data.error}</div>`);
        return;
    }

    // --- BEGIN: Transform data to expected structure ---
    if (data.print) {
        data.temperatures = {
            bed: {
                temper: data.print.bed_temper,
                target: data.print.bed_target_temper
            },
            nozzle: {
                temper: data.print.nozzle_temper,
                target: data.print.nozzle_target_temper
            },
            chamber: {
                temper: data.print.chamber_temper,
                target: data.print.chamber_target_temper || 0
            }
        };
        data.fans = {
            fan1: parseInt(data.print.big_fan1_speed) || 0,
            fan2: parseInt(data.print.big_fan2_speed) || 0,
            cooling: parseInt(data.print.cooling_fan_speed) || 0,
            heatbreak: parseInt(data.print.heatbreak_fan_speed) || 0
        };
        // wifi_signal is usually a string like "-18dBm"; extract the number and convert to a percentage (rough estimate)
        let wifiSignal = 100;
        if (data.print.wifi_signal) {
            const match = data.print.wifi_signal.match(/-?\d+/);
            if (match) {
                const dBm = parseInt(match[0]);
                wifiSignal = Math.max(0, Math.min(100, Math.round((dBm + 90) * 100 / 60)));
            }
        } else if (data.wifi_signal) {
            const match = data.wifi_signal.match(/-?\d+/);
            if (match) {
                const dBm = parseInt(match[0]);
                wifiSignal = Math.max(0, Math.min(100, Math.round((dBm + 90) * 100 / 60)));
            }
        }
        data.wifi = {
            signal: wifiSignal
        };
        // --- AMS transformation ---
        if (data.print.ams && data.print.ams.ams && Array.isArray(data.print.ams.ams)) {
            // Flatten all trays from all AMS units (if multiple)
            let trays = [];
            let amsEnv = { humidity: null, temp: null };
            data.print.ams.ams.forEach(amsUnit => {
                if (amsUnit.tray && Array.isArray(amsUnit.tray)) {
                    trays = trays.concat(amsUnit.tray.map(tray => ({
                        id: tray.id,
                        remaining: tray.remain,
                        info: {
                            name: tray.tray_id_name || tray.tray_type || 'Unknown',
                            type: tray.tray_type || 'Unknown',
                            color: tray.tray_color ? ('#' + tray.tray_color.substring(0,6)) : '#808080'
                        },
                        is_active: false // You can enhance this if you have active tray info
                    })));
                }
                // AMS environment
                if (amsUnit.humidity !== undefined) amsEnv.humidity = amsUnit.humidity;
                if (amsUnit.temp !== undefined) amsEnv.temp = amsUnit.temp;
            });
            data.ams = {
                trays: trays,
                humidity: amsEnv.humidity,
                temp: amsEnv.temp
            };
        }
        // --- END AMS transformation ---
        // --- Video URL ---
        if (data.print.ipcam && data.print.ipcam.rtsp_url) {
            data.videoUrl = data.print.ipcam.rtsp_url;
        }
        // --- END Video URL ---
        // --- Lights ---
        if (Array.isArray(data.print.lights_report)) {
            data.lights = data.print.lights_report.map(l => ({ node: l.node, mode: l.mode }));
        }
        // --- Errors/Warnings ---
        if (Array.isArray(data.print.hms)) {
            data.hardwareMessages = data.print.hms;
        }
    }
    // --- END: Transform data to expected structure ---

    // Update dashboard with printer data
    updateDashboardContent(printerId, data);
}

// Create a new printer dashboard
function createPrinterDashboard(printerId) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return;
    
    const dashboard = $(`
        <div class="printer-dashboard" id="dashboard-${printerId}" style="display: none;">
            <div class="dashboard-header">
                <h2>${printer.name} Dashboard</h2>
                <div class="printer-info">
                    <span>IP: ${printer.url}</span>
                    <span>Type: ${printer.type}</span>
                </div>
            </div>
            
            <!-- Video Feed Section -->
            <div class="video-section">
                <div class="video-header">
                    <h3>Live Video Feed</h3>
                    <div class="video-controls">
                        <button class="video-btn" onclick="toggleVideoFeed('${printerId}')" id="video-toggle-${printerId}">
                            <span class="material-symbols-outlined">play_arrow</span> Start Video
                        </button>
                        <button class="video-btn" onclick="refreshVideoFeed('${printerId}')">
                            <span class="material-symbols-outlined">refresh</span> Refresh
                        </button>
                        <button class="video-btn" onclick="openVideoFullscreen('${printerId}')">
                            <span class="material-symbols-outlined">fullscreen</span> Fullscreen
                        </button>
                    </div>
                </div>
                <div class="video-container" id="video-container-${printerId}">
                    <div class="video-placeholder" id="video-placeholder-${printerId}">
                        <span class="material-symbols-outlined">videocam_off</span>
                        <p>Video feed not started</p>
                        <p class="video-url">URL: http://${printer.url}/video</p>
                    </div>
                    <iframe id="video-frame-${printerId}" 
                            src="" 
                            frameborder="0" 
                            allowfullscreen 
                            style="display: none; width: 100%; height: 400px;">
                    </iframe>
                </div>
            </div>
            
            <div class="progressBarContainer">
                <div class="printStatus" id="printStatus-${printerId}">
                    Printer offline <span id="printPercentage-${printerId}"></span>
                </div>
                <div class="progress" id="printParentProgressBar-${printerId}">
                    <div class="progress-bar" style="width: 5px; background-color: grey;" id="printProgressBar-${printerId}"></div>
                </div>
            </div>
            
            <div class="bedcontainer light-border">
                <div class="bed-title">
                    <div class="grid grid-gap-30">
                        <div class="column grid-gap-10">
                            <div class="printDetailsContainer">
                                <h3><span class="fade printRemaining">Remaining:</span> <span class="printRemaining" id="printRemaining-${printerId}">unknown</span></h3>
                                <h3><span class="fade">ETA:</span> <span id="printETA-${printerId}">...</span></h3>
                                <h3><span class="fade">Model:</span> <span id="printModelName-${printerId}">...</span></h3>
                                <h3><span class="fade">Layer:</span> <span id="printCurrentLayer-${printerId}">...</span></h3>
                                <h3><span class="fade">Filament weight:</span> <span id="modelWeight-${printerId}">...</span></h3>
                                <h3><span class="fade">Speed: <span id="printSpeed-${printerId}" style="color: #51a34f;">Normal</span></span></h3>
                            </div>
                        </div>
                        <div class="column model-image grid-gap-10">
                            <div>
                                <img id="modelImage-${printerId}" src="plate.png"> 
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="bedcontainer">
                <div class="grid grid-gap-30">
                    <div class="column grid-gap-10">
                        <div class="bed-title">
                            <h2 class="partTitle">Bed Temperature</h2>
                            <div class="progress-wrapper">
                                <div id="bedProgressBarParent-${printerId}" class="progress">
                                    <div id="bedProgressBar-${printerId}" class="progress-bar" style="width: 5px; background-color: #FFCC41;"></div>
                                </div>
                            </div>
                            <div style="display: flex;justify-content: space-between;">
                                <h4 class="finePrint">
                                    <b>Current: <span id="bedCurrentTempC-${printerId}">0</span></b><span id="bedCurrentTempSymbolsC-${printerId}"><b><sup>°</sup>C</b></span> 
                                    <span style="color:grey;"><span id="bedCurrentTempF-${printerId}">0</span><span id="bedCurrentTempSymbolsF-${printerId}"><sup>°</sup>F</span></span>
                                </h4>
                                <h4 class="finePrint">
                                    <b>Target: <span id="bedTargetTempC-${printerId}">0</span><span id="bedTargetTempSymbolsC-${printerId}"><sup>°</sup>C</b></span> 
                                    <span style="color:grey;"><span id="bedTargetTempF-${printerId}">0</span><span id="bedTargetTempSymbolsF-${printerId}"><sup>°</sup>F</span></span>
                                </h4>
                            </div>
                        </div>
                        
                        <div class="bed-title">
                            <h2 class="partTitle">Nozzle Temperature</h2>
                            <div class="progress-wrapper">
                                <div id="nozzleProgressBarParent-${printerId}" class="progress">
                                    <div id="nozzleProgressBar-${printerId}" class="progress-bar" style="width: 5px; background-color: #5c0000;"></div>
                                </div>
                            </div>
                            <div style="display: flex;justify-content: space-between;">
                                <h4 class="finePrint">
                                    <b>Current: <span id="nozzleCurrentTempC-${printerId}">0</span></b><span id="nozzleCurrentTempSymbolsC-${printerId}"><b><sup>°</sup>C</b></span> 
                                    <span style="color:grey;"><span id="nozzleCurrentTempF-${printerId}">0</span><span id="nozzleCurrentTempSymbolsF-${printerId}"><sup>°</sup>F</span></span>
                                </h4>
                                <h4 class="finePrint">
                                    <b>Target: <span id="nozzleTargetTempC-${printerId}">0</span><span id="nozzleTargetTempSymbolsC-${printerId}"><sup>°</sup>C</b></span> 
                                    <span style="color:grey;"><span id="nozzleTargetTempF-${printerId}">0</span><span id="nozzleTargetTempSymbolsF-${printerId}"><sup>°</sup>F</span></span>
                                </h4>
                            </div>
                        </div>
                        
                        <div class="bed-title">
                            <h2 class="partTitle">Chamber Temperature</h2>
                            <div class="progress-wrapper">
                                <div id="chamberProgressBarParent-${printerId}" class="progress">
                                    <div id="chamberProgressBar-${printerId}" class="progress-bar" style="width: 5px; background-color: #5c0000;"></div>
                                </div>
                            </div>
                            <div style="display: flex;justify-content: space-between;">
                                <h4 class="finePrint">
                                    <b>Current: <span id="chamberCurrentTempC-${printerId}">0</span></b><span id="chamberCurrentTempSymbolsC-${printerId}"><b><sup>°</sup>C</b></span> 
                                    <span style="color:grey;"><span id="chamberCurrentTempF-${printerId}">0</span><span id="chamberCurrentTempSymbolsF-${printerId}"><sup>°</sup>F</span></span>
                                </h4>
                                <h4 class="finePrint">
                                    <b>Max: <span id="chamberTargetTempC-${printerId}">0</span><span id="chamberTargetTempSymbolsC-${printerId}"><sup>°</sup>C</b></span> 
                                    <span style="color:grey;"><span id="chamberTargetTempF-${printerId}">0</span><span id="chamberTargetTempSymbolsF-${printerId}"><sup>°</sup>F</span></span>
                                </h4>
                            </div>
                        </div>
                        
                        <div class="bed-title fans">
                            <h2 class="partTitle">Fans</h2>
                            <div class="fan-container flex">
                                <div class="fan1">
                                    <h4 class="finePrint">Fan 1</h4>
                                    <span id="fan1-${printerId}" class="material-symbols-outlined" style="will-change: transform;">toys_fan</span>
                                    <span id="fan1-percent-${printerId}" class="fan-percentage"></span>
                                </div>
                                <div class="fan2">
                                    <h4 class="finePrint">Fan 2</h4>
                                    <span id="fan2-${printerId}" class="material-symbols-outlined" style="will-change: transform;">toys_fan</span>
                                    <span id="fan2-percent-${printerId}" class="fan-percentage"></span>
                                </div>
                                <div class="fan3">
                                    <h4 class="finePrint">Cooling</h4>
                                    <span id="fan3-${printerId}" class="material-symbols-outlined" style="will-change: transform;">toys_fan</span>
                                    <span id="fan3-percent-${printerId}" class="fan-percentage"></span>
                                </div>
                                <div class="fan4">
                                    <h4 class="finePrint">Heatbreak</h4>
                                    <span id="fan4-${printerId}" class="material-symbols-outlined" style="will-change: transform;">toys_fan</span>
                                    <span id="fan4-percent-${printerId}" class="fan-percentage"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="column grid-gap-10">
                        <div class="bed-title">
                            <h2 class="partTitle">AMS</h2>
                            <div class="ams-container" id="ams-container-${printerId}">
                                <!-- AMS trays will be dynamically generated -->
                            </div>
                        </div>
                        
                        <div class="grid columns-2 grid-gap-30">
                            <div class="bed-title column">
                                <h2 class="partTitle">Nozzle</h2>
                                <div class="ams-container">
                                    <h4 class="finePrint">Type: <span id="nozzleType-${printerId}">Hardened Steel</span></h4>
                                    <h4 class="finePrint">Size: <span id="nozzleSize-${printerId}">0.4</span></h4>
                                </div>
                            </div>
                            
                            <div class="bed-title">
                                <h2 class="partTitle">Wifi</h2>
                                <div class="progress-wrapper">
                                    <div class="flex" style="justify-content: flex-end;">
                                        <h4 class="finePrint"><span id="wifiValue-${printerId}">100</span>%</h4>
                                    </div>
                                    <div id="wifiProgressBarParent-${printerId}" class="progress">
                                        <div id="wifiProgressBar-${printerId}" class="progress-bar" style="width: 25px; background-color: #51a34f;"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `);
    
    $('#printerDashboards').append(dashboard);
}

// Video feed functions
function initializeVideoFeed(printerId) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return;
    
    // Update video URL in placeholder
    $(`#video-placeholder-${printerId} .video-url`).text(`URL: http://${printer.url}/video`);
    
    // Check video feed availability
    checkVideoStatus(printerId);
}

function checkVideoStatus(printerId) {
    fetch(`/printer/${printerId}/video-status`)
        .then(response => response.json())
        .then(data => {
            const placeholder = $(`#video-placeholder-${printerId}`);
            if (data.available) {
                placeholder.find('p').first().text('Video feed available');
                placeholder.find('.material-symbols-outlined').text('videocam');
                placeholder.find('.material-symbols-outlined').css('color', '#51a34f');
            } else {
                placeholder.find('p').first().text('Video feed not available');
                placeholder.find('.material-symbols-outlined').text('videocam_off');
                placeholder.find('.material-symbols-outlined').css('color', '#e74c3c');
            }
        })
        .catch(error => {
            console.error('Error checking video status:', error);
            const placeholder = $(`#video-placeholder-${printerId}`);
            placeholder.find('p').first().text('Video feed error');
            placeholder.find('.material-symbols-outlined').text('error');
            placeholder.find('.material-symbols-outlined').css('color', '#e74c3c');
        });
}

function toggleVideoFeed(printerId) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return;
    
    const videoFrame = $(`#video-frame-${printerId}`);
    const videoPlaceholder = $(`#video-placeholder-${printerId}`);
    const toggleBtn = $(`#video-toggle-${printerId}`);
    
    if (videoFrame.is(':visible')) {
        // Stop video
        videoFrame.hide();
        videoPlaceholder.show();
        toggleBtn.html('<span class="material-symbols-outlined">play_arrow</span> Start Video');
    } else {
        // Start video using proxy endpoint
        const videoUrl = `/printer/${printerId}/video`;
        videoFrame.attr('src', videoUrl);
        videoFrame.show();
        videoPlaceholder.hide();
        toggleBtn.html('<span class="material-symbols-outlined">stop</span> Stop Video');
    }
}

function refreshVideoFeed(printerId) {
    const videoFrame = $(`#video-frame-${printerId}`);
    const currentSrc = videoFrame.attr('src');
    
    if (currentSrc) {
        videoFrame.attr('src', '');
        setTimeout(() => {
            videoFrame.attr('src', currentSrc);
        }, 100);
    }
    
    // Also refresh video status
    checkVideoStatus(printerId);
}

function openVideoFullscreen(printerId) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return;
    
    const videoUrl = `/printer/${printerId}/video`;
    const fullscreenWindow = window.open(videoUrl, '_blank', 'width=800,height=600,scrollbars=no,resizable=yes');
    
    if (fullscreenWindow) {
        fullscreenWindow.focus();
    }
}

// Update dashboard content with printer data
function updateDashboardContent(printerId, data) {
    if (!data || data.error) return;
    
    // Video feed
    if (data.videoUrl) {
        $(`#video-feed-${printerId}`).attr('src', data.videoUrl);
    }

    // Print status
    if (data.print) {
        const printData = data.print;
        // Debug log to confirm which value is being used
        console.log('Model name for printer', printerId, 'subtask_name:', printData.subtask_name, 'gcode_file:', printData.gcode_file);
        $(`#printStatus-${printerId}`).text(`${printData.gcode_state || ''}`);
        $(`#printProgress-${printerId}`).text(`${printData.mc_percent || 0}%`);
        $(`#printRemainingTime-${printerId}`).text(`${printData.mc_remaining_time || 0} min`);
        $(`#printLayer-${printerId}`).text(`${printData.layer_num || 0} / ${printData.total_layer_num || 0}`);
        // Model field: use subtask_name if available, else gcode_file
        $(`#printModelName-${printerId}`).text(printData.subtask_name ? printData.subtask_name : (printData.gcode_file || ''));
    }

    // Temperatures
    if (data.temperatures) {
        const temps = data.temperatures;
        $(`#bedTemp-${printerId}`).text(temps.bed.temper || '');
        $(`#bedTargetTemp-${printerId}`).text(temps.bed.target || '');
        $(`#nozzleTemp-${printerId}`).text(temps.nozzle.temper || '');
        $(`#nozzleTargetTemp-${printerId}`).text(temps.nozzle.target || '');
        $(`#chamberTemp-${printerId}`).text(temps.chamber.temper || '');
    }

    // Fans
    if (data.fans) {
        $(`#fan1Speed-${printerId}`).text(data.fans.fan1);
        $(`#fan2Speed-${printerId}`).text(data.fans.fan2);
        $(`#coolingFanSpeed-${printerId}`).text(data.fans.cooling);
        $(`#heatbreakFanSpeed-${printerId}`).text(data.fans.heatbreak);
    }

    // AMS
    if (data.ams) {
        $(`#amsHumidity-${printerId}`).text(data.ams.humidity || '');
        $(`#amsTemp-${printerId}`).text(data.ams.temp || '');
    }

    // Lights
    if (data.lights) {
        $(`#lightsStatus-${printerId}`).text(data.lights.map(l => `${l.node}: ${l.mode}`).join(', '));
    }

    // Errors/Warnings
    if (data.hardwareMessages) {
        $(`#hardwareMessages-${printerId}`).text(JSON.stringify(data.hardwareMessages));
    }

    // Update print status
    if (data.print) {
        const printData = data.print;
        const printStatus = printData.gcode_state;
        const printProgress = printData.mc_percent || 0;
        
        $(`#printStatus-${printerId}`).text(`${printStatus} ${printProgress}%`);
        $(`#printPercentage-${printerId}`).text(`${printProgress}%`);
        $(`#printProgressBar-${printerId}`).css('width', `${printProgress}%`);
        
        // Calculate ETA if mc_remaining_time is present
        let etaText = '...';
        if (printData.mc_remaining_time !== undefined && printData.mc_remaining_time !== null && printData.mc_remaining_time > 0) {
            const now = new Date();
            const etaDate = new Date(now.getTime() + printData.mc_remaining_time * 60 * 1000);
            const hours = etaDate.getHours();
            const minutes = etaDate.getMinutes();
            const ampm = hours >= 12 ? 'pm' : 'am';
            const formattedHours = hours % 12 === 0 ? 12 : hours % 12;
            const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
            etaText = `${formattedHours}:${formattedMinutes}${ampm}`;
        } else if (printStatus === 'FINISH') {
            etaText = 'Done';
        } else if (printStatus === 'FAILED') {
            etaText = '';
        }
        
        // Update print details
        $(`#printRemaining-${printerId}`).text(printData.remaining_time || 'unknown');
        $(`#printETA-${printerId}`).text(etaText);
        $(`#printModelName-${printerId}`).text(printData.subtask_name ? printData.subtask_name : (printData.gcode_file || ''));
        $(`#printCurrentLayer-${printerId}`).text(printData.layer_num || '...');
        $(`#printSpeed-${printerId}`).text(printData.spd_lvl || 'Normal');
    }
    
    // Update temperatures
    if (data.temperatures) {
        const temps = data.temperatures;
        
        // Bed temperature
        if (temps.bed) {
            const bedCurrent = temps.bed.temper || 0;
            const bedTarget = temps.bed.target || 0;
            
            $(`#bedCurrentTempC-${printerId}`).text(bedCurrent);
            $(`#bedCurrentTempF-${printerId}`).text(Math.round(bedCurrent * 9/5 + 32));
            $(`#bedTargetTempC-${printerId}`).text(bedTarget);
            $(`#bedTargetTempF-${printerId}`).text(Math.round(bedTarget * 9/5 + 32));
            
            // Update progress bar
            const bedProgress = bedTarget > 0 ? (bedCurrent / bedTarget) * 100 : 0;
            $(`#bedProgressBar-${printerId}`).css('width', `${Math.min(bedProgress, 100)}%`);
        }
        
        // Nozzle temperature
        if (temps.nozzle) {
            const nozzleCurrent = temps.nozzle.temper || 0;
            const nozzleTarget = temps.nozzle.target || 0;
            
            $(`#nozzleCurrentTempC-${printerId}`).text(nozzleCurrent);
            $(`#nozzleCurrentTempF-${printerId}`).text(Math.round(nozzleCurrent * 9/5 + 32));
            $(`#nozzleTargetTempC-${printerId}`).text(nozzleTarget);
            $(`#nozzleTargetTempF-${printerId}`).text(Math.round(nozzleTarget * 9/5 + 32));
            
            // Update progress bar
            const nozzleProgress = nozzleTarget > 0 ? (nozzleCurrent / nozzleTarget) * 100 : 0;
            $(`#nozzleProgressBar-${printerId}`).css('width', `${Math.min(nozzleProgress, 100)}%`);
        }
        
        // Chamber temperature
        if (temps.chamber) {
            const chamberCurrent = temps.chamber.temper || 0;
            const chamberTarget = temps.chamber.target || 0;
            
            $(`#chamberCurrentTempC-${printerId}`).text(chamberCurrent);
            $(`#chamberCurrentTempF-${printerId}`).text(Math.round(chamberCurrent * 9/5 + 32));
            $(`#chamberTargetTempC-${printerId}`).text(chamberTarget);
            $(`#chamberTargetTempF-${printerId}`).text(Math.round(chamberTarget * 9/5 + 32));
            
            // Update progress bar
            const chamberProgress = chamberTarget > 0 ? (chamberCurrent / chamberTarget) * 100 : 0;
            $(`#chamberProgressBar-${printerId}`).css('width', `${Math.min(chamberProgress, 100)}%`);
        }
    }
    
    // Update fans
    if (data.fans) {
        const fans = data.fans;
        
        // Update fan speeds and animations
        Object.keys(fans).forEach((fanKey, index) => {
            const fanSpeed = fans[fanKey] || 0;
            const fanId = index + 1;
            
            $(`#fan${fanId}-${printerId}`).css('animation-duration', `${Math.max(0.5, 2 - fanSpeed/50)}s`);
            $(`#fan${fanId}-percent-${printerId}`).text(`${fanSpeed}%`);
        });
    }
    
    // Update AMS
    if (data.ams) {
        updateAMS(printerId, data.ams);
    }
    
    // Update wifi
    if (data.wifi) {
        const wifiSignal = data.wifi.signal || 100;
        $(`#wifiValue-${printerId}`).text(wifiSignal);
        $(`#wifiProgressBar-${printerId}`).css('width', `${wifiSignal}%`);
    }
}

// Update AMS information
function updateAMS(printerId, amsData) {
    const amsContainer = $(`#ams-container-${printerId}`);
    amsContainer.empty();
    
    if (amsData.trays) {
        amsData.trays.forEach((tray, index) => {
            const trayId = index + 1;
            const isActive = tray.is_active;
            const remaining = tray.remaining || 0;
            const material = tray.info?.name || 'Unknown';
            const color = tray.info?.color || '#808080';
            
            const trayElement = $(`
                <div class="element">
                    <span id="tray${trayId}Color-${printerId}" class="dot" style="background-color: ${color};"></span>
                    <div class="dot-content">
                        <div class="flex">
                            <h3 id="tray${trayId}Material-${printerId}" class="material">${material}</h3>
                            <span id="tray${trayId}Active-${printerId}" class="badge-active" style="display:${isActive ? 'inline' : 'none'}">active</span>
                        </div>
                        <div class="ams-type-remaining">
                            <h4 id="tray${trayId}Type-${printerId}" class="finePrint">${material} • ${tray.info?.type || 'Unknown'}</h4>
                            <h4 id="tray${trayId}Remaining-${printerId}" class="finePrint">${remaining}%</h4>
                        </div>
                        <div class="progress-wrapper">
                            <div id="tray${trayId}ProgressBarParent-${printerId}" class="progress">
                                <div id="tray${trayId}ProgressBar-${printerId}" class="progress-bar" style="width: ${remaining}%; background-color: #51a34f;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            `);
            
            amsContainer.append(trayElement);
        });
    }
}

// Helper function to get status class
function getStatusClass(status) {
    switch (status) {
        case 'online': return 'status-online';
        case 'offline': return 'status-offline';
        case 'error': return 'status-error';
        default: return 'status-unknown';
    }
}

// Start periodic updates
setInterval(() => {
    if (currentPrinterId) {
        loadPrinterData(currentPrinterId);
    }
}, 2000); // Update every 2 seconds

async function retrieveData() {
  // Setting: Point this URL to your local server that is generating the telemetry data from Bambu
  const response = await fetch(fullServerURL + "/data.json");

  let data = await response.text();
  let telemetryObject = JSON.parse(data);

  if (telemetryObject.print && 'gcode_state' in telemetryObject.print) {
    currentState = telemetryObject.print.gcode_state;
    telemetryObject = telemetryObject.print;
  }
  else if (telemetryObject.print)
  {
    telemetryObject = "Incomplete";
  } 
  else
  {
    telemetryObject = null;
  }

  return telemetryObject;
}

async function loadPreferences() {
  try {
      const response = await fetch(fullServerURL + '/preference-fan-icons');
      if (response.ok) {
          const data = await response.json();
          displayFanIcons = data;
      } 

      const response2 = await fetch(fullServerURL + '/preference-fan-percentages');
      if (response.ok) {

          const data = await response2.json();
          displayFanPercentages = data;
      } 
  } catch (error) {
      console.error('Error loading preferences:', error);
  }
}

function convertToPercentage(value) {
  if (value < 0 || value > 15) {
    throw new Error("Value must be between 0 and 15");
  }
  let percentage = (value / 15) * 100;
  return percentage.toFixed(0) + "%"; // Returns percentage with '%' sign and 2 decimal places
}

async function updateUI(telemetryObject) {
  try {
    

    let printStatus = telemetryObject.gcode_state;
    let progressParentWidth = $("#printParentProgressBar").width();

    // mc_remaining_time in minutes
    const mcRemainingTime = telemetryObject.mc_remaining_time;

    const now = new Date();
    const futureTime = new Date(now.getTime() + mcRemainingTime * 60 * 1000); // Convert minutes to milliseconds

    // Extract hours and minutes
    const hours = futureTime.getHours();
    const minutes = futureTime.getMinutes();

    // Determine AM or PM suffix
    const ampm = hours >= 12 ? 'pm' : 'am';

    // Format hours for 12-hour format and handle midnight/noon cases
    const formattedHours = hours % 12 === 0 ? 12 : hours % 12;

    // Ensure minutes are two digits
    const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;

    // Format the future time
    const formattedTime = `${formattedHours}:${formattedMinutes}${ampm}`;

    log(formattedTime);


    let modelName = telemetryObject.gcode_file;
    modelName = modelName.replace("/data/Metadata/", "");

    $("#printModelName").text(telemetryObject.subtask_name);
    $("#printCurrentLayer").text(
      telemetryObject.layer_num + " of " + telemetryObject.total_layer_num
    );

    if (printStatus === "RUNNING") {
      printStatus = "Printing";
      $("#printProgressBar").css("background-color", "#51a34f");
      $("#printStatus").text(
        printStatus + "... " + telemetryObject.mc_percent + "%"
      );
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
        );
        let readableTimeRemaining = convertMinutesToReadableTime(telemetryObject.mc_remaining_time);
        
        if (readableTimeRemaining == 0)
        {
          readableTimeRemaining = "...";
        }
        
        $("#printRemaining").text(readableTimeRemaining);
        $("#printETA").text(formattedTime);
    } else if (printStatus === "FINISH") {
   
      printStatus = "Print Complete";
      $("#printStatus").text(printStatus + "... ");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "grey");
      $("#printRemaining").text(telemetryObject.mc_remaining_time);
      $("#printETA").text("Done");
      $("#printRemaining").text("...");
    } else if (printStatus === "FAILED") {
      $("#printStatus").text("Print failed" + "... ");
      $("#printProgressBar").width(
        (telemetryObject.mc_percent * progressParentWidth) / 100
      );
      $("#printProgressBar").css("background-color", "#red");
      $("#printRemaining").text(telemetryObject.mc_remaining_time);
      $("#printETA").text("");
      $("#printRemaining").text("...");
    }

    /// Bed Temp

    let bedTargetTemp = 0;
    let bedTempPercentage = 1;
    // Bed Target Temp
    if (telemetryObject.bed_target_temper === 0) {
      bedTargetTemp = "OFF";
    } else {
      
      bedTargetTemp = (telemetryObject.bed_target_temper * 9) / 5 + 32;
      
      bedTempPercentage =
        (telemetryObject.bed_temper / telemetryObject.bed_target_temper) * 100;
    }
    log("bedTargetTemp = " + bedTargetTemp);
    log("bedTempPercentage = " + bedTempPercentage);

    if (bedTempPercentage > 100) {
      log(
        "Bed percentage over 100, adjusting..." + nozzleTempPercentage
      );
      bedTempPercentage = 100;
    }

    // Set target temp in UI
    $("#bedTargetTempF").text(bedTargetTemp);
    $("#bedTargetTempC").text(telemetryObject.bed_target_temper);

    // Set current temp in UI
    var bedCurrentTempF = Math.round((telemetryObject.bed_temper * 9) / 5 + 32);
    $("#bedCurrentTempF").text(bedCurrentTempF);

    var bedCurrentTempC = Math.round(telemetryObject.bed_temper);
    $("#bedCurrentTempC").text(bedCurrentTempC);

    log("bedCurrentTemp = " + bedCurrentTempF);
    let progressBedParentWidth = $("#bedProgressBarParent").width();

    log("progressBedParentWidth = " + progressBedParentWidth);
    $("#bedProgressBar").width(
      (bedTempPercentage * progressBedParentWidth) / 100
    );

    if (bedTargetTemp === "OFF") {
      $("#bedProgressBar").css("background-color", "grey");

      $("#bedTargetTempC").hide();
      $("#bedTargetTempSymbolsF").hide();
      $("#bedTargetTempSymbolsC").hide();
    } else {
      if (tempSetting.BambuBoard_tempSetting === "Fahrenheit")
      {
        $("#bedTargetTempSymbolsF").show();
        $("#bedCurrentTempSymbolsF").show();
        $("#bedTargetTempF").show();
        $("#bedCurrentTempF").show();

        $("#bedCurrentTempC").hide();
        $("#bedTargetTempSymbolsC").hide();
        $("#bedCurrentTempSymbolsC").hide();
        $("#bedTargetTempC").hide();
      }
      else if (tempSetting.BambuBoard_tempSetting === "Celsius")
      {
        $("#bedTargetTempSymbolsF").hide();
        $("#bedCurrentTempSymbolsF").hide();
        $("#bedTargetTempF").hide();
        $("#bedCurrentTempF").hide();

        $("#bedCurrentTempC").show();
        $("#bedTargetTempSymbolsC").show();
        $("#bedCurrentTempSymbolsC").show();
        $("#bedTargetTempC").show();
      }
      else if (tempSetting.BambuBoard_tempSetting === "Both")
      {
        $("#bedTargetTempSymbolsF").show();
        $("#bedCurrentTempSymbolsF").show();
        $("#bedTargetTempF").show();
        $("#bedCurrentTempF").show();

        $("#bedCurrentTempC").show();
        $("#bedTargetTempSymbolsC").show();
        $("#bedCurrentTempSymbolsC").show();
        $("#bedTargetTempC").show();
      }

      if (bedTempPercentage > 80) {
        $("#bedProgressBar").css("background-color", "red");
      } else if (bedTempPercentage > 50) {
        $("#bedProgressBar").css("background-color", "yellow");
      } else {
        $("#bedProgressBar").css("background-color", "#51a34f");
      }
    }

    /// Nozzle Temp
    let nozzleTargetTemp = 0;
    let nozzleTempPercentage = 1;
    // Bed Target Temp
    if (telemetryObject.nozzle_target_temper === 0) {
      nozzleTargetTemp = "OFF";
    } else {
      nozzleTargetTemp = (telemetryObject.nozzle_target_temper * 9) / 5 + 32;
      nozzleTempPercentage =
        (telemetryObject.nozzle_temper / telemetryObject.nozzle_target_temper) *
        100;
    }

    if (nozzleTempPercentage > 100) {
      log(
        "Nozzle percentage over 100, adjusting..." + nozzleTempPercentage
      );
      nozzleTempPercentage = 100;
    }

    log("nozzleTargetTemp = " + nozzleTargetTemp);
    log("nozzleTempPercentage = " + nozzleTempPercentage);

    // Set target temp in UI
    $("#nozzleTargetTempF").text(nozzleTargetTemp);
    $("#nozzleTargetTempC").text(telemetryObject.nozzle_target_temper);

    // Set current temp in UI
    var nozzleCurrentTemp = Math.round((telemetryObject.nozzle_temper * 9) / 5 + 32);
    $("#nozzleCurrentTempF").text(nozzleCurrentTemp);
    
    var nozzleCurrentTempC = Math.round(telemetryObject.nozzle_temper);
    $("#nozzleCurrentTempC").text(nozzleCurrentTempC);

    log("nozzleCurrentTemp = " + nozzleCurrentTemp);

    let progressNozzleParentWidth = $("#nozzleProgressBarParent").width();
    log("progressNozzleParentWidth = " + progressNozzleParentWidth);
    $("#nozzleProgressBar").width(
      (nozzleTempPercentage * progressNozzleParentWidth) / 100
    );

    if (nozzleTargetTemp === "OFF") {
      $("#nozzleProgressBar").css("background-color", "grey");

      $("#nozzleTargetTempC").hide();
      $("#nozzleTargetTempSymbolsF").hide();
      $("#nozzleTargetTempSymbolsC").hide();
    } else {
      if (tempSetting === "Fahrenheit")
      {
        $("#nozzleTargetTempSymbolsF").show();
        $("#nozzleCurrentTempSymbolsF").show();
        $("#nozzleTargetTempF").show();
        $("#nozzleCurrentTempF").show();

        $("#nozzleCurrentTempC").hide();
        $("#nozzleTargetTempSymbolsC").hide();
        $("#nozzleCurrentTempSymbolsC").hide();
        $("#nozzleTargetTempC").hide();
      }
      else if (tempSetting === "Celsius")
      {
        $("#nozzleTargetTempSymbolsF").hide();
        $("#nozzleCurrentTempSymbolsF").hide();
        $("#nozzleTargetTempF").hide();
        $("#nozzleCurrentTempF").hide();

        $("#nozzleCurrentTempC").show();
        $("#nozzleTargetTempSymbolsC").show();
        $("#nozzleCurrentTempSymbolsC").show();
        $("#nozzleTargetTempC").show();
      }
      else if (tempSetting === "Both")
      {
        $("#nozzleTargetTempSymbolsF").show();
        $("#nozzleCurrentTempSymbolsF").show();
        $("#nozzleTargetTempF").show();
        $("#nozzleCurrentTempF").show();

        $("#nozzleCurrentTempC").show();
        $("#nozzleTargetTempSymbolsC").show();
        $("#nozzleCurrentTempSymbolsC").show();
        $("#nozzleTargetTempC").show();
      }

      if (nozzleTempPercentage > 80) {
        $("#nozzleProgressBar").css("background-color", "red");
      } else if (nozzleTempPercentage > 50) {
        $("#nozzleProgressBar").css("background-color", "yellow");
      } else {
        $("#nozzleProgressBar").css("background-color", "#51a34f");
      }
    }

    /// Chamber Temperature
    let chamberTargetTempF = 140;
    let chamberTargetTempC = 60;
    let chamberTempPercentage = 1;
    // Bed Target Temp

    // Set target temp in UI
    $("#chamberTargetTempF").text(chamberTargetTempF);
    $("#chamberTargetTempC").text(chamberTargetTempC);

    // Set current temp in UI
    var chamberCurrentTemp = (telemetryObject.chamber_temper * 9) / 5 + 32;
    $("#chamberCurrentTempF").text(chamberCurrentTemp);
    $("#chamberCurrentTempC").text(telemetryObject.chamber_temper );

    log("chamberCurrentTemp = " + chamberCurrentTemp);

    chamberTempPercentage = (chamberCurrentTemp / chamberTargetTempF) * 100;

    let progressChamberParentWidth = $("#chamberProgressBarParent").width();
    log("progressChamberParentWidth = " + progressChamberParentWidth);
    $("#chamberProgressBar").width(
      (chamberTempPercentage * progressChamberParentWidth) / 100
    );

    if (tempSetting === "Fahrenheit")
      {
        $("#chamberTargetTempSymbolsF").show();
        $("#chamberCurrentTempSymbolsF").show();
        $("#chamberTargetTempF").show();
        $("#chamberCurrentTempF").show();

        $("#chamberCurrentTempC").hide();
        $("#chamberTargetTempSymbolsC").hide();
        $("#chamberCurrentTempSymbolsC").hide();
        $("#chamberTargetTempC").hide();
      }
      else if (tempSetting === "Celsius")
      {
        $("#chamberTargetTempSymbolsF").hide();
        $("#chamberCurrentTempSymbolsF").hide();
        $("#chamberTargetTempF").hide();
        $("#chamberCurrentTempF").hide();

        $("#chamberCurrentTempC").show();
        $("#chamberTargetTempSymbolsC").show();
        $("#chamberCurrentTempSymbolsC").show();
        $("#chamberTargetTempC").show();
      }
      else if (tempSetting === "Both")
      {
        $("#chamberTargetTempSymbolsF").show();
        $("#chamberCurrentTempSymbolsF").show();
        $("#chamberTargetTempF").show();
        $("#chamberCurrentTempF").show();

        $("#chamberCurrentTempC").show();
        $("#chamberTargetTempSymbolsC").show();
        $("#chamberCurrentTempSymbolsC").show();
        $("#chamberTargetTempC").show();
      }

    if (chamberCurrentTemp > 110) {
      $("#chamberProgressBar").css("background-color", "red");
    } else if (chamberCurrentTemp > 100) {
      $("#chamberProgressBar").css("background-color", "yellow");
    } else {
      $("#chamberProgressBar").css("background-color", "#51a34f");
    }

    if (currentState !== "RUNNING") {
      $("#chamberProgressBar").css("background-color", "grey");
    }

    /// Nozzle

    var nozzleType = telemetryObject.nozzle_type;
    var nozzleSize = telemetryObject.nozzle_diameter;
    var printSpeed = telemetryObject.spd_lvl;

    if (nozzleType === "hardened_steel") {
      nozzleType = "Hardened Steel";
    }

    $("#nozzleType").text(nozzleType);
    $("#nozzleSize").text(nozzleSize);

    //printSpeed
    if (printSpeed === 1) {
      $("#printSpeed").css("color", "green");
      $("#printSpeed").text("Silent");
    } else if (printSpeed === 2) {
      $("#printSpeed").css("color", "#51a34f");
      $("#printSpeed").text("Normal");
    } else if (printSpeed === 3) {
      $("#printSpeed").text("Sport");
      $("#printSpeed").css("color", "yellow");
    } else if (printSpeed === 4) {
      $("#printSpeed").text("Ludicrous");
      $("#printSpeed").css("color", "red");
    } else {
      $("#printSpeed").text(printSpeed);
      $("#printSpeed").css("color", "grey");
    }

    if (currentState !== "RUNNING") {
      $("#printSpeed").css("color", "grey");
    }

    log(telemetryObject.t_utc);
    return telemetryObject;
  } catch (error) {
    console.error("Error: ", error);
  }
}

// Some issues were found lumping all the DOM updates into the updateUI() function, split fans into their own function.
async function updateFans(telemetryObject) {
  try {
    /// Fans
    let fan1Speed = telemetryObject.big_fan1_speed;
    let fan2Speed = telemetryObject.big_fan2_speed;
    let fan3Speed = telemetryObject.cooling_fan_speed;
    let fan4Speed = telemetryObject.heatbreak_fan_speed;

    /// Update preferences 
    if (displayFanIcons == true || displayFanIcons == "true")
      {
        $("#fan1").show();
        $("#fan2").show();
        $("#fan3").show();
        $("#fan4").show();
      }
      else
      {
        $("#fan1").hide();
        $("#fan2").hide();
        $("#fan3").hide();
        $("#fan4").hide();
      }
    if (displayFanPercentages == true || displayFanPercentages == "true")
    {
      $("#fan1-percent").show();
      $("#fan2-percent").show();
      $("#fan3-percent").show();
      $("#fan4-percent").show();
    }
    else
    {
      $("#fan1-percent").hide();
      $("#fan2-percent").hide();
      $("#fan3-percent").hide();
      $("#fan4-percent").hide();
    }

    // Fan 1
    $("#fan1-percent").text(convertToPercentage(fan1Speed));

    switch (fan1Speed) {
      case "0":
        $("#fan1").css({'-webkit-animation': ''});
        break;
      case "1":
        updateAnimation("#fan1", 'spin 5s infinite linear');
        break;
      case "2":
        updateAnimation("#fan1", 'spin 4.5s infinite linear');
        break;
      case "3":
        updateAnimation("#fan1", 'spin 4s infinite linear');
        break;
      case "4":
        updateAnimation("#fan1", 'spin 3.5s infinite linear');
        break;
      case "5":
        updateAnimation("#fan1", 'spin 3s infinite linear');
        break;
      case "6":
        updateAnimation("#fan1", 'spin 2.5s infinite linear');
        break;
      case "7":
        updateAnimation("#fan1", 'spin 2s infinite linear');
        break;
      case "8":
        updateAnimation("#fan1", 'spin 1.8s infinite linear');
        break;
      case "9":
        updateAnimation("#fan1", 'spin 1.5s infinite linear');
        break;
      case "10":
        updateAnimation("#fan1", 'spin 1.2s infinite linear');
        break;
      case "11":
        updateAnimation("#fan1", 'spin 1.0s infinite linear');
        break;
      case "12":
        updateAnimation("#fan1", 'spin .5s infinite linear');
        break;
      case "13":
        updateAnimation("#fan1", 'spin .45s infinite linear');
        break;
      case "14":
        updateAnimation("#fan1", 'spin .4s infinite linear');
        break;
      case "15":
        updateAnimation("#fan1", 'spin .37s infinite linear');
        break;
      default:
        break;
    }

// Fan 2
  $("#fan2-percent").text(convertToPercentage(fan2Speed));
    switch (fan2Speed) {
      case "0":
        $("#fan2").css({'-webkit-animation': ''});
        break;
      case "1":
        updateAnimation("#fan2", 'spin 5s infinite linear');
        break;
      case "2":
        updateAnimation("#fan2", 'spin 4.5s infinite linear');
        break;
      case "3":
        updateAnimation("#fan2", 'spin 4s infinite linear');
        break;
      case "4":
        updateAnimation("#fan2", 'spin 3.5s infinite linear');
        break;
      case "5":
        updateAnimation("#fan2", 'spin 3s infinite linear');
        break;
      case "6":
        updateAnimation("#fan2", 'spin 2.5s infinite linear');
        break;
      case "7":
        updateAnimation("#fan2", 'spin 2s infinite linear');
        break;
      case "8":
        updateAnimation("#fan2", 'spin 1.8s infinite linear');
        break;
      case "9":
        updateAnimation("#fan2", 'spin 1.5s infinite linear');
        break;
      case "10":
        updateAnimation("#fan2", 'spin 1.2s infinite linear');
        break;
      case "11":
        updateAnimation("#fan2", 'spin 1.0s infinite linear');
        break;
      case "12":
        updateAnimation("#fan2", 'spin .5s infinite linear');
        break;
      case "13":
        updateAnimation("#fan2", 'spin .45s infinite linear');
        break;
      case "14":
        updateAnimation("#fan2", 'spin .4s infinite linear');
        break;
      case "15":
        updateAnimation("#fan2", 'spin .37s infinite linear');
        break;
      default:
        break;
    }

    // Fan 3
    $("#fan3-percent").text(convertToPercentage(fan3Speed));
    switch (fan3Speed) {
      case "0":
        $("#fan3").css({'-webkit-animation': ''});
        break;
      case "1":
        updateAnimation("#fan3", 'spin 5s infinite linear');
        break;
      case "2":
        updateAnimation("#fan3", 'spin 4.5s infinite linear');
        break;
      case "3":
        updateAnimation("#fan3", 'spin 4s infinite linear');
        break;
      case "4":
        updateAnimation("#fan3", 'spin 3.5s infinite linear');
        break;
      case "5":
        updateAnimation("#fan3", 'spin 3s infinite linear');
        break;
      case "6":
        updateAnimation("#fan3", 'spin 2.5s infinite linear');
        break;
      case "7":
        updateAnimation("#fan3", 'spin 2s infinite linear');
        break;
      case "8":
        updateAnimation("#fan3", 'spin 1.8s infinite linear');
        break;
      case "9":
        updateAnimation("#fan3", 'spin 1.5s infinite linear');
        break;
      case "10":
        updateAnimation("#fan3", 'spin 1.2s infinite linear');
        break;
      case "11":
        updateAnimation("#fan3", 'spin 1.0s infinite linear');
        break;
      case "12":
        updateAnimation("#fan3", 'spin .5s infinite linear');
        break;
      case "13":
        updateAnimation("#fan3", 'spin .45s infinite linear');
        break;
      case "14":
        updateAnimation("#fan3", 'spin .4s infinite linear');
        break;
      case "15":
        updateAnimation("#fan3", 'spin .37s infinite linear');
        break;
      default:
        break;
    }


    // Fan 4
    $("#fan4-percent").text(convertToPercentage(fan4Speed));
    switch (fan4Speed) {
      case "0":
        $("#fan4").css({'-webkit-animation': ''});
        break;
      case "1":
        updateAnimation("#fan4", 'spin 5s infinite linear');
        break;
      case "2":
        updateAnimation("#fan4", 'spin 4.5s infinite linear');
        break;
      case "3":
        updateAnimation("#fan4", 'spin 4s infinite linear');
        break;
      case "4":
        updateAnimation("#fan4", 'spin 3.5s infinite linear');
        break;
      case "5":
        updateAnimation("#fan4", 'spin 3s infinite linear');
        break;
      case "6":
        updateAnimation("#fan4", 'spin 2.5s infinite linear');
        break;
      case "7":
        updateAnimation("#fan4", 'spin 2s infinite linear');
        break;
      case "8":
        updateAnimation("#fan4", 'spin 1.8s infinite linear');
        break;
      case "9":
        updateAnimation("#fan4", 'spin 1.5s infinite linear');
        break;
      case "10":
        updateAnimation("#fan4", 'spin 1.2s infinite linear');
        break;
      case "11":
        updateAnimation("#fan4", 'spin 1.0s infinite linear');
        break;
      case "12":
        updateAnimation("#fan4", 'spin .5s infinite linear');
        break;
      case "13":
        updateAnimation("#fan4", 'spin .45s infinite linear');
        break;
      case "14":
        updateAnimation("#fan4", 'spin .4s infinite linear');
        break;
      case "15":
        updateAnimation("#fan4", 'spin .37s infinite linear');
        break;
      default:
        break;
    }
  } catch (error) {
    console.error("Error: ", error);
  }
}

async function updateWifi(telemetryObject) {
  /// Wifi
  const wifiValue = telemetryObject.wifi_signal;

  log("Wifi Signal: " + wifiValue);
  const wifiFormated = wifiValue.replace("dBm", "");
  const signalPercentage = dBmToPercentage(parseInt(wifiFormated));
  log("Wifi percentage: " + signalPercentage);

  let wifiNozzleParentWidth = $("#wifiProgressBarParent").width();

  $("#wifiProgressBar").width((signalPercentage * wifiNozzleParentWidth) / 100);

  if (signalPercentage > 80) {
    $("#wifiProgressBar").css("background-color", "#51a34f");
  } else if (signalPercentage > 40) {
    $("#wifiProgressBar").css("background-color", "yellow");
  } else if (signalPercentage > 30) {
    $("#wifiProgressBar").css("background-color", "red");
  }

  if (currentState !== "RUNNING") {
    $("#wifiProgressBar").css("background-color", "grey");
  }

  $("#wifiValue").text(signalPercentage);
}

async function executeTask() {
  try {
      var telemetryObject = telemetryObjectMain;
      if (telemetryObject != null && telemetryObject != "Incomplete") {
          if (telemetryObject.layer_num == 0 && currentState == "RUNNING" || modelImage == "") {
              await loginAndFetchImage();
          }
      } 
      else if (telemetryObject == null){
        await loginAndFetchImage();
      }
  } catch (error) {
      //console.error(error);
      await sleep(12000);
  }
}

// Run the task immediately
executeTask();

function convertMinutesToReadableTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
      return hours + " hour" + (hours > 1 ? "s " : " ") + minutes + " minute" + (minutes !== 1 ? "s" : "");
  } else {
      return minutes + " minute" + (minutes !== 1 ? "s" : "");
  }
}

  // Send credentials to your own server
  async function loginAndFetchImage() {
    try {
        const response =  await fetch(fullServerURL + '/login-and-fetch-image', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        let data; 

        if (response.status == 401)
        {
          window.location.href = 'login.html';
        }
        else
        {
          data = await response.json();
        }

        // Display the image using the extracted URL
        displayAPIData(data);

    } catch (error) {
        console.error('Error fetching model image:', error);
    }
  
    async function loadSettings() {
      try {
          const serverURL = window.location.hostname;
          const response = await fetch(fullServerURL + '/settings');
          if (response.ok) {
              const data = await response.json();
              tempSetting = data;
          } 
      } catch (error) {
          console.error('Error loading settings:', error);
      }
    }

    loadSettings();
    loadPreferences();



    function displayAPIData(data) {
      if (data.imageUrl == "NOTENROLLED") {
        $('#modelImage').hide();
      } else {
        if (data.modelWeight != null) {
          if ($("#printModelName").text() != data.modelName) {
            $("#printModelName2").text(" | " + data.modelName);
          } else {
            $("#printModelName2").text("");
          }
          $("#modelWeight").text(data.modelWeight + "g");
          const imageElement = $('#modelImage').attr('src', data.imageUrl);
          $('#modelImage').show();
          modelImage = data.imageUrl;
          $("#totalPrints").text(data.totalPrints);
        }
      }
    }
  
 }

// --- Main Printer Grid (Live) ---
async function fetchAllPrintersData() {
    try {
        const res = await fetch('/all-printers-data', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to fetch printer data');
        return await res.json();
    } catch (e) {
        console.error(e);
        return null;
    }
}

function renderMainPrinterGrid(printersData) {
    const gridContainer = document.getElementById('mainPrinterGrid');
    if (!gridContainer) return;
    let html = '<div class="printer-grid">';
    if (!printersData || Object.keys(printersData).length === 0) {
        html += '<div>No printer data available.</div>';
    } else {
        Object.entries(printersData).forEach(([printerId, data]) => {
            // Get the actual printer name from the printers array
            const printer = printers.find(p => p.id === printerId);
            let name = printer?.name || data?.print?.printer_name || data?.name || printerId;
            let status = data?.print?.gcode_state || data?.print?.print_status || 'UNKNOWN';
            // Use mc_percent for actual progress, fallback to percent if mc_percent is not available
            let percent = data?.print?.mc_percent !== undefined ? parseInt(data.print.mc_percent) : 
                         (data?.print?.percent !== undefined ? parseInt(data.print.percent) : 0);
            let eta = data?.print?.mc_remaining_time ? 
                     convertMinutesToReadableTime(data.print.mc_remaining_time) : 
                     (data?.print?.eta || '...');
            let model = data?.print?.subtask_name || data?.print?.gcode_file || data?.print?.mc_filename || '...';
            
            // Determine progress bar color class and card class
            let progressBarClass = percent === 100 ? 'progress-bar yellow' : 'progress-bar';
            let cardClass = percent === 100 ? 'printer-card yellow' : 'printer-card';
            
            html += `
                <div class="${cardClass} dashboard-tile" data-printer-id="${printerId}" style="--progress: ${percent}; cursor: pointer;" onclick="switchPrinter('${printerId}')">
                    <div class="printer-title">${name}</div>
                    <div class="status-row">
                        <span class="status-label">${status}</span>
                        <span class="percent-label">${percent}%</span>
                    </div>
                    <div class="progress"><div class="${progressBarClass}" style="width: ${percent}%;">&nbsp;</div></div>
                    <div class="info-row"><span class="label">ETA:</span> <span class="value">${eta}</span></div>
                    <div class="info-row"><span class="label">Model:</span> <span class="value">${model}</span></div>
                </div>
            `;
        });
    }
    html += '</div>';
    gridContainer.innerHTML = html;
}

async function updateMainPrinterGrid() {
    const data = await fetchAllPrintersData();
    renderMainPrinterGrid(data);
}

document.addEventListener('DOMContentLoaded', function() {
    updateMainPrinterGrid();
    setInterval(updateMainPrinterGrid, 1000);
});
