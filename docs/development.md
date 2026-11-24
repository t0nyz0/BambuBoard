# Development

The server is plain Node/Express in [`src`](../src), the management pages are in [`views`](../views), and each standalone widget is in [`public/widgets`](../public/widgets). Keep the server [capability map](../src/lib/caps.js) and its [browser mirror](../public/js/caps.js) in sync. Commit `package-lock.json` with dependency changes and use `npm ci` for repeatable installs.

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
| `node scripts/capture-readme.js` | Capture Live, Layout, Setup and mobile screenshots with isolated demo data. [Fixture options](qa-studio-refresh.md#screenshots-and-safe-fixtures). |
| `npm run build:vendor` | Regenerate bundled local assets from locked packages. |
| `npm run build:widget-catalog` | Print the catalog from `widget.json` files; replace the README content between the catalog markers with that output. |
| `node scripts/ftp-test.js` | Read-only current-print FTPS check with redacted JSON output. Also available as `docker exec bambuboard node scripts/ftp-test.js`. |

Install Chromium for browser checks with `npx playwright install chromium`. To run management UI checks across all three engines:

```bash
npx playwright install --with-deps chromium firefox webkit
BB_BROWSERS=chromium,firefox,webkit npm run test:ui
BB_BROWSERS=chromium,firefox,webkit npm run test:cloud
```

The **server tests** badge counts `npm test` cases and is checked against the actual runner total. The **build** badge tracks the main Docker workflow, which requires server tests, browser/UI checks and both container architectures before publishing. [Release QA](qa-3.3.1.md), [Studio QA](qa-studio-refresh.md), [G-code QA](gcode-resilience.md#verification) and [YouTube QA](youtube-streaming.md#verification) describe fixture coverage and hardware limitations.

[Back to the README](../README.md)
