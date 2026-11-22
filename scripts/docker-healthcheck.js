const fs = require('node:fs');
const { CONFIG_PATH } = require('../src/config');
const { version } = require('../package.json');

async function main() {
  let port = process.env.PORT || Number(process.env.BAMBUBOARD_HTTP_PORT);
  if (!port) {
    try { port = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).BambuBoard_httpPort; } catch (_) {}
  }
  const response = await fetch(`http://127.0.0.1:${port || 8080}/version`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3500),
  });
  if (!response.ok || (await response.json()).version !== version) {
    throw new Error('Version endpoint returned an unexpected response');
  }
}

main().catch(error => {
  console.error(`BambuBoard health check: ${error.message}`);
  process.exitCode = 1;
});
