import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { atomicWrite } from '../utils/atomicWrite';

/** The dashboard crops to 256 px; the limits leave room without accepting arbitrary uploads. */
export const MAX_ICON_BYTES = 512 * 1024;
export const MAX_ICON_SIDE = 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class InvalidIconError extends Error {}

/**
 * Icons live in the home config, not in the workspace folder: they are a per-machine
 * preference and should not travel with the workspace's git history.
 */
function iconDir(): string {
  return path.join(os.homedir(), '.gtd', 'workspace-icons');
}

/** One file per workspace folder. Hashing the path keeps request values out of the filename. */
export function workspaceIconPath(workspacePath: string): string {
  const key = createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 32);
  return path.join(iconDir(), `${key}.png`);
}

/** Changes whenever the icon does, so the dashboard can bust its image cache. Null when there is none. */
export function workspaceIconVersion(workspacePath: string): string | null {
  try {
    const stat = fs.statSync(workspaceIconPath(workspacePath));
    return stat.isFile() ? String(Math.round(stat.mtimeMs)) : null;
  } catch {
    return null;
  }
}

/** Accepts only a PNG of reasonable size, as produced by the dashboard's crop dialog. */
export function decodeIcon(dataUrl: unknown): Buffer {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw new InvalidIconError('The picture must be sent as a PNG data URL.');
  }
  const body = dataUrl.slice(prefix.length);
  if (body.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) {
    throw new InvalidIconError('The picture is too large or not valid base64.');
  }
  const buffer = Buffer.from(body, 'base64');
  if (buffer.length > MAX_ICON_BYTES) throw new InvalidIconError('The picture is too large.');
  // Signature, then the IHDR chunk with width and height.
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new InvalidIconError('The picture is not a PNG image.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_ICON_SIDE || height > MAX_ICON_SIDE) {
    throw new InvalidIconError(`The picture must be at most ${MAX_ICON_SIDE} x ${MAX_ICON_SIDE} pixels.`);
  }
  return buffer;
}

export async function saveWorkspaceIcon(workspacePath: string, png: Buffer): Promise<void> {
  await fsp.mkdir(iconDir(), { recursive: true, mode: 0o700 });
  await atomicWrite(workspaceIconPath(workspacePath), png);
}

export async function removeWorkspaceIcon(workspacePath: string): Promise<void> {
  await fsp.rm(workspaceIconPath(workspacePath), { force: true });
}
