import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { listFolderFiles, safeFileName, topLevelName } from '../src/utils/files';

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

test('uploaded names keep letters of any script; separators and symbols become _', () => {
  assert.equal(safeFileName('会議.wav'), '会議.wav');
  assert.equal(safeFileName('weird name ü 会議 (1).wav'), 'weird_name_ü_会議__1_.wav');
  assert.equal(safeFileName('reunia\u0303o.m4a'), 'reunião.m4a', 'a decomposed name from a Mac becomes NFC');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a\u202Egnp.exe'), 'a_gnp.exe', 'a direction override is not kept');
  // Cut by UTF-8 bytes, keeping the extension: 50 three-byte characters are 150 bytes.
  const long = safeFileName(`${'議'.repeat(50)}.wav`, 120);
  assert.ok(Buffer.byteLength(long) <= 120 && long.endsWith('.wav') && long.startsWith('議'), long);
  assert.equal(safeFileName('notes.md', 120), 'notes.md');
});
