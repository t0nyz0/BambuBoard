# OBS scene templates

These are scrubbed, working scenes ready to drop into OBS Studio. They were exported from real layouts and stripped of personal data (custom IPs, Streamlabs tokens, local file paths).

## Pick the right one

- **`default-x1.json`** — for X1, X1C, P1, P1P, P1S, A1, A1 Mini. Standard widget set: bed, nozzle, AMS #1, fans, progress, print info.
- **`default-h2d.json`** — for H2D. Adds AMS #2, AMS #2 humidity, and right-nozzle temp tiles for the dual hardware.

## How to use

The easy way:

1. Open the BambuBoard hub at `http://<your-host>:8080/`.
2. Click **Download for OBS** under the matching template card. The downloaded JSON has your host pre-substituted.
3. In OBS, **Scene Collection → Import** and pick the file.

The manual way:

1. Open `default-x1.json` (or `-h2d.json`) and find-replace `<HOST>` with your dashboard host (e.g. `192.168.1.50:8080`).
2. Import the file in OBS.

## What was scrubbed

- Personal IP addresses → replaced with `<HOST>` placeholder.
- Streamlabs viewer-count source (it carried a personal access token) → removed. Re-add your own from OBS if you want a viewer-count overlay.
- The H2D template's local SDP/RTP camera source (referenced a path inside one user's Library folder) → removed. Add your own video source if you want the printer's camera feed.
- OBS hotkeys and recents.

The widget positions, scene names, and visual styling are left intact — that's the value of starting from a real working layout.
