#!/usr/bin/env node
// Keep the data-only parser boundary enforceable in CI, including future services.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../server/src/', import.meta.url));
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.ts')) {
      const source = await readFile(full, 'utf8');
      if (source.includes('gray-matter') && full !== path.join(root, 'utils', 'markdown.ts')) {
        throw new Error(`${path.relative(root, full)}: use utils/markdown instead of importing gray-matter directly`);
      }
    }
  }
}
await walk(root);
console.log('Server parser boundary OK');
