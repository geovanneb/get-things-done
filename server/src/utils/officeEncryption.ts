import * as path from 'path';
import { constants, promises as fsp } from 'fs';

/**
 * What the Office check found in a file. There is no "readable" result: a normal-looking package can still be
 * damaged or protected in a way this check does not look for, so finding nothing is reported as nothing (null).
 * - `encrypted`: an encrypted Office package (a compound file with the documented `EncryptionInfo` and
 *   `EncryptedPackage` streams), as sensitivity labels and passwords produce. Agents cannot read it.
 * - `unsupported_container`: the extension says Word, Excel or PowerPoint, but the file is neither a ZIP package
 *   nor an encrypted one (empty, truncated, renamed, or an unreadable compound file).
 */
export type OfficeCheck = 'encrypted' | 'unsupported_container';

/**
 * Formats that are checked: the ZIP-based Word, Excel and PowerPoint formats, which become a compound file when
 * encrypted. Legacy .doc/.xls/.ppt are compound files anyway and mark encryption inside their own streams, and
 * PDFs use their own encryption: those, and every other type, are not checked.
 */
const CHECKED_EXTENSIONS = new Set([
  'docx', 'docm', 'dotx', 'dotm',
  'xlsx', 'xlsm', 'xltx', 'xltm', 'xlsb',
  'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm',
]);

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xfffffffe;
/** Upper bound on sectors read per file, so a large or malformed compound file costs a few reads, not the file. */
const MAX_SECTOR_READS = 256;
const ENCRYPTION_STREAMS = ['EncryptionInfo', 'EncryptedPackage'];

/** Whether `name` has an extension this check looks at. */
export function isCheckedOfficeName(name: string): boolean {
  return CHECKED_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());
}

interface CacheEntry { stamp: string; result: OfficeCheck | null }
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 2000;

/**
 * Checks a Word, Excel or PowerPoint file for an encrypted or unsupported container; other types return null.
 * Reads the header and the compound-file directory only, never the whole file, and never decrypts anything.
 * The result is cached per path and file identity (inode, size, modification time), so a replaced file is
 * checked again. A file that cannot be opened or read returns null: not checked.
 */
export async function checkOfficeFile(fullPath: string): Promise<OfficeCheck | null> {
  if (!isCheckedOfficeName(fullPath)) return null;
  let handle: fsp.FileHandle | undefined;
  try {
    // O_NOFOLLOW where the system has it: a symlink swapped in after listing is not followed out of the folder.
    handle = await fsp.open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const hit = cache.get(fullPath);
    if (hit?.stamp === stamp) return hit.result;
    const result = await inspect(handle, stat.size);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.delete(fullPath);
    cache.set(fullPath, { stamp, result });
    return result;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspect(handle: fsp.FileHandle, size: number): Promise<OfficeCheck | null> {
  const head = await readAt(handle, 0, 512);
  if (head.length >= 4 && head.subarray(0, 4).equals(ZIP_SIGNATURE)) return null;
  if (head.length < 512 || !head.subarray(0, 8).equals(CFB_SIGNATURE)) return 'unsupported_container';
  const names = await compoundStreamNames(handle, head, size);
  return names && ENCRYPTION_STREAMS.every((n) => names.has(n)) ? 'encrypted' : 'unsupported_container';
}

async function readAt(handle: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * Names of the streams in a compound file's directory ([MS-CFB]), or null when the structure is malformed or
 * needs more than MAX_SECTOR_READS reads. Follows the directory's sector chain through the FAT.
 */
async function compoundStreamNames(handle: fsp.FileHandle, header: Buffer, size: number): Promise<Set<string> | null> {
  const shift = header.readUInt16LE(0x1e);
  if (shift !== 9 && shift !== 12) return null;
  const sectorSize = 1 << shift;
  const perSector = sectorSize / 4;
  let reads = 0;
  const sectors = new Map<number, Buffer>();
  const sector = async (id: number): Promise<Buffer | null> => {
    const cached = sectors.get(id);
    if (cached) return cached;
    const offset = (id + 1) * sectorSize;
    if (id >= END_OF_CHAIN - 16 || offset + sectorSize > size || ++reads > MAX_SECTOR_READS) return null;
    const data = await readAt(handle, offset, sectorSize);
    if (data.length < sectorSize) return null;
    sectors.set(id, data);
    return data;
  };

  // The FAT sector holding entry `index`: the first 109 are listed in the header, the rest in DIFAT sectors.
  const fatSector = async (index: number): Promise<number | null> => {
    if (index < 109) return header.readUInt32LE(0x4c + index * 4);
    let difat = header.readUInt32LE(0x44);
    let rest = index - 109;
    while (rest >= perSector - 1) {
      const data = await sector(difat);
      if (!data) return null;
      difat = data.readUInt32LE(sectorSize - 4);
      rest -= perSector - 1;
    }
    const data = await sector(difat);
    return data ? data.readUInt32LE(rest * 4) : null;
  };

  const names = new Set<string>();
  const visited = new Set<number>();
  let current = header.readUInt32LE(0x30);
  while (current !== END_OF_CHAIN) {
    if (visited.has(current)) return null;
    visited.add(current);
    const dir = await sector(current);
    if (!dir) return null;
    for (let at = 0; at + 128 <= sectorSize; at += 128) {
      const nameBytes = dir.readUInt16LE(at + 0x40);
      const type = dir[at + 0x42];
      if (type !== 2 || nameBytes < 2 || nameBytes > 64) continue;
      names.add(dir.toString('utf16le', at, at + nameBytes - 2));
    }
    if (ENCRYPTION_STREAMS.every((n) => names.has(n))) return names;
    const fatId = await fatSector(Math.floor(current / perSector));
    const fat = fatId === null ? null : await sector(fatId);
    if (!fat) return null;
    current = fat.readUInt32LE((current % perSector) * 4);
  }
  return names;
}
