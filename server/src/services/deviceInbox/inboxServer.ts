import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { open, proof, sameBytes, seal } from './crypto';
import { inboxDir } from './store';
import { workspaceEntry } from '../../utils/files';

export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILES = 10;
const OVERHEAD_BYTES = 28;
const ITEM_ID = /^[0-9a-f-]{36}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;

/**
 * Every path the inbox reads or writes comes from here. The parts come from a phone, so each is checked again and the
 * result must stay inside the inbox folder, whatever was validated earlier on the way in.
 */
export function inboxPath(device: string, item: string, name?: string): string {
  if (!DEVICE_ID.test(device) || !ITEM_ID.test(item) || (name !== undefined && !FILE_NAME.test(name))) throw new Refused(400, 'Bad path');
  const base = path.resolve(inboxDir());
  const full = path.resolve(base, device, item, name ?? '');
  if (!full.startsWith(base + path.sep)) throw new Refused(400, 'Bad path');
  return full;
}

export interface OfferedFile { name: string; size: number; sha256: string }
export interface OfferedItem { id: string; title: string; date: string; files: OfferedFile[] }

/** What the inbox needs from its owner. It never touches the workspace or the main server by itself. */
export interface InboxHost {
  privateKey: Buffer;
  publicKey: Buffer;
  deviceKey(id: string): Buffer | null;
  pair(phoneKey: Buffer, name: string, code: Buffer): Promise<boolean> | boolean;
  pairingCode(): Buffer | null;
  deliveredMeeting(itemId: string): string | null;
  deliver(deviceId: string, item: OfferedItem, files: { name: string; path: string }[]): Promise<string>;
  touched(deviceId: string): void;
}

class Refused extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function body(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > limit) throw new Refused(413, 'Too large');
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

/** Only addresses a device on the same link can have. A forwarded port reaches nothing. */
export function isLocalAddress(raw: string | undefined): boolean {
  const address = (raw ?? '').replace(/^::ffff:/, '');
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(address)
    || /^(fe80:|fd|fc|::1$)/i.test(address);
}

function validItem(value: unknown): value is OfferedItem {
  const item = value as OfferedItem;
  return !!item && typeof item.id === 'string' && ITEM_ID.test(item.id) && typeof item.title === 'string'
    && typeof item.date === 'string' && Array.isArray(item.files) && item.files.length > 0 && item.files.length <= MAX_FILES
    && item.files.every((file) => !!file && typeof file.name === 'string' && FILE_NAME.test(file.name)
      && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_BYTES
      && typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256))
    && new Set(item.files.map((file) => file.name.toLowerCase())).size === item.files.length;
}

/**
 * The only thing this app listens to outside the computer. It is a separate server, not the dashboard's: it has no
 * way to reach the API or the workspace, and everything past pairing must be sealed by a device paired on purpose.
 */
export class InboxServer {
  private server: http.Server | null = null;
  private offers = new Map<string, OfferedItem>();
  private pending = new Map<string, Promise<unknown>>();

