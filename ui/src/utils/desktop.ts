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
}

export function desktopBridge(): DesktopBridge | undefined {
  const bridge = (globalThis as { gtdDesktop?: DesktopBridge }).gtdDesktop;
  return bridge && typeof bridge.version === 'number' ? bridge : undefined;
}

export function isDesktopApp(): boolean {
  return desktopBridge() !== undefined;
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
