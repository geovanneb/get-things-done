// Main-process side of the preload bridge. Only the main window, showing the app's own pages, may call it,
// and no call takes a path from the page: the workspace path comes from the server.
import { BrowserWindow, IpcMainInvokeEvent, dialog, ipcMain, shell, systemPreferences } from 'electron';
import { classifyLink } from './links';
import type { RecordingCommand } from './recording-commands';
import { systemAudioSupport } from './systemAudio';

/** Asks the system for the microphone. `granted`, or what the user should do: the system only ever asks once. */
async function microphoneAccess(): Promise<string> {
  const blocked = 'The microphone is blocked for Get Things Done. Allow it in System Settings > Privacy & Security > Microphone, then try again.';
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return 'granted';
    if (status === 'not-determined') return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : blocked;
    return blocked;
  }
  if (process.platform === 'win32') {
    return systemPreferences.getMediaAccessStatus('microphone') === 'denied'
      ? 'The microphone is blocked. Allow desktop apps to use it in Windows Settings > Privacy & security > Microphone, then try again.' : 'granted';
  }
  return 'granted';
}

import { parseLanguageMenu, type SpokenLanguageMenu } from './language-menu';
import { parseRunNoticeRequest, type RunNoticeRequest } from './run-notice';
export { parseRunNoticeRequest, type RunNoticeRequest } from './run-notice';
export { parseLanguageMenu, type SpokenLanguageMenu, type SuggestedLanguage } from './language-menu';

export function registerBridge(
  getWindow: () => BrowserWindow | null,
  getAppUrl: () => string,
  onRecording: (active: boolean) => void,
  takeRecordingCommand: () => RecordingCommand | null,
  onLanguageMenu: (menu: SpokenLanguageMenu | null) => void,
  runNotices: { prepare: (notice: RunNoticeRequest) => Promise<string | null>; show: (token: string) => boolean } = { prepare: async () => null, show: () => false },
  updates: { state: () => unknown; check: () => void; restart: () => Promise<string | null>; dismiss: (version: unknown) => void } = { state: () => null, check: () => undefined, restart: async () => 'Not available', dismiss: () => undefined },
): void {
  const trusted = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow();
    const url = event.senderFrame?.url ?? '';
    if (!window || event.sender !== window.webContents || classifyLink(url, new URL(getAppUrl()).origin) !== 'app') {
      throw new Error('Not allowed');
    }
    return window;
  };

  // The app's own update (#284): read, checked now, or installed with a restart (which waits while something runs).
  ipcMain.handle('gtd:update-state', async (event) => {
    trusted(event);
    return updates.state();
  });
  ipcMain.handle('gtd:update-check', async (event) => {
    trusted(event);
    updates.check();
  });
  ipcMain.handle('gtd:update-dismiss', async (event, version: unknown) => {
    trusted(event);
    updates.dismiss(version);
  });
  ipcMain.handle('gtd:update-restart', async (event) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    return updates.restart();
  });

  ipcMain.handle('gtd:pick-folder', async (event) => {
    const window = trusted(event);
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a workspace folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('gtd:microphone-access', async (event) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    return microphoneAccess();
  });

  ipcMain.handle('gtd:system-audio-support', async (event) => {
    trusted(event);
    return systemAudioSupport();
  });

  ipcMain.handle('gtd:recording-state', async (event, active: unknown) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    onRecording(active === true);
  });

  ipcMain.handle('gtd:recording-language', async (event, menu: unknown) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    onLanguageMenu(parseLanguageMenu(menu));
  });

  ipcMain.handle('gtd:take-recording-command', async (event) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    return takeRecordingCommand();
  });

  // A finished run in two steps: read and checked by the app (a token back), then shown once the page says it still
  // should, with nothing awaited in between.
  ipcMain.handle('gtd:run-notice-prepare', async (event, notice: unknown) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    const parsed = parseRunNoticeRequest(notice);
    return parsed ? runNotices.prepare(parsed) : null;
  });

  ipcMain.handle('gtd:run-notice-show', async (event, token: unknown) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token) ? runNotices.show(token) : false;
  });

  ipcMain.handle('gtd:open-workspace-folder', async (event) => {
    trusted(event);
    try {
      const res = await fetch(`${getAppUrl()}/api/workspace`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return { opened: false, error: 'No workspace is open yet.' };
      const { path } = (await res.json()) as { path?: string };
      if (!path) return { opened: false, error: 'No workspace is open yet.' };
      const error = await shell.openPath(path);
      return error ? { opened: false, error } : { opened: true };
    } catch (err) {
      return { opened: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
