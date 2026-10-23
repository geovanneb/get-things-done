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
