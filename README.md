<div align="center">

<img src="public/assets/bambuboard-prism.svg" alt="BambuBoard Prism mark" width="64" height="64">

# BambuBoard

**Turn your Bambu Lab printer into a live stream overlay.**
Show the printer camera, progress, temperatures, filament and toolpath in a single OBS Browser Source. BambuBoard runs on your own computer or NAS and connects to one printer per instance.

<br>

[![Version](https://img.shields.io/github/package-json/v/t0nyz0/BambuBoard?style=flat-square&color=51a34f&label=version)](https://github.com/t0nyz0/BambuBoard/releases)
[![License](https://img.shields.io/github/license/t0nyz0/BambuBoard?style=flat-square&color=51a34f)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ed?style=flat-square&logo=docker&logoColor=white)](https://github.com/t0nyz0/BambuBoard/pkgs/container/bambuboard)
[![Build](https://img.shields.io/github/actions/workflow/status/t0nyz0/BambuBoard/docker-publish.yml?branch=main&style=flat-square&label=build)](https://github.com/t0nyz0/BambuBoard/actions/workflows/docker-publish.yml)
[![Server tests](https://img.shields.io/badge/server_tests-163-51a34f?style=flat-square)](.github/workflows/validate.yml)
[![Stars](https://img.shields.io/github/stars/t0nyz0/BambuBoard?style=flat-square&color=51a34f)](https://github.com/t0nyz0/BambuBoard/stargazers)

[Quickstart](#quickstart) · [Install](#install-bambuboard) · [Screenshots](#screenshots) · [Supported printers](#supported-printers) · [Widget catalog](#widget-catalog) · [Troubleshooting](#troubleshooting)

<a href="screenshots/STUDIO-LIVE.png"><img src="screenshots/STUDIO-LIVE.png" alt="BambuBoard Live workspace showing an H2D print, its camera feed and dashboard widgets" width="100%"></a>

</div>

---

## Quickstart

[Install BambuBoard](#install-bambuboard) on a computer or NAS that will stay on while you print and can reach your printer over the local network.

### Setup, layout and OBS

Have your printer's **IP address, serial number and LAN access code** ready. These are available through the printer's settings and Bambu Studio. Menu labels vary by model and firmware.

1. Open BambuBoard at `http://localhost:8080` if it runs on this computer, or `http://<computer-or-nas-ip>:8080` if it runs elsewhere. In **Setup**, enter the printer's own IP address, serial number and LAN access code. Choose **Save and connect**.
2. Wait until BambuBoard receives printer data, then choose **Open live preview**. The built-in layout is ready to use. Bambu Cloud sign-in is optional and adds MakerWorld and other cloud details.
3. For OBS, choose **Copy Browser Source URL** and use the displayed width and height, or **Download an OBS scene** and import it in OBS. To change the supplied layout, choose **Customize layout**, edit the draft, and select **Apply to Live** when ready.

## Install BambuBoard

Docker images are available for `linux/amd64` and `linux/arm64`. [Version 3.3.3 release notes](docs/release-notes-3.3.3.md). Updating an existing instance? [Keep its current data mount and follow the upgrade steps](#upgrading-an-existing-docker-installation).

| Where BambuBoard runs | How to install |
| --- | --- |
| Windows, Mac, or Linux computer | [Docker Desktop or Docker Engine](#docker-on-a-computer) |
| Synology NAS | [Container Manager](#synology-nas-container-manager) |
| QNAP, Portainer, or TrueNAS | [Paste a Compose file](#qnap-portainer-and-truenas) |
| Development or custom installation | [Run from source](#from-source) |

### Synology NAS (Container Manager)

For a new install on DSM 7.2 or later, check that your NAS model supports [Synology Container Manager](https://www.synology.com/en-us/dsm/packages/ContainerManager).

Docker Hub also lists the public image as **t0nyz/bambuboard**. [Docker Hub listing](https://hub.docker.com/r/t0nyz/bambuboard)

1. Install **Container Manager** from **Package Center**.
2. Open **Container Manager → Project → Create**, name the project `bambuboard`, and choose a project folder. Paste this Compose file in the editor, or save it as `docker-compose.yml` and upload it. [Synology Project guide](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project)

   ```yaml
   services:
     bambuboard:
       image: ghcr.io/t0nyz0/bambuboard:latest
       restart: unless-stopped
       ports:
         - "8080:8080"
       volumes:
         - bambuboard-data:/usr/src/app/data

   volumes:
     bambuboard-data:
   ```

3. Finish the wizard, start the project, and open `http://<your-nas-ip>:8080`. [Connect your printer](#setup-layout-and-obs).

The named volume keeps settings, scenes and cached files across container updates. If port 8080 is already in use on the NAS, change the left-hand port in `8080:8080` and open that port in your browser. [Synology bind mounts and terminal installs](#synology-bind-mounts-and-terminal-installs).

### QNAP, Portainer and TrueNAS

Use the same Compose file for a new installation. Keep the named data volume when updating.

- **QNAP Container Station** — Paste it under **Applications → Create**. Use `18080:8080` because QTS commonly uses port 8080 for NAS management, then open `http://<your-nas-ip>:18080`. [Container Station setup](https://www.qnap.com/en/how-to/tutorial/article/how-to-use-container-station-3) · [QNAP system ports](https://www.qnap.com/en-uk/how-to/faq/article/what-network-ports-are-used-by-qts-quts-hero-and-qutscloud-systems)
- **Portainer** — Paste it in **Stacks → Add stack → Web editor**. [Portainer stack setup](https://docs.portainer.io/user/docker/stacks/add)
- **TrueNAS** — From **Apps → Discover**, open the menu and choose **Install via YAML** on a version that supports Docker apps. [TrueNAS custom app setup](https://apps.truenas.com/managing-apps/installing-custom-apps/)

### Docker on a computer

Start Docker Desktop on Windows or Mac. On Linux, start Docker Desktop or Docker Engine. [Docker Desktop installation](https://docs.docker.com/desktop/)

Open Terminal or PowerShell and run:

```text
docker run -d --name bambuboard --restart unless-stopped -p 8080:8080 -v bambuboard-data:/usr/src/app/data ghcr.io/t0nyz0/bambuboard:latest
```

Open `http://localhost:8080`, or use `http://<your-host-ip>:8080` if Docker runs on another machine. [Connect your printer](#setup-layout-and-obs).

The `bambuboard-data` volume keeps your setup and layouts across updates. If port 8080 is already in use, change `8080:8080` to `18080:8080` and open port 18080 instead.

[`docker-compose.yml`](docker-compose.yml) is an alternative for a repository checkout and builds the image locally. Run `docker compose up -d` and configure the printer in Setup. To pick up base-image and OS security updates when rebuilding locally, run `docker compose build --pull --no-cache` before `docker compose up -d`. Explicit `BAMBUBOARD_*` environment overrides take precedence over saved values when the app starts. Keep the included `OBS_settings` directory when using its template mount.

### From source

Use **Node.js 24** (see [`.nvmrc`](.nvmrc)) and **npm 11 or newer**. Install a maintained system FFmpeg for RTSPS cameras and direct YouTube streaming. For example, run `sudo apt-get update && sudo apt-get install -y ffmpeg` on Debian or Ubuntu, or `brew install ffmpeg` on macOS. On Windows, use a current Windows build listed on the [FFmpeg download page](https://ffmpeg.org/download.html).

Check `ffmpeg -version`. BambuBoard uses the `ffmpeg` executable on `PATH`. To choose a different one, set `FFMPEG_BIN` to the executable path in the terminal or service that starts BambuBoard.

With Node.js and npm ready, install and start BambuBoard.

```bash
git clone https://github.com/t0nyz0/BambuBoard.git
cd BambuBoard
npm ci
npm start
```

Open **http://localhost:8080**. Docker includes FFmpeg and Chromium. Server YouTube capture also needs Chromium or Chrome on source installs. [Streaming setup](docs/youtube-streaming.md#requirements)

## Layout and OBS tips

If a widget's details are cut off, select it and choose **Fit to content**. **Content width** and **Content height** change how much room its content has. **Visual scale** changes how large the whole widget appears.

Select **Gcode Toolpath**. Under **Toolpath view**, use **Print angle** and **Print zoom**. Set zoom to 100% to fit the print. These choices are saved with the draft and appear in OBS after **Apply to Live**. You can also change angle and zoom temporarily from the standalone toolpath preview.

**`/live` is the broadcast output; `/` is the management page.** The broadcast renders the published snapshot, falling back to a matching default template before the first publication. Re-publish to update it automatically. If OBS runs on another machine, use the BambuBoard host's address rather than `localhost`.

Match the Browser Source dimensions and OBS **Settings → Video → Base (Canvas) Resolution** to the published scene size shown under Live preview. The OBS download includes that size, including custom resolutions. A differently sized browser viewport scales the scene to fit and may letterbox. Use `/live?transparent=1` to make the page background transparent; individual widget and scene backgrounds still apply.

Default templates are layout starters in [`OBS_settings/templates`](OBS_settings/templates): `default-x1` for single-nozzle layouts and `default-h2d` for the H2D-class dual layout. The editor chooses by detected type and falls back to `default-x1`. Customize the starter to match your actual hardware, including its AMS selection.

---

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>Setup</h4>
      <p>Connect your printer and confirm it is sending data. Optional cloud sign-in is available from Setup.</p>
      <a href="screenshots/STUDIO-SETUP.png"><img src="screenshots/STUDIO-SETUP.png" alt="Setup page" width="100%"></a>
    </td>
    <td width="50%" valign="top">
      <h4>Layout editor</h4>
      <p>Arrange widgets using the canvas, Layers panel and inspector. Save a draft, then choose Apply to Live when it is ready.</p>
      <a href="screenshots/STUDIO-LAYOUT.png"><img src="screenshots/STUDIO-LAYOUT.png" alt="Layout editor" width="100%"></a>
    </td>
  </tr>
</table>

Screenshots show the actual app in an isolated demo installation, with sample telemetry, sample cloud responses and a recorded H2D camera feed. Saved widget themes remain independent of the app theme. [View the mobile Live page](screenshots/STUDIO-MOBILE.png).

---

## What it does

- **Design and apply an overlay.** Arrange widgets with drag/resize, Layers, grid snapping and Undo/Redo. **Save draft** keeps your edits. **Apply to Live** updates the output with the saved revision and selected live scene. Use **Restore previous live** to bring back the previous output.
- **Show printer telemetry and camera together.** Progress, temperatures, fans, AMS trays and reported drying status sit alongside a camera feed relayed by BambuBoard. Camera transport is selected from the printer's detected type.
- **Preview the sliced toolpath.** The G-code widget downloads the current print over FTPS, validates sliced archives, and loads dense plates incrementally. It shows estimated nozzle motion and a colored cooling trail behind fresh extrusion. Use **Setup → Diagnostics → Test G-code connection** to check file access, or use the toolpath preview for retries, diagnostics, and manual file recovery. [Toolpath limits and recovery](docs/gcode-resilience.md).
- **Run on your LAN.** App scripts, fonts and other assets are bundled locally. Core telemetry, camera and toolpath features do not require cloud sign-in. Optional Bambu Cloud data supplies MakerWorld content and extra print details.
- **Stream directly to YouTube (beta).** The optional section at the bottom of Live can render `/live` on the server, continuing after you close the controls, or share a browser tab with optional tab audio. Choose quality, check setup, monitor encoding and download redacted diagnostics. Browser sharing needs HTTPS or localhost; server capture works from an HTTP LAN address. [Streaming setup and limitations](docs/youtube-streaming.md).

## Upgrading an existing Docker installation

Since 3.3.2, BambuBoard runs as UID and GID `1000:1000` by default and reports its health using its local HTTP listener. A new named volume works with the default user. Keep your current volume when upgrading.

- For an existing writable mount, upgrade with the same mount. If the owner is a different non-root UID and GID, you can keep that ownership by setting Docker `--user UID:GID` or Compose `user: "UID:GID"`. The runtime user needs read and write access to BambuBoard's files and directories.
- If an older root-run container owns the data, stop the old container and back up its data. Pull the new image, then run this one-time command. Replace `/absolute/path/to/current-data` with the actual bind path or existing Docker volume name.

  ```bash
  docker run --rm --network none --user 0:0 \
    -v "/absolute/path/to/current-data:/usr/src/app/data" \
    ghcr.io/t0nyz0/bambuboard:latest node scripts/docker-migrate-data.js
  ```

  For Compose, build or pull the updated image and use the same service and file as your installation. For the Synology file, insert `-f docker-compose.synology.yml` before `run`.

  ```bash
  docker compose run --rm --no-deps --user 0:0 bambuboard node scripts/docker-migrate-data.js
  ```

  The command can also prepare a new bind mount created by Docker for Compose. It updates ownership and owner permissions of BambuBoard data and leaves the contents and unrelated files alone. Start the updated container with its default user after the command succeeds. The install/update scripts perform this step for their own data mount when required. If a NAS or network share restricts ownership changes, set permissions on the host or use the mount's existing non-root UID and GID.

### Synology bind mounts and terminal installs

The [Synology Compose file](docker-compose.synology.yml) pulls the published image, uses host networking and mounts `~/bambuboard-data`. Save the file on your NAS, then follow the [Compose data preparation steps](#upgrading-an-existing-docker-installation) before starting a new bind mount or upgrading older root-owned data.

```bash
docker compose -f docker-compose.synology.yml pull
docker compose -f docker-compose.synology.yml up -d
```

Alternatively, use the [install/update script](update-synology.sh):

```bash
curl -O https://raw.githubusercontent.com/t0nyz0/BambuBoard/main/update-synology.sh
chmod +x update-synology.sh
./update-synology.sh
```

The script elevates with `sudo`, pulls `latest` and replaces the `bambuboard` container. Its bind mount is `$HOME/bambuboard-data` **after elevation**, usually `/root/bambuboard-data`; it prints the actual path. Compose resolves `~` from the account running Compose. For an existing installation, retain its current data mount when choosing either method so your settings and scenes carry over. Open **http://<your-nas-ip>:8080**.

## Supported printers

Detection matches MQTT product names, then falls back to hardware/project identifiers. The [capability map](src/lib/caps.js), based on [ha-bambulab](https://github.com/greghesp/ha-bambulab), controls widget availability and camera transport.

The maintainer owns and tests **X1 Carbon and H2D**. Other entries are code mappings that need community hardware feedback; a recognized model does not establish that every widget works on its firmware. The current G-code changes have a read-only physical H2D download and local rendering check; affected H2C firmware and actual OBS still need confirmation. See the [QA record](docs/qa-studio-refresh.md) and [G-code verification](docs/gcode-resilience.md#verification) for the scope of testing.

| Printer | BambuBoard type | Current coverage |
|---|---|---|
| X1 Carbon | `X1C` | Maintainer-tested hardware |
| H2D | `H2D` | Maintainer-tested hardware |
| H3C | `H3C` | Dedicated profile tested with fixtures. Hardware verification pending. |
| X1 | `X1` | Dedicated capability entry; community feedback welcome |
| P1P / P1S | `P1P` / `P1S` | Dedicated capability entries; community feedback welcome |
| P2S | `P2S` | Dedicated capability entry; community feedback welcome |
| A1 / A1 Mini | `A1` / `A1M` | Dedicated capability entries; community feedback welcome |
| X1E | `X1C` | Shared fallback; no dedicated X1E capability entry |
| H2D Pro / H2C / H2S / X2D | `H2D` | Shared fallback; no dedicated capability entries |

Fallback mappings reuse another model's widget gates and build dimensions. They can differ from the actual hardware, so check the selected widgets and layout rather than assuming all H2D features apply.

**AMS selection:** the widget automatically selects the integrated AMS 3H or the only reported AMS. On a classic multi-AMS setup it keeps the existing index **1** default used by the H2D starter. Use `?ams=N` to select a different array index in `print.ams.ams`, starting at 0. Telemetry indexes can differ from the labels on your units.

### H3C compatibility

The **H3C** has a dedicated model profile and a 330 × 320 × 325 mm Toolpath bed. Use normal LAN connection details in Setup. For the camera, enable **LAN Only Liveview** on the printer. BambuBoard uses the RTSP endpoint announced by the printer. [Bambu Lab's H3C specifications](https://blog.bambulab.com/tool-changer-game-changer-bambu-lab-presents-h3c-the-defining-new-generation-of-3d-printers/#h3c-technical-specification) · [ha-bambulab camera notes](https://github.com/greghesp/ha-bambulab/blob/7c740224c72401890ac9744643aa1b0c73e732f4/README.md#camera)

The **AMS** widget displays the integrated AMS 3H’s nine trays and both zones' reported temperature and humidity. The drying countdown uses the heated zone. The **Gcode Toolpath** widget retrieves the active sliced file over FTPS when the printer makes it available. For jobs stored internally or otherwise unavailable over FTPS, use **Load sliced file** with the exact `.3mf` or `.gcode`.

H3C hardware verification is pending. The first live check should confirm detection after a restart, the chamber feed with OBS, automatic retrieval for LAN and cloud jobs, and tray, color, and drying-zone changes on an actual AMS 3H during a multi-material print.

## Widget catalog

Each widget is a standalone page at `/widgets/<slug>/`. Add it in the Layout editor to include it in `/live`, or use its URL as an individual OBS Browser Source. Availability is based on the detected type; capability-gated widgets are disabled in the editor for incompatible types.

<!-- WIDGET-CATALOG-START -->
| Widget | Description | Recommended size | Params | Cap-gated |
|--------|-------------|------------------|--------|-----------|
| **AMS** (`ams`) | Filament trays, active slot, temperature, humidity and drying status. Selects the integrated AMS 3H or the only reported unit automatically, and uses index 1 for classic multi-AMS layouts. Use ?ams=N to choose a telemetry array entry. | 400×460 | `?ams` | — |
| **AMS humidity / temp (legacy)** (`ams-temp`) | Legacy standalone AMS humidity, temperature and reported drying status. These readouts are also included in `ams`. | 400×120 | — | — |
| **AMS #2 humidity (legacy)** (`ams-temp-2`) | Legacy companion AMS humidity, temperature and reported drying status. These readouts are also included in `ams2`. | 400×120 | — | `hasDualAMS` |
| **AMS #2** (`ams2`) | Legacy companion AMS card for H2D-class layouts. Shows temperature, humidity, reported drying status and four trays from telemetry array entry 0. Use the configurable `ams` widget to select other entries. | 400×460 | — | `hasDualAMS` |
| **Bed temperature** (`bed-temp`) | Heat-bed temp with target + progress bar. | 400×120 | — | — |
| **Live camera** (`camera`) | Printer camera relayed into the browser. Selects RTSP or the chamber-image transport from the detected printer type. Requires reachable LAN camera access; RTSP liveview must be enabled on the printer. | 640×360 | — | — |
| **Chamber temperature** (`chamber-temp`) | Reported chamber temperature, shown for printer types with the chamber-temperature capability. | 400×120 | — | `hasChamberTemp` |
| **Fans** (`fans`) | Auxiliary, chamber, cooling and heatbreak fan gauges from reported telemetry. Available readings depend on the printer. | 420×160 | — | — |
| **Gcode Toolpath** (`gcode-viz`) | Experimental 3D toolpath from the current print's sliced G-code, downloaded over FTPS or loaded manually. Uses reported layers/progress and estimated timing, with bounded retries and downloadable diagnostics. Requires WebGL 2; simulated nozzle motion can drift. | 640×640 | — | — |
| **Model image** (`model-image`) | Preview image of the current model (requires Bambu Cloud auth for live MakerWorld images). | 400×300 | — | — |
| **Notes / footer** (`notes`) | Auto-updates with the model name each print; supports a manual text override (via the /api/note endpoint). | 600×40 | — | — |
| **Nozzle info** (`nozzle-info`) | Nozzle type, size, current speed level. | 400×120 | — | — |
| **Nozzle temperature** (`nozzle-temp`) | Nozzle temperature with current/target and progress bar. Use ?nozzle=0 (right, default) or ?nozzle=1 (left) for dual-nozzle printers. | 400×120 | `?nozzle=0` | — |
| **Left nozzle temperature** (`nozzle-temp-2`) | Left nozzle temperature (H2D/dual-nozzle). Legacy widget — equivalent to nozzle-temp/?nozzle=1. | 400×120 | — | `hasDualNozzle` |
| **Print info** (`print-info`) | Remaining time, estimated finish time, model name and layer count from telemetry. Filament weight is populated from Bambu Cloud when available. | 400×160 | — | — |
| **Printer info** (`printer-info`) | Nozzle type/size and print speed from telemetry, plus printer name, model, bed type and recent print count when Bambu Cloud data is available. | 400×140 | — | — |
| **MakerWorld profile** (`profile-info`) | Followers, downloads, and stats from your MakerWorld profile (requires Bambu Cloud auth). | 400×180 | — | — |
| **Progress** (`progress-info`) | Print progress bar with status text and percentage. | 600×80 | — | — |
| **Version stamp** (`version`) | Shows BambuBoard version in a corner. | 200×30 | — | — |
| **Wi-Fi signal** (`wifi`) | Wireless signal strength. | 200×80 | — | — |

_20 widgets — generated by `scripts/build-widget-catalog.js`._
<!-- WIDGET-CATALOG-END -->

### URL parameters

The shared customizer accepts these parameters. Appearance depends on the widget: title overrides require a title element, and full-frame camera/G-code widgets manage their own backgrounds.

| Parameter | Meaning |
|---|---|
| `theme=dark`, `light` or `transparent` | Widget color scheme |
| `accent=51a34f` | Hex accent color **without `#`** |
| `fontSize=14` | Base font size in pixels |
| `title=My%20title` | Override an existing widget title |
| `pad=8` | Body padding in pixels, clamped to 0–64 |

Combine parameters with `&`, for example `/widgets/ams/?ams=0&theme=dark&accent=51a34f`. Widget-specific parameters are listed in the catalog. Saved widget themes are independent of the management app's theme.

For a standalone G-code browser source, add `view=angled`, `top`, `front`, or `side`, plus an optional `zoom` value from 50 to 200. For example, `/widgets/gcode-viz/?view=top&zoom=125`.

## Bambu Cloud (optional)

Cloud sign-in is off by default. In **Setup**, the Bambu Cloud card appears alongside printer settings on desktop; the **Cloud settings** shortcut jumps to it on smaller screens. `/login` redirects to this card.

In **Setup → Bambu Cloud**, enter your Bambu account email, then enter the latest six-digit code Bambu sends you. Use **Resend code** if it hasn't arrived or **Change email** if the address is wrong. If Bambu requests another step, enter the code from your authenticator app.

If email sign-in is blocked, open **Troubleshooting → Import a MakerWorld token** for browser-specific instructions. BambuBoard verifies the new token before saving it. A rejected token or temporary service failure keeps your existing sign-in intact.

Successful sign-in enables cloud features and stores the token locally in `data/accessToken.json` (gitignored). **Check connection** verifies a saved sign-in; **Sign out** clears it and disables cloud features.

MakerWorld profile/model images, filament weight and some printer/history fields require cloud data. Telemetry widgets, the camera and FTPS toolpaths use your LAN credentials. Leave cloud sign-in disabled for LAN operation.

## Network access

Allow the BambuBoard host to reach the printer on the ports used by your features:

| Feature | Printer connection |
|---|---|
| Telemetry | TLS MQTT, **8883** by default; configurable in Setup |
| RTSP camera | RTSPS, normally **322** for X1/X1C/H2D/P2S/H3C. H3C follows the port reported by the printer. |
| Chamber-image camera | TLS image stream, **6000** for P1/A1-class types |
| G-code download | Implicit TLS FTPS, **990**, plus the printer's negotiated passive data ports |

The viewer/OBS connects to BambuBoard on **8080** by default. MQTT success alone does not verify camera or file access. The Docker Quickstart examples publish port 8080 through Docker's bridge network. The Synology terminal installs above use host networking. Cloud widgets need internet access; YouTube streaming uses outbound encrypted RTMPS on **443**. App assets have no CDN dependency, though custom remote sources and cloud content can still make external requests.

The dashboard and Setup are usable without a BambuBoard account. Keep BambuBoard on a trusted network or behind an authenticated reverse proxy. Saved printer credentials and Bambu Cloud tokens stay on the server. Leave the access code blank to keep the saved code for the same printer connection, or enter a fresh code to change that connection. If the proxy rewrites the request Host header, set `BAMBUBOARD_PUBLIC_URL` to the public browser address.

## Troubleshooting

- **Connection test fails or widgets have no data:** check the IP, MQTT port, serial number and LAN access code in Setup. Confirm network reachability from the BambuBoard host and look at **Printer status**. Enable **Verbose logging** under **Diagnostics**, save it, then inspect `docker logs bambuboard` or the source server's terminal.
- **Wrong printer type:** check the detected model on Setup and [current mappings](src/lib/caps.js). `BAMBUBOARD_PRINTER_TYPE` supplies the startup type; MQTT auto-detection can replace it. Report a mismatched model with its MQTT module information rather than relying on the environment variable to force a permanent override.
- **Camera is black or unavailable:** check camera status separately from MQTT. On RTSP models, enable the printer's LAN liveview option where available and follow the widget's hint; menu names and firmware requirements vary. Verify port 322 and the server's FFmpeg relay. P1/A1-class types use port 6000 and the LAN access code instead.
- **OBS shows nothing:** copy the Browser Source URL from Live and open it in a browser on the OBS machine to check that it can reach BambuBoard. Match the source dimensions to the canvas. The built-in layout works before you publish a custom layout.
- **AMS unit unavailable:** check `print.ams.ams` in `/data.json` and choose a reported array index. Clear an explicit `ams` parameter to use automatic selection.
- **G-code cannot load:** choose **Open toolpath preview** on Live. Check printer file access under **Setup → Diagnostics → Test G-code connection**. The standalone preview offers **Retry now**, **Download diagnostics**, and **Load sliced file** when applicable. Use the exact sliced `.3mf` or `.gcode` for the current print. [G-code troubleshooting and limits](docs/gcode-resilience.md)

## Migrating from older versions

**v3 is single-printer.** If you need the older multi-printer app, the [`v2.0.1` source tag](https://github.com/t0nyz0/BambuBoard/tree/v2.0.1) remains available.

On first boot, legacy flat H2D settings are converted to the `printer` object. For a legacy `printers[]` array, migration keeps the **first entry with a non-placeholder serial number** (or the first entry if none qualifies), warns in the server log and removes other printers from the active configuration. A backup of the original is stored in `data/config.json.pre-merge-<reason>-<timestamp>.bak` before conversion.

With the default data directory, legacy root-level `config.json`, `accessToken.json`, `note.json` and `public/data.json` are moved into `data` when their destinations do not already exist. An explicit `BAMBUBOARD_DATA_DIR` disables that root-file migration. Back up the whole persistent data directory before upgrading.

## Development

The server is plain Node/Express in [`src`](src), the management pages are in [`views`](views), and each standalone widget is in [`public/widgets`](public/widgets). Keep the server [capability map](src/lib/caps.js) and its [browser mirror](public/js/caps.js) in sync. Commit `package-lock.json` with dependency changes and use `npm ci` for repeatable installs.

`BAMBUBOARD_DATA_DIR=/absolute/path` isolates runtime state; the default is the repository's `data` directory. It holds configuration, telemetry, cloud tokens, notes, drafts (`scenes/`), the published snapshot (`active-scene.json`), toolpaths (`gcode-cache/`) and the latest redacted download/stream reports (`gcode-diagnostics.json`, `stream-diagnostics.json`). None belongs in Git. Existing active scene pointers are snapshotted at startup without rewriting the draft.

Set `BAMBUBOARD_PUBLIC_URL=https://board.example.com` to choose the origin used by OBS exports. Otherwise exports honor forwarded host/protocol headers. Docker removes npm/npx/Yarn after installation; rebuild the image for dependency changes rather than installing packages in a running container.

| Command | Purpose |
|---|---|
| `npm start` | Start the server; `PORT` / `BAMBUBOARD_HTTP_PORT` can change port 8080. |
| `npm run check` | Check server, app, widget and test JavaScript syntax. |
| `npm test` | Run server/integration tests with local MQTT, FTPS, camera, cloud and RTMP fixtures. |
| `npm test -- --update-badge` | Update the README server-test count after a successful run. |
| `npm run test:browser` | Check responsive pages, keyboard controls and all widgets. |
| `npm run test:gcode-browser` | Check HTTP → FTPS → archive → WebGL, recovery, stale jobs and renderer failures. |
| `npm run test:stream-browser` | Check capture → relay → local RTMP, retries, cancellation, server controls, audio fallback and streaming accessibility. |
| `npm run test:ui` | Check editor/publication regressions, widget transparency and management-page accessibility. |
| `npm run test:cloud` | Check email/code/MFA and token sign-in through the real local API and saved state, with simulated Bambu responses; covers resend, retries, account replacement and sign-out. |
| `node scripts/capture-readme.js` | Capture Live, Layout, Setup and mobile screenshots with isolated demo data. [Fixture options](docs/qa-studio-refresh.md#screenshots-and-safe-fixtures). |
| `npm run build:vendor` | Regenerate bundled local assets from locked packages. |
| `npm run build:widget-catalog` | Print the catalog from `widget.json` files; replace the README content between the catalog markers with that output. |
| `node scripts/ftp-test.js` | Read-only current-print FTPS check with redacted JSON output. Also available as `docker exec bambuboard node scripts/ftp-test.js`. |

Install Chromium for browser checks with `npx playwright install chromium`. To run management UI checks across all three engines:

```bash
npx playwright install --with-deps chromium firefox webkit
BB_BROWSERS=chromium,firefox,webkit npm run test:ui
BB_BROWSERS=chromium,firefox,webkit npm run test:cloud
```

The **server tests** badge counts `npm test` cases and is checked against the actual runner total. The **build** badge tracks the main Docker workflow, which requires server tests, browser/UI checks and both container architectures before publishing. [Release QA](docs/qa-3.3.1.md), [Studio QA](docs/qa-studio-refresh.md), [G-code QA](docs/gcode-resilience.md#verification) and [YouTube QA](docs/youtube-streaming.md#verification) describe fixture coverage and hardware limitations.

## Contributing

[Issues](https://github.com/t0nyz0/BambuBoard/issues) and pull requests are welcome, especially hardware feedback for additional printer models. Include the model, firmware, app version, a screenshot and the relevant telemetry fields. For toolpath failures, attach **Download diagnostics** output; it redacts connection secrets. Review anything you share for private filenames, account data or credentials.

## Acknowledgements and license

Thanks to [ha-bambulab](https://github.com/greghesp/ha-bambulab) for protocol/detection work, [Bambu Lab](https://bambulab.com/) for the printers, and [OBS Studio](https://obsproject.com/) for browser sources. [G-code research credits](docs/gcode-resilience.md#protocol-and-storage-research) link the additional source projects used for file-transfer improvements.

[MIT](LICENSE) © [t0nyz0](https://github.com/t0nyz0)
