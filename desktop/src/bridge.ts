// Main-process side of the preload bridge. Only the main window, showing the app's own pages, may call it,
// and no call takes a path from the page: the workspace path comes from the server.
import { BrowserWindow, IpcMainInvokeEvent, dialog, ipcMain, shell, systemPreferences } from 'electron';
import { classifyLink } from './links';
import type { RecordingCommand } from './recording-commands';

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

export function registerBridge(
  getWindow: () => BrowserWindow | null,
  getAppUrl: () => string,
  onRecording: (active: boolean) => void,
  takeRecordingCommand: () => RecordingCommand | null,
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

  ipcMain.handle('gtd:recording-state', async (event, active: unknown) => {
    if (event.senderFrame !== trusted(event).webContents.mainFrame) throw new Error('Not allowed');
    onRecording(active === true);
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
