#!/usr/bin/env node
// Cross-platform build helpers, so `npm run build` does not need `rm` or `cp`
// (which are missing on Windows outside WSL).
//
//   node scripts/build-utils.mjs clean <dir>
//   node scripts/build-utils.mjs copy <from> <to>

import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(`build-utils: ${message}`);
  process.exit(1);
}

if (command === 'clean' && args.length === 1) {
  rmSync(resolve(args[0]), { recursive: true, force: true });
} else if (command === 'copy' && args.length === 2) {
  const from = resolve(args[0]);
  if (!existsSync(from)) fail(`nothing to copy, ${args[0]} does not exist`);
  // Same result as `cp -r from to` when `to` does not exist yet.
  cpSync(from, resolve(args[1]), { recursive: true });
} else {
  fail('usage: build-utils.mjs clean <dir> | copy <from> <to>');
}
