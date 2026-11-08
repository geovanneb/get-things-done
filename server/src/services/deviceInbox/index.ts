import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { MeetingDigestService } from '../meetingDigestService';
import { announce } from './announce';
import { deviceId, sharedKey } from './crypto';
import { InboxServer, type OfferedItem } from './inboxServer';
import { readState, writeState, type InboxState, type PairedDevice } from './store';

const PAIRING_MS = 5 * 60_000;
const MAX_TRIES = 5;

export interface PairingCode { version: 1; name: string; public_key: string; code: string; port: number; hosts: string[]; expires_at: string }
export interface InboxStatus { enabled: boolean; listening: boolean; devices: Omit<PairedDevice, 'public_key'>[] }

/** The addresses a phone can try when the name cannot be found. */
function localAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => !!entry && !entry.internal && entry.family === 'IPv4')
    .map((entry) => entry.address);
}

/** Receives meetings from paired phones. Off until the person turns it on, and it listens only while on. */
export class DeviceInbox {
  private state: InboxState | null = null;
  private server: InboxServer | null = null;
  private port = 0;
  private stopAnnouncing: () => void = () => {};
  private pairing: { code: Buffer; expires: number; tries: number } | null = null;

  constructor(private readonly meetings = new MeetingDigestService(), private readonly name = os.hostname().replace(/\.local$/, '')) {}

  private async current(): Promise<InboxState> {
    this.state ??= await readState();
    return this.state;
  }

  async resume(): Promise<void> {
    if ((await this.current()).enabled) await this.listen();
  }

  async status(): Promise<InboxStatus> {
    const state = await this.current();
    return {
      enabled: state.enabled,
      listening: !!this.server,
      devices: state.devices.map(({ public_key: _key, ...device }) => device),
    };
  }

  async setEnabled(enabled: boolean): Promise<InboxStatus> {
    const state = await this.current();
    state.enabled = enabled;
    await writeState(state);
    if (enabled) await this.listen();
    else await this.close();
    return this.status();
  }

  async startPairing(): Promise<PairingCode> {
    const state = await this.current();
    if (!state.enabled) await this.setEnabled(true);
    const code = randomBytes(16);
    const expires = Date.now() + PAIRING_MS;
    this.pairing = { code, expires, tries: 0 };
    return {
      version: 1, name: this.name, public_key: state.identity.public_key, code: code.toString('base64'),
      port: this.port, hosts: localAddresses(), expires_at: new Date(expires).toISOString(),
    };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  async removeDevice(id: string): Promise<InboxStatus> {
    const state = await this.current();
    state.devices = state.devices.filter((device) => device.id !== id);
    await writeState(state);
    return this.status();
  }

  async stop(): Promise<void> {
    await this.close();
  }

  private async close(): Promise<void> {
    this.stopAnnouncing();
    this.stopAnnouncing = () => {};
    this.pairing = null;
    await this.server?.stop();
    this.server = null;
  }

  private async listen(): Promise<void> {
    if (this.server) return;
    const state = await this.current();
    const privateKey = Buffer.from(state.identity.private_key, 'base64');
    const publicKey = Buffer.from(state.identity.public_key, 'base64');
    const server = new InboxServer({
      privateKey,
      publicKey,
      deviceKey: (id) => {
        const device = state.devices.find((entry) => entry.id === id);
        return device ? sharedKey(privateKey, Buffer.from(device.public_key, 'base64')) : null;
      },
      pairingCode: () => this.activeCode(),
      pair: (phoneKey, name) => this.addDevice(phoneKey, name),
      deliveredMeeting: (item) => state.delivered.find((entry) => entry.id === item)?.meeting_id ?? null,
      deliver: (_device, item, files) => this.deliver(item, files),
      touched: (id) => {
        const device = state.devices.find((entry) => entry.id === id);
        if (device) device.last_seen_at = new Date().toISOString();
      },
    });
    this.port = await server.start(state.port);
    this.server = server;
    if (state.port !== this.port) {
      state.port = this.port;
      await writeState(state);
    }
    this.stopAnnouncing = announce(this.name, this.port, deviceId(publicKey));
  }

  /** A wrong proof spends a try, so that a code cannot be guessed while it is on screen. */
  private activeCode(): Buffer | null {
    const pairing = this.pairing;
    if (!pairing || Date.now() > pairing.expires || pairing.tries >= MAX_TRIES) {
      this.pairing = null;
      return null;
    }
    pairing.tries += 1;
    return pairing.code;
  }

  private async addDevice(phoneKey: Buffer, name: string): Promise<boolean> {
    const state = await this.current();
    const publicKey = phoneKey.toString('base64');
    state.devices = state.devices.filter((device) => device.public_key !== publicKey);
    state.devices.push({ id: deviceId(phoneKey), name, public_key: publicKey, paired_at: new Date().toISOString(), last_seen_at: null });
    await writeState(state);
    this.pairing = null;
    return true;
  }

  /** Through the same path as a file added by hand, so that the same limits and checks apply. */
  private async deliver(item: OfferedItem, files: { name: string; path: string }[]): Promise<string> {
    const meeting = await this.meetings.createMeeting({ title: item.title, meeting_date: item.date });
    for (const file of files) {
      const size = (await fsp.stat(file.path)).size;
      const upload = await this.meetings.writeUpload(meeting.id, file.name, createReadStream(file.path), size);
      await this.meetings.commitUpload(meeting.id, file.name, upload);
    }
    await this.meetings.queue(meeting.id);
    const state = await this.current();
    state.delivered.push({ id: item.id, meeting_id: meeting.id });
    await writeState(state);
    return meeting.id;
  }
}

export const deviceInbox = new DeviceInbox();
