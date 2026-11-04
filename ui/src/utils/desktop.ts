/**
 * Native helpers when the dashboard runs in the desktop app, with the server routes as the browser fallback.
 * The desktop app's preload script sets `window.gtdDesktop`; a browser tab never has it.
 */
import { apiPost } from './api';

export interface DesktopBridge {
  version: number;
  /** The system folder dialog, attached to the app window. Null on cancel. */
  pickFolder(): Promise<string | null>;
  /** Opens the current workspace in Finder or Explorer. */
  openWorkspaceFolder(): Promise<{ opened: boolean; error?: string }>;
  /** Asks the system for the microphone: `granted`, or what the user should do. */
  microphoneAccess?(): Promise<string>;
  /** `yes` when the computer's own sound can be recorded; otherwise why not. */
  systemAudioSupport?(): Promise<string>;
  /** Tells the app a recording runs, so it stays awake and asks before quitting. */
  recordingState?(active: boolean): void;
  /** The spoken languages the menu-bar menu offers during a recording, and the current one. */
  recordingLanguage?(menu: SpokenLanguageMenu): void;
  /** Calls `listener` when the app's menu-bar menu asks the page for something about recording. Returns an unsubscribe. */
  onRecordingCommand?(listener: () => void): () => void;
  /**
   * Takes the menu's pending recording command, once: `open` the record dialog, `stop` the recording, `language:<code>`,
   * or `suggestion:switch:<id>` / `suggestion:keep:<id>` for a suggested spoken language.
   */
  takeRecordingCommand?(): Promise<string | null>;
  /** Names a finished run; the app reads it from its server and keeps its notice ready. A token, or null when not to say. */
  prepareRunNotice?(notice: { update_id: string; workspace: string; started_at: string }): Promise<string | null>;
  /** Shows a prepared notice now (unless the app's window is in front); whether it showed. */
  showRunNotice?(token: string): Promise<boolean>;
  /** Calls `listener` with the update to open (and its workspace) when such a notification is clicked. Returns an unsubscribe. */
  onOpenUpdate?(listener: (open: { update_id: string; workspace: string }) => void): () => void;
  /** Where the app's own update is (#284). */
  updateState?(): Promise<unknown>;
  /** Checks for an update now. */
  checkForUpdate?(): Promise<void>;
  /** Later on the banner, for this downloaded version: the app remembers it. */
  dismissUpdate?(version: string): Promise<void>;
  /** Restarts to install the downloaded update: null when it restarts, else why not now. */
  restartToUpdate?(): Promise<string | null>;
  /** Calls `listener` whenever the update's state changes. Returns an unsubscribe. */
  onUpdateState?(listener: (state: unknown) => void): () => void;
}

/** Where the desktop app's own update is: `off` for a build that does not update itself, `ready` to restart. */
export interface DesktopUpdate {
  phase: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  version: string | null;
  percent: number | null;
  error: string | null;
  /** The downloaded version put off with Later on the banner. */
  dismissed: string | null;
}

const PHASES = new Set(['off', 'idle', 'checking', 'downloading', 'ready', 'error']);

/** The app's answer, checked: anything else is no state at all. */
export function readDesktopUpdate(value: unknown): DesktopUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o['phase'] !== 'string' || !PHASES.has(o['phase'])) return null;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
  const percent = typeof o['percent'] === 'number' && Number.isFinite(o['percent']) ? Math.max(0, Math.min(100, Math.round(o['percent']))) : null;
  return { phase: o['phase'] as DesktopUpdate['phase'], version: text(o['version'], 60), percent, error: text(o['error'], 300), dismissed: text(o['dismissed'], 60) };
}

/** Whether this page runs in a desktop app that can tell it about its own update. */
export function hasDesktopUpdates(): boolean {
  const b = desktopBridge();
  return Boolean(b?.updateState && b.onUpdateState && b.restartToUpdate);
}

