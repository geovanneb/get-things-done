import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const script = path.join(__dirname, '..', 'scripts', 'win-update-manifest.mjs');
const installer = 'Get Things Done Setup 0.7.0.exe';

function release(manifest: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-winmanifest-'));
  fs.writeFileSync(path.join(dir, 'latest.yml'), manifest);
  fs.writeFileSync(path.join(dir, installer), 'signed installer bytes');
  fs.writeFileSync(path.join(dir, `${installer}.blockmap`), 'old');
  return dir;
}

test('after signing, latest.yml describes the signed installer and the stale blockmap is gone', (t) => {
  const dir = release([
    'version: 0.7.0',
    'files:',
    `  - url: ${installer}`,
    '    sha512: unsignedhash==',
    '    size: 3',
    `path: ${installer}`,
    'sha512: unsignedhash==',
    "releaseDate: '2026-10-29T00:00:00.000Z'",
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  execFileSync(process.execPath, [script, dir]);

  const manifest = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  const sha512 = createHash('sha512').update('signed installer bytes').digest('base64');
  assert.equal(manifest.match(new RegExp(`sha512: ${sha512.replace(/[+/=]/g, '\\$&')}`, 'g'))?.length, 2);
  assert.match(manifest, /^ {4}size: 22$/m);
  assert.doesNotMatch(manifest, /unsignedhash/);
  assert.ok(!fs.existsSync(path.join(dir, `${installer}.blockmap`)));
});

test('an unexpected manifest layout stops the release instead of guessing', (t) => {
  const dir = release(`version: 0.7.0\npath: ${installer}\nsha512: onlyone==\n`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => execFileSync(process.execPath, [script, dir], { stdio: 'pipe' }), /Unexpected latest.yml layout/);
});
