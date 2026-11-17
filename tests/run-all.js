// Runs every *.test.js file in this folder, one after another,
// and prints a summary. Exits with code 1 if any test failed.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failedFiles = 0;
let totalPassed = 0;
let totalFailed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  const match = output.match(/(\d+) passed, (\d+) failed/);
  const passed = match ? Number(match[1]) : 0;
  const failed = match ? Number(match[2]) : 1; // no summary = it crashed
  totalPassed += passed;
  totalFailed += failed;
  const ok = result.status === 0 && failed === 0;
  if (!ok) failedFiles += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  (${passed} passed, ${failed} failed)`);
  if (!ok) {
    // Show the failing lines (and crash output) to help debugging
    console.log(output.split('\n').filter((l) => /FAIL|Error|got:|want:/.test(l)).join('\n'));
  }
}

console.log(`\nTotal: ${totalPassed} passed, ${totalFailed} failed, in ${files.length} files`);
process.exitCode = failedFiles > 0 ? 1 : 0;
