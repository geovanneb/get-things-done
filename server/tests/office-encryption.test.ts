import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkOfficeFile } from '../src/utils/officeEncryption';
import { listFolderFiles, saveAttachment } from '../src/utils/files';

const SECTOR = 512;
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;

function dirEntry(name: string, type: number): Buffer {
  const entry = Buffer.alloc(128);
  entry.write(name, 0, 'utf16le');
  entry.writeUInt16LE((name.length + 1) * 2, 0x40);
  entry[0x42] = type;
  entry.writeUInt32LE(FREE, 0x44); // left sibling
  entry.writeUInt32LE(FREE, 0x48); // right sibling
  entry.writeUInt32LE(FREE, 0x4c); // child
  entry.writeUInt32LE(END_OF_CHAIN, 0x74); // start sector
  return entry;
}

/**
 * A minimal compound file ([MS-CFB], 512-byte sectors): sector 0 is the FAT, the directory runs over sectors
 * 1..n so the reader must follow the FAT chain. `streams` go in the last directory sector.
 */
function compoundFile(streams: string[], directorySectors = 2, loop = false): Buffer {
  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c); // one FAT sector
  header.writeUInt32LE(1, 0x30); // directory starts at sector 1
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(END_OF_CHAIN, 0x3c);
  header.writeUInt32LE(END_OF_CHAIN, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 0x4c + i * 4);

  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0); // sector 0 is the FAT itself
  for (let s = 1; s <= directorySectors; s++) {
    fat.writeUInt32LE(s === directorySectors ? (loop ? 1 : END_OF_CHAIN) : s + 1, s * 4);
  }

  const directory: Buffer[] = [];
  for (let s = 1; s <= directorySectors; s++) {
    const sector = Buffer.alloc(SECTOR);
    const entries = s === 1 ? [dirEntry('Root Entry', 5)] : [];
    if (s === directorySectors) entries.push(...streams.map((n) => dirEntry(n, 2)));
    entries.forEach((e, i) => e.copy(sector, i * 128));
    directory.push(sector);
  }
  return Buffer.concat([header, fat, ...directory]);
}

const ENCRYPTED = compoundFile(['\u0006DataSpaces', 'EncryptionInfo', 'EncryptedPackage']);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-office-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('an encrypted Office package is detected by its encryption streams', async (t) => {
  const dir = await tempDir(t);
  const cases: Array<[string, Buffer, string | null]> = [
    ['labelled.docx', ENCRYPTED, 'encrypted'],
    ['labelled.XLSX', ENCRYPTED, 'encrypted'],
    ['normal.pptx', ZIP, null],
    // A compound file without the encryption streams: a legacy document renamed, or something else.
    ['renamed.docx', compoundFile(['WordDocument', '\u0001CompObj']), 'unsupported_container'],
    ['only-info.docx', compoundFile(['EncryptionInfo']), 'unsupported_container'],
    ['text.docx', Buffer.from('not an office file'), 'unsupported_container'],
    ['empty.xlsx', Buffer.alloc(0), 'unsupported_container'],
    ['truncated.docx', ENCRYPTED.subarray(0, 600), 'unsupported_container'],
    ['looping.docx', compoundFile(['Something'], 3, true), 'unsupported_container'],
    // Not checked: legacy formats mark encryption inside their own streams, and other types are not Office packages.
    ['legacy.doc', ENCRYPTED, null],
    ['notes.txt', ENCRYPTED, null],
  ];
  for (const [name, data, expected] of cases) {
    await fsp.writeFile(path.join(dir, name), data);
    assert.equal(await checkOfficeFile(path.join(dir, name)), expected, name);
  }
  assert.equal(await checkOfficeFile(path.join(dir, 'missing.docx')), null);
});

test('a replaced file is checked again', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'report.docx');
  await fsp.writeFile(file, ZIP);
  assert.equal(await checkOfficeFile(file), null);
  // Replaced the way an agent or a sync client would: a new file renamed over the old one.
  await fsp.writeFile(path.join(dir, 'tmp'), ENCRYPTED);
  await fsp.rename(path.join(dir, 'tmp'), file);
  assert.equal(await checkOfficeFile(file), 'encrypted');
  await fsp.writeFile(file, ZIP);
  assert.equal(await checkOfficeFile(file), null);
});

test('uploads and file lists report unreadable Office files', async (t) => {
  const dir = await tempDir(t);
  const saved = await saveAttachment(dir, 'Board deck.pptx', ENCRYPTED, 'note.md');
  assert.equal(saved.officeCheck, 'encrypted');
  const plain = await saveAttachment(dir, 'plain.docx', ZIP, 'note.md');
  assert.equal('officeCheck' in plain, false);
  // Files an agent writes straight into a subfolder are checked too.
  await fsp.mkdir(path.join(dir, 'deliverables'));
  await fsp.writeFile(path.join(dir, 'deliverables', 'draft.xlsx'), 'oops');
  const checks = Object.fromEntries((await listFolderFiles(dir)).map((f) => [f.name, f.officeCheck]));
  assert.deepEqual(checks, { 'Board_deck.pptx': 'encrypted', 'plain.docx': undefined, 'deliverables/draft.xlsx': 'unsupported_container' });
});
