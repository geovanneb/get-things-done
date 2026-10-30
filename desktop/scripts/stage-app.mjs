// Puts the server, dashboard and templates into stage/gtd exactly as `npm install -g @bertonha/getthingsdone`
// lays them out: the repo is packed with `npm pack` and that tarball is installed with production
// dependencies only. electron-builder then copies stage/gtd into the app (see "extraResources").
// Run after `npm run build` in the repo root.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const stage = path.join(desktop, 'stage');
const gtd = path.join(stage, 'gtd');

// `npm run` sets npm_execpath to npm's own script, which avoids npm.cmd and a shell on Windows.
const npmCli = process.env['npm_execpath'];
if (!npmCli) throw new Error('Run this through npm: npm run stage --prefix desktop');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

for (const required of ['dist/server/server.js', 'dist/ui/index.html', 'dist/cli/index.js']) {
  if (!fs.existsSync(path.join(root, required))) throw new Error(`Missing ${required}: run \`npm run build\` in the repo root first.`);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(gtd, { recursive: true });

// --ignore-scripts: the build already ran (prepublishOnly would build again).
const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', stage], root));
const tarball = path.join(stage, packed[0].filename);

fs.writeFileSync(path.join(gtd, 'package.json'), JSON.stringify({ name: 'gtd-desktop-stage', private: true }, null, 2));
// Optional dependencies are kept: the transcription engine (sherpa-onnx) ships its native binary for each platform
// as one, and npm installs the one for the computer building the app (each CI runner builds its own architecture).
// No install scripts: none of the production dependencies needs one.
npm(['install', tarball, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], gtd);

const app = path.join(gtd, 'node_modules', '@bertonha', 'getthingsdone');
for (const required of ['dist/server/server.js', 'dist/server/services/transcription/worker.js', 'dist/ui/index.html', 'templates/workspace', 'package.json']) {
  if (!fs.existsSync(path.join(app, required))) throw new Error(`Staged app is missing ${required}`);
}
// The engine's binary for this platform: without it transcription cannot run in the app.
const platform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
if (!fs.existsSync(path.join(gtd, 'node_modules', `sherpa-onnx-${platform}`, 'sherpa-onnx.node'))) {
  throw new Error(`Staged app is missing the transcription engine for ${platform} (sherpa-onnx-${platform})`);
}
fs.rmSync(tarball);
console.log(`Staged ${JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf-8')).version} into ${path.relative(desktop, gtd)}`);
