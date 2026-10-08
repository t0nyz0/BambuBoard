# BambuBoard 3.3.0 release QA

This release combines G-code recovery, managed YouTube streaming and Bambu Cloud sign-in improvements with the existing Studio UI. All suites run against the combined release, using Node 24 and the locked dependency graph.

## Automated coverage

| Check | Coverage |
|---|---|
| Server | 56 passing tests, no skips: configuration/migration, atomic draft saves/publication, concurrent sign-in/sign-out and rollback, TLS MQTT/FTPS, archive integrity, print lifecycles, cloud authentication, camera framing, real H.264/AAC and server capture through loopback RTMP. |
| Widget/browser | All 20 widgets and 15 responsive layouts; keyboard controls, saved query parameters, draft/publish isolation and local assets. |
| Management UI | 12 groups and 15 page/width combinations per engine in Chromium, Firefox and WebKit; no JavaScript errors or axe WCAG 2/2.1 A/AA findings in tested states. |
| G-code browser | Nine groups through HTTP, FTPS, ZIP and WebGL: bounded retries, diagnostics, manual recovery, stale jobs/telemetry, clock skew, renderer failures and viewport fitting. |
| Streaming browser | Seven groups: real MediaRecorder-to-FFmpeg-to-RTMP, fresh recording headers after retry, audio fallback, cancellation, buffering, persistent server controls, mobile layout and accessibility. |
| Cloud browser | Nine groups and seven accessibility states per engine: email/code/MFA, resend/rate limits, challenge fallback, token verification, saved-account checks, account replacement and sign-out. Uses actual app APIs/files with simulated Bambu responses. |
| Containers | The server suite, startup and video checks run on native linux/amd64 and linux/arm64 CI runners, including bundled Chromium capture and FFmpeg. |
| Dependencies/assets | Clean npm install and zero npm audit findings; Trivy reports zero HIGH/CRITICAL findings for both production architectures. Vendor bytes reproduce from the lockfile; README catalog, 39 local links/anchors, scripts and captures are checked. |

The README test-count badge is checked against the actual Node runner result. GitHub's Docker publication workflow requires all three CI jobs before publishing; it repeats these gates for main and version tags.

## Repeat verification

```bash
npm ci
npm run check
npm test
npx playwright install --with-deps chromium firefox webkit
npm run test:browser
npm run test:gcode-browser
npm run test:stream-browser
BB_BROWSERS=chromium,firefox,webkit npm run test:ui
BB_BROWSERS=chromium,firefox,webkit npm run test:cloud
npm audit --audit-level=low
npm run build:vendor
git diff --exit-code -- public/vendor public/assets/js
```

Fresh README images use the [isolated capture workflow](qa-studio-refresh.md#screenshots-and-safe-fixtures), with demo credentials, recorded H2D camera video and sample cloud responses. They preserve the recorded 2560×1440 scene geometry without writing to the NAS.

## Production verification and limits

Back up the complete data mount and retain the previous image/container settings before updating. After installation, check telemetry, camera decoding, the saved published scene, G-code file access, cloud connection status and streaming setup. Confirm the deployed app version and image digest match the release. Keep the backup until the new container is verified.

The [G-code record](gcode-resilience.md#verification) includes a read-only physical H2D file download and local rendering. Other printer firmware, actual OBS and a real new-account email/MFA sign-in are outside the automated fixture coverage. Streaming tests deliver playable video to a local RTMP receiver; they do not establish YouTube broadcast acceptance or long-running NAS performance. Use an authorized private/unlisted channel test before relying on direct streaming for a broadcast.

Release notes record the production checks completed for the deployed build. Historical [3.2.0 Studio results](qa-studio-refresh.md) retain that release's original test counts.
