# Studio refresh QA record

Verified October 7, 2026 against `origin/main` at `2ab9d2735a65232440a4d0020a3d84b9ad412ef7`, with the refresh on `codex/studio-refresh`. The maintainer approved release 3.2.0 and a NAS update after these checks. The original FTP experiment checkout is unchanged. The results below record the pre-release QA; production installation is tracked separately.

## Results

| Check | Result | Coverage |
|---|---|---|
| Source installation and syntax | Pass | Clean locked npm install and server, management UI, widget and test JavaScript. |
| Server integration | 14/14 pass | Native Node 24 and the production images on linux/amd64 and linux/arm64. |
| Management UI | Pass in Chromium, Firefox and WebKit | 12 regression groups per engine; Live, Layout and Setup at 1440, 1024, 736, 390 and 320 px: 45 page/width combinations. |
| Automated accessibility | Zero findings | Six states per engine: Layout inspector, telemetry bindings, widget library, Live, expanded Setup and Login. axe WCAG 2/2.1 A/AA rules; broadcast canvas/iframe contents excluded. This is not a complete accessibility certification. |
| Widget/browser compatibility | Pass | All 20 widgets, real jQuery updates, MPEG-TS camera decoding, Three.js line/tube toolpaths with transparency; zero JavaScript errors or external asset requests in the checks. |
| Container startup and video | Pass on both architectures | First-run redirect, local font/logo/JS/CSS, API output and OBS export origin; MPEG-1 MPEG-TS and H.264/AAC FLV encoding and decoding using FFmpeg 8.1.2. |
| npm security audit | Zero vulnerabilities | Production and development dependency graph from `package-lock.json`. |
| Production image security | Zero HIGH/CRITICAL findings on both architectures | Trivy scans include Alpine and installed app packages. Lower severities were outside this scan. |
| Local frontend bundle reproducibility | Pass | Locked packages regenerate the same vendor bytes and manifest hashes. |
| README captures | Four fresh captures | Live, Layout, Setup and mobile Live; actual running app, visually inspected. |
| Existing H2D scene compatibility | Pass for captured layout | Real editor save preserves 19 sources, 18 scene items and a 2560×1440 canvas. |

The three-engine suite ran inside the official Playwright 1.63.0 Linux container. Chromium and WebKit also passed on macOS. The local Firefox binary could not launch under the current macOS privacy environment; its full application suite passed on Linux. GitHub Actions has the same three-engine and dual-architecture checks configured and must pass before the Docker publication job runs.

## What the tests exercise

Server fixtures cover legacy H2D configuration migration, recoverable backups, environment overrides, corrupt/new installations, active-pointer upgrades, draft versus published output, concurrent publication, failed publication recovery, draft deletion and application restart. Cloud tests use local HTTP responses. Transport tests use a local implicit-TLS FTPS server and 3MF archive, TLS MQTT broker with model detection/telemetry/reconnect, fragmented chamber-camera JPEG frames and a WebSocket-to-FFmpeg relay with a playable loopback RTMP receiver.

Browser regressions cover clearing the final style override, independent duplicate widgets, OBS alignment before/after reload, pending edits across multiple scenes, locked keyboard movement, Undo/Redo, visibility, invalid import, delayed save, edits made during saving, failed publication, published DOM stability, discard cancellation, Reset, reduced motion, expanded narrow-screen controls and incomplete Setup validation. The broader browser check also exercises keyboard widget addition, existing AMS/nozzle query parameters, HTTP tab-capture limitations and capture/relay cleanup.

QA fixed reproducible faults in transparent iframe backgrounds, nested interactive Layers controls, binding labels, prose link identification, cleared customizations, locked movement, anchor geometry, scene switching, invalid import handling and save/publication state. No failures remain in the completed automated suites.

## Screenshots and safe fixtures

The [README](../README.md#screenshots) uses:

- [Live](../screenshots/STUDIO-LIVE.png)
- [Layout](../screenshots/STUDIO-LAYOUT.png)
- [Setup](../screenshots/STUDIO-SETUP.png)
- [Mobile Live](../screenshots/STUDIO-MOBILE.png)

Captures run against an isolated temporary installation and TLS MQTT fixture. They replay a short camera sample obtained through the existing NAS viewer and use a sanitized copy of its layout, selected sample telemetry, local sample cloud responses and sample gcode. The setup host, serial number and access code are demo values. The camera/image/profile mocks are confined to the capture browser. The screenshots do not represent a new production connection or a real cloud login.

The default capture command uses a generated video test pattern. Local reference files are optional and are not committed:

```bash
npx playwright install chromium
node scripts/capture-readme.js

# Reuse sanitized local rendering examples and a recorded MPEG-TS camera sample.
BB_SCENE_REFERENCE=/absolute/path/scene.json \
BB_TELEMETRY_REFERENCE=/absolute/path/telemetry.json \
BB_CAMERA_REFERENCE=/absolute/path/camera.ts \
node scripts/capture-readme.js
```

`BB_SCREENSHOTS` selects an output directory. `BB_CAPTURE_EVIDENCE` writes a small JSON result with geometry preservation and browser error checks. `BB_BLOG_HERO=/absolute/path/image.png` also saves a 1600×1000 Live viewport capture for a project card or blog header. Temporary runtime data, fixture certificates and demo server processes are cleaned up after capture.

## Repeat the checks

Use Node.js 24 LTS and npm 11 or newer:

```bash
npm ci
npm run check
npm test
npx playwright install --with-deps chromium firefox webkit
npm run test:browser
BB_BROWSERS=chromium,firefox,webkit npm run test:ui
npm audit --audit-level=low
npm run build:vendor
```

For a local container check, repeat with both `linux/amd64` and `linux/arm64`:

```bash
docker build --platform linux/amd64 -t bambuboard:qa .
docker run --rm --platform linux/amd64 \
  -v "$PWD/test:/usr/src/app/test:ro" bambuboard:qa \
  sh -ec 'apk add --no-cache openssl; node --test test/*.test.js'
```

OpenSSL is added only to the temporary test container to generate loopback fixture certificates. The production image includes FFmpeg, Node and locked production dependencies; npm/npx/Yarn are removed after installation. Rebuild the image for package changes.

## Release checks still required

The existing NAS was used read-only for rendering references during QA. Before replacing its container, back up the complete data volume and retain the previous image and container settings. Check actual printer telemetry, camera and FTPS toolpaths after installation. Import/use the exported source in actual OBS with the matching canvas. The browser renderer and export JSON have been verified; actual OBS and X1 Carbon hardware have not.

Loopback RTMP and capture cleanup pass. A public YouTube broadcast is untested and requires an explicitly authorized test. Other supported printer models have not been physically tested in this refresh.

Release preparation bumps the app and lockfile to 3.2.0 without changing tested application behavior. After completing BambuBoard QA, a separate `codex/bambuboard-blog-image` branch prepares the t0nyz.com post and project-card image with a matching demo caption. That update is approved for publication alongside the app release.
