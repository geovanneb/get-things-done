// Main-process side of the preload bridge. Only the main window, showing the app's own pages, may call it,
// and no call takes a path from the page: the workspace path comes from the server.
import { BrowserWindow, IpcMainInvokeEvent, dialog, ipcMain, shell } from 'electron';
import { classifyLink } from './links';

export function registerBridge(getWindow: () => BrowserWindow | null, getAppUrl: () => string): void {
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
