const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let checked = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js') && !file.endsWith('.min.js')) {
      const module = /^import /m.test(fs.readFileSync(file, 'utf8'));
      execFileSync(process.execPath, module ? ['--input-type=module', '--check'] : ['--check', file], module ? { input: fs.readFileSync(file) } : {});
      checked++;
    }
  }
}
for (const dir of ['src', 'public/js', 'public/widgets', 'scripts', 'test']) if (fs.existsSync(dir)) walk(dir);
console.log(`Syntax checked ${checked} JavaScript files`);
