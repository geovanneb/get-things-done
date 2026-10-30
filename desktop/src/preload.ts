// Runs in the main window before the dashboard loads. Exposes only these calls, never ipcRenderer itself.
// The dashboard looks for `window.gtdDesktop` (ui/src/utils/desktop.ts) and falls back to the server routes without it.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gtdDesktop', {
  version: 1,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('gtd:pick-folder'),
  openWorkspaceFolder: (): Promise<{ opened: boolean; error?: string }> => ipcRenderer.invoke('gtd:open-workspace-folder'),
  microphoneAccess: (): Promise<string> => ipcRenderer.invoke('gtd:microphone-access'),
  recordingState: (active: boolean): void => { void ipcRenderer.invoke('gtd:recording-state', active === true); },
});
