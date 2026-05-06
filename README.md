# BambuBoard

> **OBS dashboard widgets for Bambu Lab printers.** Live print stats overlays designed for streamers — drop a scene file into OBS Studio and you have a polished, real-time print dashboard on stream.

<p align="center">
  <strong>Setup → Connect → Layout → Export.</strong> Four steps, signposted in the app.
</p>

---

## Why v3? (the short story)

BambuBoard started as a dashboard for OBS browser-source widgets. Over time v2 grew into a full multi-printer management app — useful, but a different product. **v3.0 returns BambuBoard to its core:** a polished single-printer dashboard built around streaming overlays, with a guided setup flow, a visual scene-layout editor, and one-click export to OBS.

- **Want streaming widgets, a clean overlay, and quick OBS import?** You're in the right place.
- **Want multi-printer fleet management?** Stay on **v2.x** — see the [v2 branch](https://github.com/t0nyz0/BambuBoard/tree/v2). v3 is intentionally single-printer.

Everything else from v2 (LAN-only operation, Bambu Cloud auth, all the per-widget customizations) carries over. The major addition in v3 is the **scene editor** — drag widgets around an OBS-canvas-sized preview, then save & export the scene JSON in one click.

---

## Quickstart — Docker (recommended)

A single command. Multi-arch image (works on x86, Apple Silicon, Raspberry Pi):

```bash
docker run -d --name bambuboard -p 8080:8080 \
  -v $(pwd)/data:/usr/src/app/data \
  -v $(pwd)/config.json:/usr/src/app/config.json \
  ghcr.io/t0nyz0/bambuboard:latest
```

Then open **http://localhost:8080**. The first-run setup wizard appears automatically.

For docker-compose users, see [`docker-compose.yml`](docker-compose.yml) — `docker compose up -d` and you're done.

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
2. **Connect** (still `/setup`, lower section) — BambuBoard asks the printer to identify itself via MQTT. Within a few seconds you'll see "Auto-detected: H2D" (or whichever model). The "Continue to Layout →" button lights up.
3. **Layout** (`/scene-editor`) — A 1920×1080 canvas auto-loads the matching default template for your printer type. Drag widgets, resize, change themes, snap to grid. When you're happy, click **Save & Continue to Export**.
4. **Export** (`/`) — Download the scene `.json` file. In OBS Studio: **Scene Collection → Import…** → pick the file. Done.

You'll need before starting:
- The printer's **IP address** (printer screen → Settings → Network).
- The **serial number** (Settings → Device Info, or back-panel sticker).
- The **LAN access code** (Bambu Studio → Device → Access Code).

---

## Supported printers

Printer type is **auto-detected from MQTT** when BambuBoard connects — no need to remember which model you picked. The detection mirrors [ha-bambulab](https://github.com/greghesp/ha-bambulab)'s logic (matches by MQTT `product_name`, falls back to hardware version).

| Model | BambuBoard type | Caps |
|-------|----------------|------|
| X1 | `X1` | Chamber temp |
| X1 Carbon | `X1C` | Chamber temp |
| X1E | `X1C` (mapped) | Chamber temp |
| P1P | `P1P` | — |
| P1S, P2S | `P1S` | — |
| A1 | `A1` | Single AMS |
| A1 Mini | `A1M` | Single AMS |
| H2D, H2D Pro, H2C, H2S, X2D | `H2D` | Chamber temp, dual nozzle, dual AMS |

All printers support up to 4 chained AMS units via the AMS Hub (`?ams=0|1|2|3` URL parameter on the AMS widgets).

---

## What's where

```
BambuBoard/
├── src/                  Server (Node, Express)
│   ├── server.js         Bootstrap
│   ├── mqtt.js           Single-printer MQTT client + printer auto-detect
│   ├── config.js         Load / save / migrate
│   ├── routes/           api, pages, auth, obsScene, video
│   └── lib/caps.js       PRINTER_CAPS map + printerTypeFromMqtt()
├── views/                Pretty-URL HTML pages
├── public/
│   ├── css/              theme, components, hub, dashboard, setup, scene-editor
│   ├── js/               nav (with stepper), hub, dashboard, setup, scene-editor
│   ├── assets/           jQuery, Material Symbols, fonts (local — no CDNs)
│   └── widgets/          OBS browser-source widgets (each its own folder)
├── OBS_settings/
│   └── templates/        Scrubbed default scenes for each printer family
├── data/                 Runtime state (gitignored): data.json, accessToken.json, note.json, scenes/
├── scripts/              build-widget-catalog.js, etc.
├── config.json           Local config (gitignored)
└── example.config.json
```

---

## Pages

- **`/setup`** — Step 1+2: Printer config, connection check, optional Bambu Cloud auth.
- **`/scene-editor`** — Step 3: Visual scene editor. Auto-loads the matching template for your printer type.
- **`/`** (Hub) — Step 4: Export. Saved scenes, default templates, and a collapsible widget gallery.
- **`/dashboard`** — Live print monitor. Capability-driven layout (P1P sees no chamber temp; H2D sees both AMS units and both nozzles). Not part of the setup flow — open whenever.
- **`/login`** — Bambu Cloud sign-in (only used when cloud auth is enabled).

---

## Widget catalog

Every widget is a standalone HTML page you add as a Browser Source in OBS. The hub gallery shows live previews; the scene editor lets you drag them onto a canvas.

<!-- WIDGET-CATALOG-START -->
| Widget | Description | Recommended size | Params | Cap-gated |
|--------|-------------|------------------|--------|-----------|
| **AMS** (`ams`) | Filament tray status. Multi-AMS support: append ?ams=0\|1\|2\|3 to target a specific AMS unit (defaults to AMS #1). | 800×200 | — | — |
| **AMS humidity / temp** (`ams-temp`) | Humidity + temperature for an AMS unit. Multi-AMS: ?ams=0\|1\|2\|3 (defaults to AMS #1). | 400×120 | — | — |
| **AMS #2 humidity** (`ams-temp-2`) | Humidity / temperature for the second AMS unit (H2D only). | 400×120 | — | `hasDualAMS` |
| **AMS #2** (`ams2`) | Filament tray status for the second AMS unit (H2D only). | 800×200 | — | `hasDualAMS` |
| **Bed temperature** (`bed-temp`) | Heat-bed temp with target + progress bar. | 400×120 | — | — |
| **Chamber temperature** (`chamber-temp`) | Enclosed-chamber temperature (X1, X1C, H2D). | 400×120 | — | `hasChamberTemp` |
| **Fans** (`fans`) | All four fan speeds with animated spinning icons and circular gauge rings showing speed percentage. | 420×160 | — | — |
| **Model image** (`model-image`) | Preview image of the current model (requires Bambu Cloud auth for live MakerWorld images). | 400×300 | — | — |
| **Notes / footer** (`notes`) | Auto-updates with the model name each print; can be manually overridden from the dashboard. | 600×40 | — | — |
| **Nozzle info** (`nozzle-info`) | Nozzle type, size, current speed level. | 400×120 | — | — |
| **Nozzle temperature** (`nozzle-temp`) | Nozzle temperature with current/target and progress bar. Use ?nozzle=0 (right, default) or ?nozzle=1 (left) for dual-nozzle printers. | 400×120 | `?nozzle=0` | — |
| **Left nozzle temperature** (`nozzle-temp-2`) | Left nozzle temperature (H2D/dual-nozzle). Legacy widget — equivalent to nozzle-temp/?nozzle=1. | 400×120 | — | `hasDualNozzle` |
| **Print info** (`print-info`) | Total prints, model name, weight, nozzle/bed. | 400×160 | — | — |
| **Printer info** (`printer-info`) | Printer name, model, serial, IP. | 400×140 | — | — |
| **MakerWorld profile** (`profile-info`) | Followers, downloads, and stats from your MakerWorld profile (requires Bambu Cloud auth). | 400×180 | — | — |
| **Progress** (`progress-info`) | Print progress bar with status text and percentage. | 600×80 | — | — |
| **Version stamp** (`version`) | Shows BambuBoard version in a corner. | 200×30 | — | — |
| **Wi-Fi signal** (`wifi`) | Wireless signal strength. | 200×80 | — | — |
<!-- WIDGET-CATALOG-END -->

Regenerate this table after adding/changing widgets:
```bash
npm run build:widget-catalog
```

Cap-gated widgets are greyed out in the hub gallery for incompatible printer types (e.g. `chamber-temp` is hidden on P1P which has no chamber).

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

## OBS scene templates

Two pre-built scenes are included, scrubbed of personal info:

- **`default-x1`** — X1, X1 Carbon, P1P, P1S, A1, A1 Mini (single nozzle, single AMS layout).
- **`default-h2d`** — H2D / H2D Pro (dual nozzle + dual AMS layout).

The scene editor auto-loads the right one based on the connected printer's type. You can also download the raw JSON from the Export page and import it directly into OBS.

---

## Bambu Cloud auth (optional)

Off by default. Enable in `/setup` to populate the `profile-info` and `model-image` widgets with live MakerWorld data. Sign-in flow uses email + verification code (and MFA if enabled on your Bambu account). Tokens are cached in `data/accessToken.json` (gitignored). LAN-only operation does not require this.

---

## Running offline / on a LAN

All assets (jQuery, Material Symbols, fonts) are bundled locally — no external CDN dependencies. The dashboard server only needs LAN access to your printer's MQTT port (8883 by default).

---

## Migrating from older versions

The first boot of v3 detects and migrates two legacy config shapes:

- **Old single-printer H2D fork** (flat `BambuBoard_printerURL` etc.) → new `printer` object with `type: "H2D"`.
- **Old multi-printer BambuBoard v2** (`printers[]` array) → first printer is kept; the rest are dropped with a warning. **Multi-printer is not supported in v3** — for that, stay on v2.x.

Both produce a `config.json.pre-merge-*-{timestamp}.bak` backup before overwriting. Legacy runtime files (`accessToken.json`, `note.json`, `public/data.json`) at the repo root are auto-moved into `data/` on first boot.

---

## Troubleshooting

- **"Test connection" fails** — verify the IP, port (8883), serial number, and access code. The printer must be on the same LAN.
- **No data appearing on dashboard** — check the printer's "LAN Mode Liveview" setting is enabled (Settings → General). Also check the "Connect" panel on `/setup` — it should show "MQTT: ✓ Connected" within 3-5s.
- **Wrong printer type detected** — BambuBoard auto-detects from MQTT and overwrites `config.printer.type` accordingly. If detection picks the wrong model (rare — usually means custom firmware), set `BAMBUBOARD_PRINTER_TYPE=X1` (or whatever) as an env var; that always wins.
- **Camera widget shows "RTSP disabled"** — On the H2D, enable: Settings → Network → LAN Only Liveview → ON, then reboot the printer. May require firmware 01.06+.
- **OBS scene fails to import** — make sure you used the Export page's Download button (which substitutes `<HOST>` for you), not the raw template.

---

## Development

```bash
npm install
node src/server.js                # bare-bones; uses ./config.json + ./data/
BAMBUBOARD_LOGGING=true node src/server.js > /tmp/bb.log 2>&1 &
tail -f /tmp/bb.log               # verbose MQTT trace
```

For agent / contribution conventions, see [`AGENTS.md`](AGENTS.md).

---

## License

MIT — see [LICENSE](LICENSE).
