import * as fs from 'fs';
import { createHash } from 'crypto';

/** The SHA-256 and size of a file, read as a stream: recordings can be gigabytes. */
export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}
