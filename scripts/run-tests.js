// Count real Node test-runner results rather than source-code matches.
// The existing CI jobs run npm test, so a stale README count fails validation.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--update-badge')) {
  console.error('Usage: npm test [-- --update-badge]');
  process.exit(1);
}
const files = fs.readdirSync(path.join(root, 'test'))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join('test', name));
if (!files.length) throw new Error('No server test files found.');

const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  stdio: ['inherit', 'pipe', 'inherit'],
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const totals = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)]
  .map(([, name, value]) => [name, Number(value)]));
if (!['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(name => Number.isInteger(totals[name]))
    || totals.tests < 1 || totals.fail !== 0 || totals.cancelled !== 0
    || totals.pass > totals.tests || totals.skipped > totals.tests || totals.todo > totals.tests) {
  throw new Error('Missing or inconsistent server test totals; README badge was not updated.');
}

const readmePath = path.join(root, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const badge = /\[!\[Server tests\]\(https:\/\/img\.shields\.io\/badge\/server_tests-(\d+)-51a34f\?style=flat-square\)\]/;
const match = readme.match(badge);
if (!match) throw new Error('Server test-count badge is missing from README.md.');
if (args.includes('--update-badge')) {
  const updated = readme.replace(badge, match[0].replace(`server_tests-${match[1]}-`, `server_tests-${totals.tests}-`));
  if (updated !== readme) fs.writeFileSync(readmePath, updated);
  console.log(`README badge updated: ${totals.tests} server tests (${totals.pass} passed, ${totals.skipped} skipped, ${totals.todo} todo).`);
} else if (Number(match[1]) !== totals.tests) {
  console.error(`README lists ${match[1]} server tests; the runner reported ${totals.tests}. Run npm test -- --update-badge.`);
  process.exit(1);
} else {
  console.log(`README badge verified: ${totals.tests} server tests.`);
}
