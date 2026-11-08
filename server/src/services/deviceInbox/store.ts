import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite } from '../../utils/atomicWrite';
import { generateIdentity } from './crypto';

export interface PairedDevice { id: string; name: string; public_key: string; paired_at: string; last_seen_at: string | null }

export interface InboxState {
  enabled: boolean;
  port: number;
  /** Holds the private key, so it lives beside the user's config and never in the workspace, which may be synced. */
  identity: { public_key: string; private_key: string };
  devices: PairedDevice[];
  /** What already arrived, so that a phone that missed the answer can send again and change nothing. */
  delivered: { id: string; meeting_id: string }[];
}

const MAX_DELIVERED = 5000;

export const inboxDir = () => path.join(os.homedir(), '.gtd', 'device-inbox');
const stateFile = () => path.join(inboxDir(), 'state.json');

export async function readState(): Promise<InboxState> {
  await fsp.mkdir(inboxDir(), { recursive: true, mode: 0o700 });
  try {
    return JSON.parse(await fsp.readFile(stateFile(), 'utf8')) as InboxState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = generateIdentity();
  const state: InboxState = {
    enabled: false,
    port: 0,
    identity: { public_key: identity.publicKey.toString('base64'), private_key: identity.privateKey.toString('base64') },
    devices: [],
    delivered: [],
  };
  await writeState(state);
  return state;
}

export async function writeState(state: InboxState): Promise<void> {
  const delivered = state.delivered.slice(-MAX_DELIVERED);
  await atomicWrite(stateFile(), JSON.stringify({ ...state, delivered }, null, 2));
  await fsp.chmod(stateFile(), 0o600);
}
