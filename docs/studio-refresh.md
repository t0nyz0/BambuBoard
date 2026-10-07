# Studio refresh review

Based on `origin/main` at `2ab9d2735a65232440a4d0020a3d84b9ad412ef7` (3.1.5), verified October 7, 2026. The Studio refresh is version 3.2.0, approved for release by the maintainer on October 7. Work is isolated on `codex/studio-refresh`; the unrelated FTP experiment is excluded. See the QA record for completed checks and deployment status.

## Product changes

- Live preview is the first and largest panel. OBS URL and export follow it, with instructions behind a disclosure. YouTube is optional, collapsed and last; an active relay keeps its Stop button visible.
- The management pages use the approved Prism mark, local Manrope font, darker charcoal surfaces and mint controls. Broadcast widget themes and saved layout geometry remain separate.
- Layout editing has a docked Layers/library panel and inspector, a visible draft name, and clear unsaved/saved/published states. Widgets can be added by click, keyboard or drag, with capability and experimental labels. Undo restores sources as well as geometry; existing AMS/nozzle parameters, custom themes and bindings survive saves.
- Editor QA fixes preserve edits made while saving, retain pending changes across OBS scenes, respect locked layers, clear removed style overrides and keep anchor-aligned sources stable after reload. Invalid imports leave the current draft intact. Transparent widget backgrounds match the published output.
- Setup leads with printer credentials and connection status. Port, display preferences and optional Bambu Cloud sit in secondary sections. Switches support keyboard input; camera availability and printer connectivity have separate feedback. The onboarding strip appears during setup rather than on every visit.
- Saving a draft no longer changes `/live`. Publishing stores a complete snapshot in `data/active-scene.json`; deleting its draft leaves the published output available. Existing pointer records are snapshotted at startup and keep the slug older versions recognize. A downgrade to the pointer-based version restores its earlier draft-following behavior; retain a data backup for rollback.
- OBS export uses the published canvas resolution, including 2560×1440. Exported URLs honor HTTPS and reverse-proxy origins; built-in widget frames bind to the app’s current origin.
- Browser tab capture explains the HTTPS/localhost requirement on an HTTP NAS URL. Relay messages distinguish the running encoder from YouTube’s public broadcast status, and cancellation/connection failure stops capture and recording.
- The relay paces its silent audio in real time and ends it when video ends. Disconnect gives FFmpeg time to flush, then escalates shutdown if the encoder remains running. Native Ubuntu release checks cover this cleanup as well as the production-image checks.

## Dependency and runtime changes

`package-lock.json` now controls npm installs and Docker’s `npm ci --omit=dev`; the stale pnpm lock is removed. Supported runtime is Node 24 LTS. Docker uses `node:24-alpine3.24`, applies available Alpine patch updates and installs Alpine FFmpeg 8.1.2, rather than the older binaries downloaded by ffmpeg-static. Source installs retain the portable static fallback, whose embedded FFmpeg version differs by platform; set `FFMPEG_BIN` to a maintained native binary when needed. The production image removes npm, npx and Yarn after installation; run the server with its existing Node command, and rebuild the image to change packages.

Runtime packages are basic-ftp 6.2.2, cors 2.8.6, Express 4.22.3, ffmpeg-static 5.3.0, mqtt 5.16.0, rtsp-relay 1.9.0 and yauzl 3.4.0. Node’s native fetch replaces node-fetch. Express stays on the current 4.x release to preserve the existing routing and express-ws integration; Express 5.2.1 is a separate migration, not a missing security patch. `npm outdated` reports only that newer Express major among direct dependencies.

Local frontend assets use jQuery 4.0.0, Three.js 0.186.1, lil-gui 0.21.0 and gcode-preview 2.18.0. `scripts/build-vendor.js` regenerates the bundles from locked packages and records hashes in `public/vendor/manifest.json`. It preserves transparent toolpaths and adapts gcode-preview’s batch instancing to current Three.js. JSMpeg is pinned to upstream commit `924acfbd96fdf15e6748d1368a36d79d8f4cecf6` with its license and hash. The font is local and carries its OFL license. Unused Bootstrap files are removed. The old jQuery asset URL redirects to the updated file.

GitHub Actions are pinned to reviewed release SHAs. The validation workflow runs PR checks without publishing. Docker publishing depends on that same validation, including both image architectures, three browser engines, an audit and reproducible bundles. Playwright 1.63.0 and axe-core 4.13.0 are development dependencies. Dependabot covers npm, Docker and Actions.

## Verification

Automated checks use temporary data and loopback protocol fixtures. Screenshot preparation reads the existing NAS layout, selected telemetry fields and a short camera sample; it does not change its settings or connect a new server to the printer. No production credentials, OBS changes or public YouTube broadcasts are used.

- Clean `npm ci`, syntax checks and `npm audit --audit-level=low`: pass; zero reported npm vulnerabilities. This audit does not cover every embedded/native library or certify the container’s whole OS.
- Server integration suite: all 14 tests pass, covering configuration migration and backups, publication isolation and persistence across restart, concurrent publishing, native-fetch cloud responses, implicit-TLS FTPS download/3MF extraction, TLS MQTT telemetry/model detection/reconnect, fragmented chamber-camera JPEG frames/reconnect, and WebSocket → FFmpeg → loopback RTMP decoding.
- Both amd64 and arm64 containers build and pass the server integration suite with FFmpeg 8.1.2. MPEG-TS camera encoding and H.264/AAC FLV encoding/decoding pass on both architectures.
- Browser checks exercise Live, Layout and Setup at 1440, 1024, 736, 390 and 320 px. They cover draft save/publish isolation, reload, keyboard widget addition, Undo/Redo, URL parameter preservation, expanded mobile controls, HTTP capture detection and relay cleanup. All 20 widgets run locally. JSMpeg decodes sample MPEG-TS; toolpaths render lines and tubes with transparency using sample gcode. The run reported zero browser JavaScript errors and zero external asset requests.
- Expanded UI regressions pass in Chromium, Firefox and WebKit: 12 groups per engine, 45 responsive page/width combinations in total and six management-page accessibility states per engine with zero automated WCAG A/AA findings. Embedded broadcast widgets are outside that accessibility scan. Linux runs cover all three engines; native macOS runs cover Chromium and WebKit.
- Trivy scans of both production architectures report zero HIGH/CRITICAL vulnerabilities. Eight HIGH findings from unused global npm dependencies were removed with the runtime package-manager tools. This is a scan result at the recorded time, not a claim that no lower-severity or undisclosed issues exist.
- Four new README screenshots show the actual app: Live, Layout, Setup and mobile Live. The recorded H2D layout preserves all 19 sources, its 18 scene items and 2560×1440 canvas after a real editor save. Screenshot telemetry and cloud responses are demo data.

See [the QA record](qa-studio-refresh.md) for coverage, reproducible commands and remaining hardware checks.

## Release and installation

The maintainer approved publishing the completed refresh and updating the Synology installation on October 7. Docker publication is gated on hosted validation. Before replacing the NAS container, back up its entire data volume and retain its previous image and container settings. Check MQTT telemetry, the actual camera feed, FTPS toolpaths and existing layouts after installation. Actual OBS and additional printer models require hardware checks; automated render/export and protocol coverage is recorded separately. Public YouTube streaming requires an explicitly authorized broadcast test; loopback checks already cover the relay and cleanup.

Version 3.2.0 identifies this release. Do not mark GitHub dependency alerts resolved before publishing and the subsequent dependency rescan.
