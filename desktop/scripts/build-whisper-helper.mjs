// Builds gtd-whisper (native/whisper-helper): Whisper on the GPU, for Apple Silicon Macs. Needs CMake and Xcode's
// command line tools. whisper.cpp comes from the commit pinned in its CMakeLists.txt; WHISPER_SOURCE_DIR builds from a
// local copy of that commit instead. Elsewhere it does nothing: the app works without it, on the CPU engine.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = path.join(root, 'native', 'whisper-helper');
const build = path.join(source, 'build');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log('The GPU engine is built for Apple Silicon Macs only; skipped.');
  process.exit(0);
}

const cmake = process.env['CMAKE'] ?? 'cmake';
const configure = ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release'];
if (process.env['WHISPER_SOURCE_DIR']) configure.push(`-DFETCHCONTENT_SOURCE_DIR_WHISPER=${process.env['WHISPER_SOURCE_DIR']}`);
execFileSync(cmake, configure, { stdio: 'inherit' });
execFileSync(cmake, ['--build', build, '--config', 'Release', '--target', 'gtd-whisper', '-j', '4'], { stdio: 'inherit' });

const helper = path.join(build, 'gtd-whisper');
if (!fs.existsSync(helper)) throw new Error(`The build did not make ${helper}`);
// It must start: an empty model path is refused with a JSON line, without touching the GPU.
let answer = '';
try {
  execFileSync(helper, [], { stdio: ['ignore', 'pipe', 'ignore'] });
} catch (err) {
  answer = String(err.stdout ?? '');
}
if (!answer.includes('"type":"error"')) throw new Error(`The GPU engine does not run: ${answer || 'no answer'}`);
console.log(`Built ${path.relative(root, helper)}`);