  /** Serialize retries and commits for an item, including offers that could replace its manifest. */
  private async withItem<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.pending.set(id, next);
    try { return await next; }
    finally { if (this.pending.get(id) === next) this.pending.delete(id); }
  }

  constructor(private readonly host: InboxHost) {}

  async start(port: number): Promise<number> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        const status = error instanceof Refused ? error.status : 400;
        if (!res.headersSent) res.writeHead(status);
        res.end();
      });
    });
    server.requestTimeout = 120_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        // The saved port was taken: any other will do, because phones find this computer by name.
        if (error.code === 'EADDRINUSE' && port !== 0) server.listen(0, '0.0.0.0', resolve);
        else reject(error);
      });
      server.listen(port, '0.0.0.0', resolve);
    });
    this.server = server;
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isLocalAddress(req.socket.remoteAddress)) throw new Refused(403, 'Not local');
    const url = new URL(req.url ?? '/', 'http://inbox');
    const route = url.pathname;
    if (req.method === 'POST' && route === '/v1/pair') return this.pair(req, res);

    const id = req.headers['x-device'];
    const key = typeof id === 'string' ? this.host.deviceKey(id) : null;
    if (typeof id !== 'string' || !key) throw new Refused(401, 'Not paired');
    const authorized = <T>(operation: () => Promise<T>): Promise<T> => {
      // A request may have waited for its body or another operation while the phone was forgotten.
      const current = this.host.deviceKey(id);
      if (!current || !sameBytes(current, key)) throw new Refused(401, 'Not paired');
      return operation();
    };

    const chunk = /^\/v1\/items\/([0-9a-f-]{36})\/files\/(\d+)$/.exec(route);
    if (req.method === 'PUT' && chunk) {
      const offset = Number(url.searchParams.get('offset'));
      const sealed = await body(req, MAX_CHUNK_BYTES + OVERHEAD_BYTES);
      const plain = open(key, sealed, `${route}?offset=${offset}`);
      const received = await this.withItem(chunk[1], () => authorized(() => this.receive(id, chunk[1], Number(chunk[2]), offset, plain)));
      this.host.touched(id);
      return this.answer(res, key, route, { received });
    }

    const message = open(key, await body(req, MAX_MESSAGE_BYTES), route);
    await authorized(() => Promise.resolve());
    this.host.touched(id);
    if (req.method === 'POST' && route === '/v1/offer') {
      const parsed = JSON.parse(message.toString()) as { items?: unknown };
      if (!Array.isArray(parsed.items)) throw new Refused(400, 'No items');
      return this.answer(res, key, route, { items: await Promise.all(parsed.items.filter(validItem).map((item) => this.withItem(item.id, () => authorized(() => this.status(id, item))))) });
    }
    const commit = /^\/v1\/items\/([0-9a-f-]{36})\/commit$/.exec(route);
    if (req.method === 'POST' && commit) {
      return this.answer(res, key, route, { meeting_id: await this.withItem(commit[1], () => authorized(() => this.commit(id, commit[1]))) });
    }
    throw new Refused(404, 'Unknown');
  }

  private answer(res: http.ServerResponse, key: Buffer, route: string, value: unknown): void {
    const sealed = seal(key, Buffer.from(JSON.stringify(value)), `answer:${route}`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': sealed.length });
    res.end(sealed);
  }

  private async pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const bytes = await body(req, 4096);
    const code = this.host.pairingCode();
    if (!code) throw new Refused(403, 'Not pairing');
    const parsed = JSON.parse(bytes.toString()) as { phone_public?: unknown; phone_name?: unknown; proof?: unknown };
    if (typeof parsed.phone_public !== 'string' || typeof parsed.proof !== 'string') throw new Refused(400, 'Bad request');
    const phoneKey = Buffer.from(parsed.phone_public, 'base64');
    if (phoneKey.length !== 32) throw new Refused(400, 'Bad key');
    const name = typeof parsed.phone_name === 'string' ? parsed.phone_name.slice(0, 80) : 'iPhone';
    const accepted = sameBytes(proof(code, phoneKey), Buffer.from(parsed.proof, 'base64'))
      && await this.host.pair(phoneKey, name, code);
    if (!accepted) throw new Refused(403, 'Wrong code');
    const answer = JSON.stringify({ proof: proof(code, this.host.publicKey, phoneKey).toString('base64') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(answer);
  }

  private async status(device: string, item: OfferedItem): Promise<{ id: string; complete: boolean; files: number[] }> {
    if (this.host.deliveredMeeting(item.id)) return { id: item.id, complete: true, files: [] };
    this.offers.set(`${device}/${item.id}`, item);
    await workspaceEntry(inboxDir(), inboxPath(device, item.id), true);
    await fsp.mkdir(inboxPath(device, item.id), { recursive: true, mode: 0o700 });
    const files = await Promise.all(item.files.map(async (file) => {
      const target = await workspaceEntry(inboxDir(), inboxPath(device, item.id, file.name), true);
      const stat = await fsp.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && !stat.isFile()) throw new Refused(400, 'Not a plain file');
      return stat?.size ?? 0;
    }));
    return { id: item.id, complete: false, files };
  }

  /** An offset other than what is held is answered with what is held, so that a phone can pick up from there. */
  private async receive(device: string, itemId: string, index: number, offset: number, plain: Buffer): Promise<number> {
    const item = this.offers.get(`${device}/${itemId}`);
    const file = item?.files[index];
    if (!file) throw new Refused(404, 'Not offered');
    const target = await workspaceEntry(inboxDir(), inboxPath(device, itemId, file.name), true);
    const stat = await fsp.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && !stat.isFile()) throw new Refused(400, 'Not a plain file');
    const held = stat?.size ?? 0;
    if (offset !== held) return held;
    if (held + plain.length > file.size) throw new Refused(413, 'Past the offered size');
    await fsp.appendFile(target, plain, { mode: 0o600 });
    return held + plain.length;
  }

  private async commit(device: string, itemId: string): Promise<string> {
    const done = this.host.deliveredMeeting(itemId);
    if (done) return done;
    const item = this.offers.get(`${device}/${itemId}`);
    if (!item) throw new Refused(404, 'Not offered');
    const dir = inboxPath(device, itemId);
    const files = item.files.map((file) => ({ name: file.name, path: inboxPath(device, itemId, file.name) }));
    for (const [index, file] of item.files.entries()) {
      await workspaceEntry(inboxDir(), files[index].path);
      const stat = await fsp.lstat(files[index].path);
      if (!stat.isFile()) throw new Refused(400, 'Not a plain file');
      if (stat.size < file.size) throw new Refused(422, `${file.name} has not finished arriving`);
      const hash = createHash('sha256');
      for await (const part of fs.createReadStream(files[index].path)) hash.update(part as Buffer);
      if (stat.size !== file.size || hash.digest('hex') !== file.sha256) {
        // A full but damaged file cannot resume: discard only that file so the next offer starts it again.
        await fsp.unlink(files[index].path);
        throw new Refused(422, `${file.name} did not arrive intact`);
      }
    }
    const meeting = await this.host.deliver(device, item, files);
    this.offers.delete(`${device}/${itemId}`);
    await fsp.rm(dir, { recursive: true, force: true });
    return meeting;
  }
}
