import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Each writer owns its temporary file; readers see a complete old or new version. */
export async function atomicWrite(target: string, content: string | Buffer): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const existing = await fsp.lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  try {
    await fsp.writeFile(temporary, content, { flag: 'wx', mode: existing?.isFile() ? existing.mode & 0o777 : 0o600 });
    await fsp.rename(temporary, target);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

/** Errors that mean "this file system cannot make hard links", where atomicCreate falls back to an exclusive write. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

/** atomicCreate's staging files: `.<name>.<pid>.<uuid v4>.create-tmp`, only ever in the app's own staging folder. */
const STAGED = /^\..+\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.create-tmp$/;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes staging files of creates whose process has ended (a crash right after publishing leaves one as a second
 * name of the record; before publishing, a lone copy). Only in the app's staging folder, only names of the exact
 * pattern, and never while the recorded process is running, however old the file is.
 */
async function sweepStaging(staging: string): Promise<void> {
  for (const name of await fsp.readdir(staging).catch(() => [] as string[])) {
    const match = STAGED.exec(name);
    if (!match || processAlive(Number(match[1]))) continue;
    const file = path.join(staging, name);
    if ((await fsp.lstat(file).catch(() => null))?.isFile()) await fsp.unlink(file).catch(() => {});
  }
}

/**
 * Creates `target` with `content` only if nothing is there, and only once the content is complete: the file is written
 * in `staging` (an app-owned folder on the same file system, already checked by the caller), then published with a
 * hard link, which fails with EEXIST when the name is taken. With hard links, an interrupted write (a full disk, a
 * crash) never leaves a partial file under `target`. The staging file of a create whose process ended is removed by
 * a later create. Without hard links (or across file systems) it falls back to an exclusive write straight into
 * `target`, removing that file again if the write fails.
 */
export async function atomicCreate(target: string, content: string | Buffer, staging: string | null, mode = 0o600): Promise<void> {
  // Null (no workspace): staged beside the target, and nothing is swept there.
  if (staging) await sweepStaging(staging);
  const temporary = path.join(staging ?? path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.create-tmp`);
  try {
    await fsp.writeFile(temporary, content, { flag: 'wx', mode });
    try {
      await fsp.link(temporary, target);
      return;
    } catch (err) {
      if (!NO_HARD_LINKS.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
    }
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  // No hard links here: the name is claimed exclusively and the file this call created is removed if the write fails.
  const handle = await fsp.open(target, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await fsp.unlink(target).catch(() => {});
    throw err;
  }
}
