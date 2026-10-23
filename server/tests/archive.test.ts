import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { zipFolder, MAX_ARCHIVE_FILES, MAX_ARCHIVE_DEPTH } from '../src/utils/files';
import { buildZip } from '../src/utils/zip';

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-archive-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Entry names and contents of a ZIP, read from its central directory. */
function unzip(zip: Buffer): Map<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(at + 42);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(zip.subarray(dataAt, dataAt + size)).toString('utf8'));
    at += 46 + skip;
  }
  return out;
}

async function folder(root: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, 'my-template');
  for (const [name, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), content);
  }
  return dir;
}

test('a ZIP holds every file, more than the screen lists, with the own .md first', async (t) => {
  const files: Record<string, string> = { 'output.md': 'meta' };
  for (let i = 0; i < 600; i++) files[`a${String(i).padStart(3, '0')}.txt`] = String(i);
  const dir = await folder(await temporary(t), files);
  const zip = unzip((await zipFolder(dir, 'output.md')).data);
  assert.equal(zip.size, 601);
  assert.equal([...zip.keys()][0], 'my-template/output.md');
  assert.equal(zip.get('my-template/a599.txt'), '599');
});

test('a ZIP keeps files in deep subfolders and refuses folders nested past the limit', async (t) => {
  const root = await temporary(t);
  const deep = 'a/b/c/d/e/file.txt';
  const dir = await folder(root, { 'output.md': 'meta', [deep]: 'deep' });
  assert.equal(unzip((await zipFolder(dir, 'output.md')).data).get(`my-template/${deep}`), 'deep');
  const tooDeep = Array.from({ length: MAX_ARCHIVE_DEPTH }, (_, i) => `d${i}`).join('/') + '/file.txt';
  await fsp.mkdir(path.dirname(path.join(dir, tooDeep)), { recursive: true });
  await fsp.writeFile(path.join(dir, tooDeep), 'x');
  await assert.rejects(zipFolder(dir, 'output.md'), /Invalid: .* nested too deep/);
});

test('a folder with too many files is refused instead of cut short', async (t) => {
  const files: Record<string, string> = { 'output.md': 'meta' };
  for (let i = 0; i < MAX_ARCHIVE_FILES; i++) files[`f${i}.txt`] = '';
  const dir = await folder(await temporary(t), files);
  await assert.rejects(zipFolder(dir, 'output.md'), /Invalid: folder has more than/);
});

test('a ZIP skips hidden files and symlinks and never holds content from outside the folder', async (t) => {
  const root = await temporary(t);
  await fsp.writeFile(path.join(root, 'private.txt'), 'PRIVATE');
  const dir = await folder(root, { 'output.md': 'meta', '.hidden': 'h', 'keep.txt': 'k' });
  await fsp.symlink(path.join(root, 'private.txt'), path.join(dir, 'link.txt'));
  await fsp.symlink(root, path.join(dir, 'outside'));
  await fsp.symlink(dir, path.join(dir, 'loop'));
  const zip = unzip((await zipFolder(dir, 'output.md')).data);
  assert.deepEqual([...zip.keys()], ['my-template/output.md', 'my-template/keep.txt']);
  assert.ok(![...zip.values()].includes('PRIVATE'));
});

test('a file name a ZIP cannot hold safely is refused', { skip: process.platform === 'win32' }, async (t) => {
  for (const name of ['assets\\..\\..\\outside.txt', 'a:b.txt']) {
    const dir = await folder(await temporary(t), { 'output.md': 'meta', [name]: 'x' });
    await assert.rejects(zipFolder(dir, 'output.md'), /Invalid: .* cannot be put in a ZIP/);
  }
});

test('a folder without its own .md is not zipped', async (t) => {
  const dir = await folder(await temporary(t), { 'other.txt': 'x' });
  await assert.rejects(zipFolder(dir, 'output.md'), /not found/);
});

test('ZIP dates outside 1980–2107 are clamped instead of failing', () => {
  for (const modified of [new Date('2108-01-01'), new Date('1970-01-01'), new Date(NaN)]) {
    const zip = buildZip([{ name: 'x.txt', data: Buffer.from('x'), modified }]);
    assert.equal(unzip(zip).get('x.txt'), 'x');
  }
});