/** Follows the desktop app's update: the state now, then each change. No-op (and never called) in a browser. */
export function followDesktopUpdate(listener: (state: DesktopUpdate) => void): () => void {
  const b = desktopBridge();
  if (!b?.updateState || !b.onUpdateState) return () => undefined;
  let live = true;
  // A change pushed before the first answer is newer than that answer: the answer is then dropped.
  let pushed = false;
  const stop = b.onUpdateState((s) => { const v = readDesktopUpdate(s); if (live && v) { pushed = true; listener(v); } });
  void b.updateState().then((s) => { const v = readDesktopUpdate(s); if (live && !pushed && v) listener(v); }, () => undefined);
  return () => { live = false; stop(); };
}

/** Restart to update: null when the app restarts, else why not now. */
export async function restartToUpdate(): Promise<string | null> {
  const b = desktopBridge();
  if (!b?.restartToUpdate) return 'Only the desktop app restarts itself';
  return b.restartToUpdate();
}

export async function dismissDesktopUpdate(version: string): Promise<void> {
  await desktopBridge()?.dismissUpdate?.(version);
}

export async function checkDesktopUpdate(): Promise<void> {
  await desktopBridge()?.checkForUpdate?.();
}

export type RecordingCommand = 'open' | 'stop' | `language:${string}` | `suggestion:${'switch' | 'keep'}:${string}`;

/** A spoken language that sounds more likely than the one set: the menu bar offers it and says so once. */
export interface SuggestedLanguage { id: string; language: string; label: string; mode: 'mismatch' | 'auto' }

export interface SpokenLanguageMenu { current: string; options: { id: string; label: string }[]; suggested?: SuggestedLanguage }

export function desktopBridge(): DesktopBridge | undefined {
  const bridge = (globalThis as { gtdDesktop?: DesktopBridge }).gtdDesktop;
  return bridge && typeof bridge.version === 'number' ? bridge : undefined;
}

export function isDesktopApp(): boolean {
  return desktopBridge() !== undefined;
}

/** `granted`, or a message for the user. In a browser, the browser itself asks when recording starts. */
export async function microphoneAccess(): Promise<string> {
  return (await desktopBridge()?.microphoneAccess?.()) ?? 'granted';
}

/** In a browser only the microphone is recorded; the desktop app says whether this computer can do more. */
export async function systemAudioSupport(): Promise<string> {
  const bridge = desktopBridge();
  if (!bridge?.systemAudioSupport) return 'Only the microphone is recorded here, so people heard through headphones are not. The desktop app can also record the computer\'s sound.';
  return bridge.systemAudioSupport();
}

export function reportRecording(active: boolean): void {
  desktopBridge()?.recordingState?.(active);
}

export function reportLanguageMenu(menu: SpokenLanguageMenu): void {
  desktopBridge()?.recordingLanguage?.(menu);
}

/**
 * Runs `handler` for each recording command from the desktop app's menu-bar menu: one waiting from before the page
 * was ready, then each new one. A command is taken once, so two listeners never both act on it. No-op in a browser.
 */
export function onRecordingCommand(handler: (command: RecordingCommand) => void): () => void {
  const bridge = desktopBridge();
  if (!bridge?.onRecordingCommand || !bridge.takeRecordingCommand) return () => undefined;
  const take = () => {
    void bridge.takeRecordingCommand!().then((command) => {
      if (command === 'open' || command === 'stop' || command?.startsWith('language:') || /^suggestion:(switch|keep):[\w-]{1,64}$/.test(command ?? '')) handler(command as RecordingCommand);
    }).catch(() => undefined);
  };
  const unsubscribe = bridge.onRecordingCommand(take);
  take();
  return unsubscribe;
}

export async function pickFolder(): Promise<string | null> {
  const bridge = desktopBridge();
  if (bridge) return bridge.pickFolder();
  const { path } = await apiPost<{ path: string | null }>('/api/workspace/pick-folder', {});
  return path;
}

export async function openWorkspaceFolder(): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) {
    const result = await bridge.openWorkspaceFolder();
    if (!result.opened) throw new Error(result.error || 'Could not open the workspace folder.');
    return;
  }
  await apiPost('/api/workspace/open', {});
}
