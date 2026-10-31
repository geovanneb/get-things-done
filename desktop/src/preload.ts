// Runs in the main window before the dashboard loads. Exposes only these calls, never ipcRenderer itself.
// The dashboard looks for `window.gtdDesktop` (ui/src/utils/desktop.ts) and falls back to the server routes without it.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gtdDesktop', {
  version: 1,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('gtd:pick-folder'),
  openWorkspaceFolder: (): Promise<{ opened: boolean; error?: string }> => ipcRenderer.invoke('gtd:open-workspace-folder'),
  microphoneAccess: (): Promise<string> => ipcRenderer.invoke('gtd:microphone-access'),
  systemAudioSupport: (): Promise<string> => ipcRenderer.invoke('gtd:system-audio-support'),
  recordingState: (active: boolean): void => { void ipcRenderer.invoke('gtd:recording-state', active === true); },
  recordingLanguage: (menu: unknown): void => { void ipcRenderer.invoke('gtd:recording-language', menu); },
  // The menu-bar menu pings the page; the page then takes the command (see recording-commands.ts). The ping carries
  // nothing, and the listener never sees the IPC event.
  onRecordingCommand: (listener: () => void): (() => void) => {
    const ping = (): void => listener();
    ipcRenderer.on('gtd:recording-command', ping);
    return () => { ipcRenderer.removeListener('gtd:recording-command', ping); };
  },
  takeRecordingCommand: (): Promise<string | null> => ipcRenderer.invoke('gtd:take-recording-command'),
});
