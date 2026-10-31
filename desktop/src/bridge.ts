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

/** The language menu a page may show in the menu bar: short lists of plain language codes and names, nothing else. */
export interface SpokenLanguageMenu { current: string; options: { id: string; label: string }[] }

export function parseLanguageMenu(value: unknown): SpokenLanguageMenu | null {
  const { current, options } = (value ?? {}) as Partial<SpokenLanguageMenu>;
  const code = (id: unknown): id is string => typeof id === 'string' && /^[a-z]{2,4}$/.test(id);
  if (!code(current) || !Array.isArray(options) || options.length > 12) return null;
  if (!options.every((o) => code(o?.id) && typeof o.label === 'string' && o.label.length > 0 && o.label.length <= 40)) return null;
  return { current, options: options.map(({ id, label }) => ({ id, label })) };
}

export function registerBridge(
  getWindow: () => BrowserWindow | null,
  getAppUrl: () => string,
  onRecording: (active: boolean) => void,
  takeRecordingCommand: () => RecordingCommand | null,
  onLanguageMenu: (menu: SpokenLanguageMenu | null) => void,
): void {
  const trusted = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow();
    const url = event.senderFrame?.url ?? '';
    if (!window || event.sender !== window.webContents || classifyLink(url, new URL(getAppUrl()).origin) !== 'app') {
      throw new Error('Not allowed');
    }
    return window;
  };

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
