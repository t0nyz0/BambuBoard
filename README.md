<div align="center">

# BambuBoard

**Live print overlays for Bambu Lab printers, built for streamers.**
Design a dashboard once, hit **Go Live**, and add a *single* Browser Source to OBS — camera and all widgets composited into one page. No scene import, no SDP file, no Bambu Studio.

<br>

[![Version](https://img.shields.io/github/package-json/v/t0nyz0/BambuBoard?style=flat-square&color=51a34f&label=version)](https://github.com/t0nyz0/BambuBoard/releases)
[![License](https://img.shields.io/github/license/t0nyz0/BambuBoard?style=flat-square&color=51a34f)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ed?style=flat-square&logo=docker&logoColor=white)](https://github.com/t0nyz0/BambuBoard/pkgs/container/bambuboard)
[![Build](https://img.shields.io/github/actions/workflow/status/t0nyz0/BambuBoard/docker-publish.yml?branch=main&style=flat-square&label=build)](https://github.com/t0nyz0/BambuBoard/actions/workflows/docker-publish.yml)
[![Stars](https://img.shields.io/github/stars/t0nyz0/BambuBoard?style=flat-square&color=51a34f)](https://github.com/t0nyz0/BambuBoard/stargazers)

**Setup → Connect → Layout → Go Live.** Four steps, signposted in the app (Connect lives on the Setup page).

[Quickstart](#quickstart--docker-recommended) · [Screenshots](#screenshots) · [Supported printers](#supported-printers) · [Widget catalog](#widget-catalog) · [Troubleshooting](#troubleshooting)

</div>

---

## Why v3? (the short story)

BambuBoard started as a dashboard for OBS browser-source widgets. Over time v2 grew into a full multi-printer management app — useful, but a different product. **v3 returns BambuBoard to its core:** a polished single-printer streaming dashboard, with a guided setup flow, a visual scene-layout editor, a built-in camera feed, and a one-Browser-Source path into OBS.

- **Want streaming widgets, a clean overlay, and a dead-simple OBS setup?** You're in the right place.
- **Want multi-printer fleet management?** Stay on **v2.x** — checkout the [`v2.0.1` tag](https://github.com/t0nyz0/BambuBoard/tree/v2.0.1) (`git checkout v2.0.1`) or pull the matching Docker image: `ghcr.io/t0nyz0/bambuboard:2.0.1`. v3 is intentionally single-printer.

Everything else from v2 (LAN-only operation, Bambu Cloud auth, all the per-widget customizations) carries over. The big additions in v3: the **scene editor** (drag widgets around a canvas-sized preview), the composited **`/live` page** (your whole scene rendered as one page), and a **built-in camera feed** — so OBS needs just one Browser Source, and the printer camera works without Bambu Studio.

---

## Screenshots

> **Live H2D dashboard** — chamber camera, gcode toolpath, dual nozzles, dual AMS, MakerWorld profile, and progress bar, all composited into a single `/live` page that OBS captures with one Browser Source.

<a href="screenshots/LIVE-DASHBOARD-3.0.jpg"><img src="screenshots/LIVE-DASHBOARD-3.0.jpg" alt="BambuBoard 3.0 live H2D dashboard" width="100%"></a>

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>Setup</h4>
      <p>Printer credentials, connection test, and optional Bambu Cloud sign-in.</p>
      <a href="screenshots/SETUP-TAB.jpg"><img src="screenshots/SETUP-TAB.jpg" alt="Setup page" width="100%"></a>
    </td>
    <td width="50%" valign="top">
      <h4>Layout editor</h4>
      <p>Drag widgets onto a canvas-sized preview with live telemetry — snap to grid, undo/redo, layers — then hit 🔴 Go Live to publish.</p>
      <a href="screenshots/LAYOUT-TAB.jpg"><img src="screenshots/LAYOUT-TAB.jpg" alt="Layout editor" width="100%"></a>
    </td>
  </tr>
</table>

<!--
  Screenshot status (3.1.0): all three shots are current — captured against the
  3.1.0 UI (Live·Layout·Setup nav, Setup→Connect→Layout→Go Live stepper, and the
  editor's Save / Preview / 🔴 Go Live toolbar). The hero is a live /live composite.
  TODO (nice-to-have): add a shot of the Live page (/) itself.
-->

---

## Highlights

- **One Browser Source → OBS** — design your overlay, hit 🔴 **Go Live**, and point a single OBS Browser Source at `/live`. BambuBoard composites the camera + every widget into one page — no scene import, no per-widget sources, no SDP. Edit and re-publish anytime; OBS updates itself.
- **Built-in camera feed (every model)** — BambuBoard streams the printer's chamber camera itself, so it shows up in `/live` with **no Bambu Studio "Go Live" and no OBS media/SDP setup**. X1 / X1C / H2D / P2S use RTSP (flip *LAN Mode Liveview* on the printer once); P1 / A1-class use the port-6000 chamber-image protocol. The widget picks the right transport automatically.
- **Stream to YouTube without OBS** *(beta)* — go live straight from the browser. Connect your Google account and BambuBoard sets the broadcast **title, description, privacy and "made for kids"** flag like OBS's Manage Broadcast (or just paste a stream key). It captures the `/live` tab and relays it (browser-encoded → server ffmpeg → RTMP). OBS is still the better choice on weak hardware (encoding happens in your browser), but you don't *need* it. [Setup ↓](#stream-to-youtube-optional-beta)
- **Visual scene editor** — drag widgets onto a 1920×1080 preview canvas. Snap to grid. Multi-select. Undo/redo. Live previews driven by your real telemetry. OBS-style Layers panel for drag-to-reorder z-stacking.
- **Live gcode toolpath widget** *(experimental / beta)* — three.js widget that fetches the active print's gcode over FTPS, parses it, and renders the toolpath in real time with a stylized hotend tracing the active layer. Multi-color prints get per-tool AMS colors. Adaptive speed calibration keeps the simulation locked to the printer's reported `mc_percent` even through filament swaps. Single-color prints work great; multi-color/multi-object timing on complex prints can still drift — open an issue if you hit a case that's clearly off.
- **MQTT auto-detection** — printer model auto-detected on connect; no need to remember whether you have an X1C or P1S. Mirrors the [ha-bambulab](https://github.com/greghesp/ha-bambulab) detection logic.
- **AMS drying indicator** — `AMS 2 Pro` and `AMS HT` units get a live "DRYING · 60° · 11h" pill with an animated fan icon when actively heating filament.
- **Active tray + active nozzle highlights** — the currently-feeding filament tray and the currently-extruding nozzle get a green left-edge accent + soft tint while printing.
- **Bambu Cloud (optional)** — sign in via paste-token (Cloudflare-resilient) or email + verification code to populate MakerWorld profile + model image widgets.
- **LAN-only operation** — fully functional without any cloud dependency; all assets bundled locally (no CDN calls).
- **One-line Docker install** — multi-arch image (`amd64` / `arm64`) auto-published to GHCR. Works on x86, Apple Silicon, Raspberry Pi, Synology NAS.

---

## Quickstart — Docker (recommended)

A single command. Multi-arch image (works on x86, Apple Silicon, Raspberry Pi):

```bash
docker run -d --name bambuboard -p 8080:8080 \
  -v $(pwd)/data:/usr/src/app/data \
  ghcr.io/t0nyz0/bambuboard:latest
```

Then open **http://localhost:8080**. The first-run setup wizard appears automatically.

For docker-compose users, see [`docker-compose.yml`](docker-compose.yml) — `docker compose up -d` and you're done.

### Synology NAS

One-command install and update for Synology NAS (or any Docker host that needs host networking):

```bash
# First time — download the update script
curl -O https://raw.githubusercontent.com/t0nyz0/BambuBoard/main/update-synology.sh
chmod +x update-synology.sh

# Run it (auto-elevates to sudo)
./update-synology.sh
```

Uses host networking so MQTT/RTSP can reach the printer without NAT config. Settings persist in a Docker volume across updates — run the same script to update and your config carries over automatically.

A [`docker-compose.synology.yml`](docker-compose.synology.yml) is also available if you prefer compose.

## Quickstart — from source

```bash
git clone https://github.com/t0nyz0/BambuBoard.git
cd BambuBoard
npm install
npm start
```

Open `http://localhost:8080`.

---

## The 4-step flow

When you open BambuBoard for the first time, you'll be guided through:

1. **Setup** (`/setup`) — Enter your printer's IP, serial number, and LAN access code. Test the connection from this page before saving.
2. **Connect** (`/setup#connect`, same page as Setup) — BambuBoard asks the printer to identify itself via MQTT. Within a few seconds you'll see "Auto-detected: H2D" (or whichever model). The "Continue to Layout →" button lights up.
3. **Layout** (`/scene-editor`) — A 1920×1080 canvas auto-loads the matching default template for your printer type. Drag widgets, resize, change themes, snap to grid. When you're happy, click **🔴 Go Live** to publish it.
4. **Go Live** (`/`) — Add **one Browser Source** in OBS pointing at `http://<your-host>:8080/live` (or use the one-click "Download OBS scene" — it's just that single source). No camera media source, no SDP. Re-publish from the editor any time and OBS updates on its own.

> **Match your OBS canvas to the scene.** Set the Browser Source size (and OBS → **Settings → Video → Base (Canvas) Resolution**) to your scene's resolution — 1920×1080 by default. `/live` scales to fit, so a mismatch just letterboxes rather than breaking.

You'll need before starting:
- The printer's **IP address** (printer screen → Settings → Network).
- The **serial number** (Settings → Device Info, or back-panel sticker).
- The **LAN access code** (Bambu Studio → Device → Access Code).

---

## Supported printers

Printer type is **auto-detected from MQTT** when BambuBoard connects — no need to remember which model you picked. The detection mirrors [ha-bambulab](https://github.com/greghesp/ha-bambulab)'s logic (matches by MQTT `product_name`, falls back to hardware version).

> **Honesty about testing:** I personally own and actively test BambuBoard against the **X1 Carbon** and **H2D**. Every other model below is a "should work" — the detection logic, capability map, and widget set were ported from ha-bambulab (which is broadly tested), but I can't physically verify the others. If something looks off on your specific printer, please open an [issue](https://github.com/t0nyz0/BambuBoard/issues) with a screenshot + the relevant chunk of `localhost:8080/data.json` and I'll fix it.

| Model | BambuBoard type | Caps | Status |
|-------|-----------------|------|--------|
| X1 Carbon | `X1C` | Chamber temp | ✅ **Tested by maintainer** |
| H2D, H2D Pro | `H2D` | Chamber temp, dual nozzle, dual AMS | ✅ **Tested by maintainer** |
| X1 | `X1` | Chamber temp | ⚠️ Should work — community feedback welcome |
| X1E | `X1C` (mapped) | Chamber temp | ⚠️ Should work — community feedback welcome |
| P1P | `P1P` | — | ⚠️ Should work — community feedback welcome |
| P1S | `P1S` | — | ⚠️ Should work — community feedback welcome |
| P2S | `P2S` | Chamber temp | ⚠️ Should work — community feedback welcome |
| A1 | `A1` | Single AMS | ⚠️ Should work — community feedback welcome |
| A1 Mini | `A1M` | Single AMS | ⚠️ Should work — community feedback welcome |
| H2C, H2S, X2D | `H2D` (mapped) | Chamber temp, dual nozzle, dual AMS | ⚠️ Should work — community feedback welcome |

**AMS variants:** any printer with a heating-capable AMS (AMS 2 Pro, AMS HT) gets a live drying indicator on the AMS widget when a dry cycle is running — `dry_time`, `dry_temperature`, animated fan icon. Older AMS / AMS Lite always reports zero so the indicator stays hidden, no model gating needed.

**Multi-AMS:** all printers support up to 4 chained AMS units via the AMS Hub. Add a second AMS widget to your scene with `?ams=1` (or `?ams=2`, `?ams=3`) to target the others.

---

## What's where

```
BambuBoard/
├── src/                  Server (Node, Express)
│   ├── server.js         Bootstrap
│   ├── mqtt.js           Single-printer MQTT client + printer auto-detect
│   ├── config.js         Load / save / migrate
│   ├── routes/           api, pages, auth, obsScene, video (RTSP+MJPEG camera), stream (RTMP relay), youtube (OAuth + broadcasts)
│   └── lib/              caps.js (PRINTER_CAPS + printerTypeFromMqtt), chamberImage.js (P1/A1 camera), youtube.js (OAuth + Live API)
├── views/                Pretty-URL HTML pages
├── public/
│   ├── css/              theme, components, hub, setup, scene-editor
│   ├── js/               nav (with stepper), hub (Live page), live, setup, scene-editor
│   ├── assets/           jQuery, Material Symbols, fonts (local — no CDNs)
│   └── widgets/          browser-source widgets (each its own folder)
├── OBS_settings/
│   └── templates/        Default layout starters for each printer family
├── data/                 Runtime state (gitignored): data.json, accessToken.json, note.json, scenes/
├── scripts/              build-widget-catalog.js, etc.
├── config.json           Local config (gitignored)
└── example.config.json
```

---

## Pages

- **`/setup`** — Step 1+2: Printer config, connection check, optional Bambu Cloud auth.
- **`/scene-editor`** — Step 3: Visual scene editor. Auto-loads the matching template for your printer type. Save, Preview, or **🔴 Go Live** to publish.
- **`/`** (Live) — Step 4: the published output. Shows the `/live` URL + copy button, a one-click single-source OBS scene download, and a live preview.
- **`/live`** — the composited broadcast page itself (camera + every widget). Point one OBS Browser Source here. Renders the published scene, or a default layout if nothing's published yet.
- **`/login`** — Bambu Cloud sign-in (only used when cloud auth is enabled).

---

## Widget catalog

Every widget is a standalone HTML page. The scene editor lets you drag them onto your canvas, and `/live` composites the whole scene into one page for OBS — so you normally don't add widgets to OBS individually. (You still can: each widget works on its own as a Browser Source if you ever want just one.)

<!-- WIDGET-CATALOG-START -->
| Widget | Description | Recommended size | Params | Cap-gated |
|--------|-------------|------------------|--------|-----------|
| **AMS** (`ams`) | Combined AMS card: chamber temp + humidity bar + drying status (AMS 2 Pro / AMS HT) + 4 tray rows. Active tray gets a green left-edge accent. Defaults to AMS #1 (firmware id=1, which is the user-facing 'AMS #1' on H2D dual-AMS setups). Multi-AMS: ?ams=0\|1\|2\|3. | 400×460 | `?ams=1` | — |
| **AMS humidity / temp (legacy)** (`ams-temp`) | Standalone humidity + chamber-temp + drying readout. Superseded by the combined `ams` widget which now includes this header above the trays. Kept for back-compat with custom scenes that reference it. | 400×120 | — | — |
| **AMS #2 humidity (legacy)** (`ams-temp-2`) | Standalone humidity + chamber-temp + drying readout for the second AMS. Superseded by the combined `ams2` widget which now includes this header above the trays. Kept for back-compat with custom scenes. | 400×120 | — | `hasDualAMS` |
| **AMS #2** (`ams2`) | Combined AMS #2 card (H2D only): chamber temp + humidity + drying status + 4 tray rows. Same layout as the primary `ams` widget but reads `ams.ams[0]` (firmware id=0, which is the user-facing 'AMS #2' on H2D — Bambu's MQTT enumeration is reversed from the labeled hardware). | 400×460 | — | `hasDualAMS` |
| **Bed temperature** (`bed-temp`) | Heat-bed temp with target + progress bar. | 400×120 | — | — |
| **Live camera** (`camera`) | Live chamber-camera feed rendered directly in the browser — no OBS or Bambu Studio required. X1 / X1C / H2D / P2S stream over RTSP (needs LAN Mode Liveview enabled on the printer); P1 / A1-class stream via the port-6000 chamber-image protocol. The widget picks the right transport automatically. | 640×360 | — | — |
| **Chamber temperature** (`chamber-temp`) | Enclosed-chamber temperature (X1, X1C, H2D, P2S). Hides itself on printers with no chamber. | 400×120 | — | `hasChamberTemp` |
| **Fans** (`fans`) | All four fan speeds with animated spinning icons and circular gauge rings showing speed percentage. | 420×160 | — | — |
| **Gcode Toolpath** (`gcode-viz`) | **Experimental / beta.** Live three.js visualization of the active print's gcode, advancing layer-by-layer with a stylized hotend tracing the toolpath. Multi-color prints render per-tool AMS colors. Adaptive speed calibration keeps the sim locked to the printer's mc_percent through filament swaps. Single-color prints work great; multi-object timing on complex prints can still drift. | 640×640 | — | — |
| **Model image** (`model-image`) | Preview image of the current model (requires Bambu Cloud auth for live MakerWorld images). | 400×300 | — | — |
| **Notes / footer** (`notes`) | Auto-updates with the model name each print; supports a manual text override (via the /api/note endpoint). | 600×40 | — | — |
| **Nozzle info** (`nozzle-info`) | Nozzle type, size, current speed level. | 400×120 | — | — |
| **Nozzle temperature** (`nozzle-temp`) | Nozzle temperature with current/target and progress bar. Use ?nozzle=0 (right, default) or ?nozzle=1 (left) for dual-nozzle printers. | 400×120 | `?nozzle=0` | — |
| **Left nozzle temperature** (`nozzle-temp-2`) | Left nozzle temperature (H2D/dual-nozzle). Legacy widget — equivalent to nozzle-temp/?nozzle=1. | 400×120 | — | `hasDualNozzle` |
| **Print info** (`print-info`) | Total prints, model name, weight, nozzle/bed. | 400×160 | — | — |
| **Printer info** (`printer-info`) | Printer name, model, serial, IP. | 400×140 | — | — |
| **MakerWorld profile** (`profile-info`) | Followers, downloads, and stats from your MakerWorld profile (requires Bambu Cloud auth). | 400×180 | — | — |
| **Progress** (`progress-info`) | Print progress bar with status text and percentage. | 600×80 | — | — |
| **Version stamp** (`version`) | Shows BambuBoard version in a corner. | 200×30 | — | — |
| **Wi-Fi signal** (`wifi`) | Wireless signal strength. | 200×80 | — | — |

_20 widgets — generated by `scripts/build-widget-catalog.js`._
<!-- WIDGET-CATALOG-END -->

Regenerate this table after adding/changing widgets:
```bash
npm run build:widget-catalog
```

Cap-gated widgets are dimmed (and can't be dragged) in the scene editor's widget drawer for incompatible printer types, and several self-hide at runtime too — e.g. `chamber-temp` won't render on a P1P, which has no chamber.

---

## URL parameters

Every widget supports query-string customization via `_customizer.js`:

- `?theme=dark|light|transparent` — color scheme
- `?accent=#51a34f` — accent color (hex)
- `?fontSize=14` — base font size in px
- `?title=My title` — override the widget's title text
- `?pad=8` — extra body padding in px

Plus widget-specific params (see catalog above) — e.g. `?ams=2` to point an AMS widget at the third unit.

---

## Scene templates (layout starters)

Two pre-built layouts are included, scrubbed of personal info:

- **`default-x1`** — X1, X1 Carbon, P1P, P1S, A1, A1 Mini (single nozzle, single AMS layout).
- **`default-h2d`** — H2D / H2D Pro (dual nozzle + dual AMS layout).

The scene editor auto-loads the right one as a **starting point** based on the connected printer's type — you customize from there and publish with 🔴 Go Live. (`/live` also falls back to the matching template when nothing has been published yet.) These are layout starters, not OBS import files — OBS only ever needs the single `/live` Browser Source.

Both templates use the **combined AMS widget** (chamber temp + humidity + drying status + tray contents in one card) and a uniform 3px-gap right rail: Chamber Temp → Bed Temp → Nozzle(s) → AMS → Fans, all top-to-bottom flush. Active nozzle and active filament tray are highlighted with a green left-edge accent + soft tint while printing.

---

## Bambu Cloud auth (optional)

Off by default. Enable in `/setup` to populate the `profile-info` and `model-image` widgets with live MakerWorld data. Sign-in flow uses email + verification code (and MFA if enabled on your Bambu account). Tokens are cached in `data/accessToken.json` (gitignored). LAN-only operation does not require this.

---

## Stream to YouTube (optional, beta)

Go live to YouTube straight from your browser — **no OBS**. BambuBoard captures the `/live` tab, encodes it, and relays it to YouTube over RTMP. There are two ways to do it:

**1. Connect account (recommended — like OBS's "Manage Broadcast").** Sign in with Google once and BambuBoard sets the broadcast **title, description, privacy** (public/unlisted/private), the **"made for kids"** flag, and **latency** for you — the completed stream is saved to your channel as a VOD automatically. One-time setup of a Google OAuth client is required:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project.
2. **APIs & Services → Library** → enable the **YouTube Data API v3**.
3. **OAuth consent screen** → *External*, and add your Google account as a **Test user** (no Google verification is needed while the app stays in "Testing").
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Under **Authorized redirect URIs**, add the exact URI shown in **BambuBoard → Setup → YouTube streaming** (e.g. `http://localhost:8080/api/youtube/oauth/callback`).
6. Paste the **Client ID** and **Client secret** into Setup → YouTube streaming and save. (Or set `BAMBUBOARD_YT_CLIENT_ID` / `BAMBUBOARD_YT_CLIENT_SECRET` env vars.)
7. On the **Live** page, click **Connect YouTube account**, then fill in the title/privacy and hit **🔴 Go Live**.

> **Do the one-time "Connect" step from the machine running BambuBoard** (open it at `http://localhost:8080`). Google only allows the OAuth redirect on `localhost`/`127.0.0.1` for non-HTTPS apps; once connected, the refresh token is stored server-side (`data/youtube-token.json`) and streaming works from any browser. Behind a real domain/HTTPS reverse proxy, set `BAMBUBOARD_YT_REDIRECT` to your public callback URL and register that instead.

**2. Stream key (no Google setup).** On the Live page, expand **Advanced: use a stream key**, paste a key from YouTube Studio → Go Live, and start. The title/description/privacy stay whatever you set in YouTube Studio — BambuBoard just pushes the video.

Either way, keep the shared `/live` tab open while streaming. Encoding happens in your browser, so this is best on a desktop — on weak hardware (e.g. a Pi) OBS with the single `/live` Browser Source is the better path.

---

## Running offline / on a LAN

All assets (jQuery, Material Symbols, fonts) are bundled locally — no external CDN dependencies. The BambuBoard server only needs LAN access to your printer's MQTT port (8883 by default) — plus, if you use the live camera, the camera port (322 for RTSP on X1/X1C/H2D/P2S, or 6000 for the chamber-image stream on P1/A1).

---

## Migrating from older versions

The first boot of v3 detects and migrates two legacy config shapes:

- **Old single-printer H2D fork** (flat `BambuBoard_printerURL` etc.) → new `printer` object with `type: "H2D"`.
- **Old multi-printer BambuBoard v2** (`printers[]` array) → first printer is kept; the rest are dropped with a warning.

> **WARNING — multi-printer users:** v3 is intentionally single-printer. Upgrading from v2 with more than one printer in your config will silently drop everything except the first entry on first boot. If you rely on multi-printer support, **stay on v2** — use the [v2.0.1 release](https://github.com/t0nyz0/BambuBoard/tree/v2.0.1) (`git checkout v2.0.1`) or pull `ghcr.io/t0nyz0/bambuboard:2.0.1`. A pre-merge backup is saved as `config.json.pre-merge-*-{timestamp}.bak` so the original config is recoverable.

Both produce a `config.json.pre-merge-*-{timestamp}.bak` backup before overwriting. Legacy runtime files (`accessToken.json`, `note.json`, `public/data.json`) at the repo root are auto-moved into `data/` on first boot.

---

## Troubleshooting

- **"Test connection" fails** — verify the IP, port (8883), serial number, and access code. The printer must be on the same LAN.
- **No data in the widgets** — check the "Connect" panel on `/setup`; it should show "MQTT: ✓ Connected" within 3–5s. If not, re-verify the IP, port (8883), serial, and access code. (Widget data comes over MQTT — this is separate from the camera, which has its own item below.)
- **Wrong printer type detected** — BambuBoard auto-detects from MQTT and overwrites `config.printer.type` accordingly. If detection picks the wrong model (rare — usually means custom firmware), set `BAMBUBOARD_PRINTER_TYPE=X1` (or whatever) as an env var; that always wins.
- **Camera is black / "Camera off"** — BambuBoard renders the camera itself (no OBS media source, no SDP, no Bambu Studio). On RTSP models (X1 / X1C / H2D / P2S), enable **LAN Mode Liveview** on the printer touchscreen: Settings → Network → LAN Only Liveview → ON, then reboot (firmware 01.06+). The camera widget shows these exact steps when the feed is unavailable. P1 / A1-class printers use the port-6000 chamber-image stream instead — no toggle needed, just a valid access code.
- **OBS shows nothing at `/live`** — make sure the BambuBoard server is running and the Browser Source URL points at `http://<your-host>:8080/live` (not `localhost` if OBS is on another machine). Publish a scene with **🔴 Go Live**, or `/live` falls back to the default layout.

---

## Development

```bash
npm install
npm start                         # uses ./data/config.json (or env overrides)
BAMBUBOARD_LOGGING=true npm start > /tmp/bb.log 2>&1 &
tail -f /tmp/bb.log               # verbose MQTT trace
```

Useful npm scripts:

| Script | What it does |
|---|---|
| `npm start` | Start the server on port 8080 (or `BAMBUBOARD_PORT`). |
| `npm run build:widget-catalog` | Regenerate the widget catalog table in this README from each widget's `widget.json`. Run after adding/changing widgets. |

---

## Contributing

Issues, bug reports, and pull requests are welcome — especially for printer models I don't own (P1P / P1S / A1 / A1 Mini / X1 / X1E). When filing a bug, a screenshot + the relevant chunk of `localhost:8080/data.json` makes triage 10× faster.

---

## Acknowledgements

- [**ha-bambulab**](https://github.com/greghesp/ha-bambulab) — the Home Assistant integration BambuBoard's printer-detection logic, stage-code map, AMS drying-state model, and packed-temperature decoding are all ported / verified against. Thank you to that project's maintainers — they did the hard reverse-engineering work.
- [**Bambu Lab**](https://bambulab.com/) — for making fantastic printers and an MQTT-friendly firmware.
- [**OBS Studio**](https://obsproject.com/) — for the browser-source plugin that makes any of this possible.

---

## License

[MIT](LICENSE) © [t0nyz0](https://github.com/t0nyz0)

<div align="center">

If you found BambuBoard useful, a star on the repo helps others discover it.

</div>
