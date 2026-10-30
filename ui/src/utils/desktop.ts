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
  /** Tells the app a recording runs, so it stays awake and asks before quitting. */
  recordingState?(active: boolean): void;
}

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

export function reportRecording(active: boolean): void {
  desktopBridge()?.recordingState?.(active);
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
