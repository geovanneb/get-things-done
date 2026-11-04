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
  // A finished run, said by the system while the app is not in front (the app writes the words); a click on it asks
  // the page to open the update, with its workspace.
  prepareRunNotice: (notice: unknown): Promise<string | null> => ipcRenderer.invoke('gtd:run-notice-prepare', notice).then((t) => (typeof t === 'string' ? t : null), () => null),
  showRunNotice: (token: string): Promise<boolean> => ipcRenderer.invoke('gtd:run-notice-show', token).then((shown) => shown === true, () => false),
  // The app's own update (#284): where it is, a check now, a restart to install it (null when restarting, else why not).
  updateState: (): Promise<unknown> => ipcRenderer.invoke('gtd:update-state'),
  checkForUpdate: (): Promise<void> => ipcRenderer.invoke('gtd:update-check'),
  dismissUpdate: (version: string): Promise<void> => ipcRenderer.invoke('gtd:update-dismiss', version),
  restartToUpdate: (): Promise<string | null> => ipcRenderer.invoke('gtd:update-restart').then((r) => (typeof r === 'string' ? r : null), () => 'The app could not be asked to restart'),
  onUpdateState: (listener: (state: unknown) => void): (() => void) => {
    const changed = (_event: unknown, value: unknown): void => listener(value);
    ipcRenderer.on('gtd:update-state', changed);
    return () => { ipcRenderer.removeListener('gtd:update-state', changed); };
  },
  onOpenUpdate: (listener: (open: { update_id: string; workspace: string }) => void): (() => void) => {
    const open = (_event: unknown, value: unknown): void => {
      const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      if (typeof o['update_id'] === 'string' && /^CU-\d{4}-\d{4}$/.test(o['update_id']) && typeof o['workspace'] === 'string') listener({ update_id: o['update_id'], workspace: o['workspace'] });
    };
    ipcRenderer.on('gtd:open-update', open);
    return () => { ipcRenderer.removeListener('gtd:open-update', open); };
  },
});
