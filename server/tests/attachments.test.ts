import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { listFolderFiles, topLevelName } from '../src/utils/files';

test('files the dashboard cannot remove are listed as not removable', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-attachments-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  // Names a file manager can create but the app refuses to change.
  for (const name of ['ok.txt', 'draft.', 'trailing ', 'a:b.txt']) await fsp.writeFile(path.join(dir, name), 'x');
  await fsp.mkdir(path.join(dir, 'assets'));
  await fsp.writeFile(path.join(dir, 'assets', 'logo.txt'), 'x');
  const removable = Object.fromEntries((await listFolderFiles(dir)).map((f) => [f.name, f.removable]));
  assert.deepEqual(removable, { 'ok.txt': true, 'draft.': false, 'trailing ': false, 'a:b.txt': false, 'assets/logo.txt': false });
  // The flag matches what removal accepts.
  for (const [name, ok] of Object.entries(removable)) {
    if (ok) assert.equal(topLevelName(name), name);
    else assert.throws(() => topLevelName(name));
  }
});
