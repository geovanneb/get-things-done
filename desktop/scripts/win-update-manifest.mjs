// After the Windows installer is signed (SignPath, in .github/workflows/desktop.yml), its bytes change, so the
// sha512 and size that electron-builder wrote into release/latest.yml no longer match and electron-updater would
// refuse the download. This rewrites them for the signed file. The old blockmap describes the unsigned file, so it
// is removed: updates then download the whole installer instead of a broken partial one.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The release folder; tests pass another one.
const release = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'release');
const manifestPath = path.join(release, 'latest.yml');
const manifest = fs.readFileSync(manifestPath, 'utf8');

const installerName = manifest.match(/^path: (.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
if (!installerName) throw new Error('latest.yml has no "path:" entry');
const installer = path.join(release, installerName);
const bytes = fs.readFileSync(installer);
const sha512 = createHash('sha512').update(bytes).digest('base64');

// electron-builder writes one file entry for the NSIS installer: "sha512:" appears under files and at the top
// level, and "size:" once under files. All of them describe the installer.
const sha512Lines = manifest.match(/^\s*sha512: .+$/gm) ?? [];
const sizeLines = manifest.match(/^\s*size: \d+$/gm) ?? [];
if (sha512Lines.length !== 2 || sizeLines.length !== 1) {
  throw new Error(`Unexpected latest.yml layout (${sha512Lines.length} sha512, ${sizeLines.length} size); update this script.`);
}
const updated = manifest
  .replace(/^(\s*sha512: ).+$/gm, `$1${sha512}`)
  .replace(/^(\s*size: )\d+$/m, `$1${bytes.length}`);
fs.writeFileSync(manifestPath, updated);

for (const file of fs.readdirSync(release)) {
  if (file.endsWith('.blockmap')) fs.rmSync(path.join(release, file));
}
console.log(`latest.yml now describes the signed ${installerName} (${bytes.length} bytes)`);
