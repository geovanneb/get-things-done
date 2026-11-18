#!/usr/bin/env node
/**
 * `npm audit --audit-level=high` with written, per-advisory exceptions.
 *
 *   node scripts/audit-check.mjs desktop    audits desktop/ (every dependency: Electron ships inside the app)
 *
 * Fails on any high or critical advisory that is not listed below for that folder, and when the audit itself cannot
 * run. An exception names one advisory, the only packages it may be found in, and why it is accepted; it never
 * covers another advisory in the same package. An exception the audit no longer reports is flagged so it gets removed.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Per folder: advisory URL -> where it may appear and why it is accepted. Keep each one until a fixed version lands. */
const EXCEPTIONS = {
  desktop: {
    'https://github.com/advisories/GHSA-fc5q-39xc-vjpf': {
      packages: ['picomatch'],
      added: '2026-11-18',
      reason: 'ReDoS in picomatch <= 4.0.7, with no fixed release yet. It reaches desktop/ only through electron-builder '
        + '(@electron/rebuild -> node-gyp -> tinyglobby), which runs on the build machine when the app is packaged, '
        + 'over our own file patterns. It is not in the packaged app. Remove this once picomatch > 4.0.7 is in the lockfile.',
    },
  },
};

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const THRESHOLD = RANK.high;

const scope = process.argv[2];
if (!scope || !(scope in EXCEPTIONS)) {
  console.error(`Usage: node scripts/audit-check.mjs <${Object.keys(EXCEPTIONS).join('|')}>`);
  process.exit(2);
}
const allowed = EXCEPTIONS[scope];

const run = spawnSync('npm', ['audit', '--json', '--prefix', path.join(root, scope)], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
});
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('npm audit did not return a report.\n', run.stderr || run.stdout);
  process.exit(1);
}
if (report.error || !report.vulnerabilities) {
  console.error('npm audit could not run:', JSON.stringify(report.error ?? report).slice(0, 2000));
  process.exit(1);
}

// Advisories are the objects in `via`; strings there only point to another vulnerable package.
const blocking = [];
const excused = [];
const seen = new Set();
for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || via === null) continue;
    seen.add(via.url);
    if ((RANK[via.severity] ?? RANK.critical) < THRESHOLD) continue;
    const exception = allowed[via.url];
    const entry = `${via.severity}  ${name}  ${via.title ?? ''}  ${via.url}`;
    if (exception && exception.packages.includes(name)) excused.push(entry);
    else blocking.push(entry);
  }
}

for (const entry of excused) console.log(`Accepted (see scripts/audit-check.mjs): ${entry}`);
for (const url of Object.keys(allowed)) {
  if (!seen.has(url)) console.log(`::warning::The audit exception for ${url} is no longer needed. Remove it from scripts/audit-check.mjs.`);
}
if (blocking.length) {
  console.error(`High or critical advisories in ${scope}/:`);
  for (const entry of blocking) console.error(`  ${entry}`);
  console.error('Update the dependency, or add a reviewed exception to scripts/audit-check.mjs.');
  process.exit(1);
}
console.log(`No high or critical advisories in ${scope}/ beyond ${excused.length} accepted.`);
