// Electron main process: starts the same server as `gtd start` in a utility process and shows the dashboard in a window.
// The app keeps running in the tray when the window is closed, so routines still run on schedule.
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell, utilityProcess, UtilityProcess } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerBridge } from './bridge';
import { installNow, startUpdateChecks } from './updates';
import { classifyLink } from './links';
import { DEFAULT_PORT, findFreePort } from './port';

const APP_NAME = 'Get Things Done';
// The server, dashboard and templates: the repo itself when run from source, or the copy staged into the app's
// resources (scripts/stage-app.mjs), which has the same layout as `npm install -g @bertonha/getthingsdone`.
const appRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'gtd', 'node_modules', '@bertonha', 'getthingsdone')
  : path.resolve(__dirname, '..', '..');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: UtilityProcess | null = null;
let appUrl = '';
let quitting = false;

// ---- Settings kept by the desktop app (not the workspace) ----

interface DesktopSettings {
  port?: number;
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'desktop.json');
}

function readSettings(): DesktopSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as DesktopSettings;
  } catch {
    return {};
  }
}

function writeSettings(settings: DesktopSettings): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    // Not fatal: the next start just tries the default port again.
  }
}

// ---- Server ----

function startServerProcess(port: number): Promise<string> {
  const logDir = app.getPath('logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });

  server = utilityProcess.fork(path.join(__dirname, 'server-host.js'), [], {
    serviceName: `${APP_NAME} server`,
    stdio: 'pipe',
    env: { ...process.env, GTD_PORT: String(port), GTD_APP_ROOT: appRoot, NODE_ENV: 'production' },
  });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);

  return new Promise((resolve, reject) => {
    server!.on('message', (message: { type?: string; url?: string; message?: string }) => {
      if (message?.type === 'ready' && message.url) resolve(message.url);
      if (message?.type === 'failed') reject(new Error(message.message ?? 'The server did not start.'));
    });
    server!.once('exit', (code) => {
      server = null;
      if (!quitting) {
        reject(new Error(`The server stopped (exit code ${code}).`));
        if (appUrl) {
          dialog.showErrorBox(APP_NAME, `The server stopped unexpectedly. Details are in ${path.join(logDir, 'server.log')}.`);
          app.quit();
        }
      }
    });
  });
}

function stopServerProcess(): Promise<void> {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 7000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage({ type: 'shutdown' });
  });
}

// ---- Window ----

const secureWebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
} as const;

function guardContents(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = classifyLink(url, new URL(appUrl).origin);
    if (decision === 'app') {
      // Attachment and document previews open in their own app window.
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: secureWebPreferences } };
    }
    if (decision === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const decision = classifyLink(url, new URL(appUrl).origin);
    if (decision === 'app') return;
    event.preventDefault();
    if (decision === 'external') void shell.openExternal(url);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Only the main window gets the bridge; preview windows opened from it do not.
    webPreferences: { ...secureWebPreferences, preload: path.join(__dirname, 'preload.js') },
  });
  guardContents(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Closing the window keeps the app (and its routines) running in the tray. Quit from the tray or the app menu.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(appUrl);
}

function showWindow(): void {
  if (!appUrl) return;
  if (!mainWindow) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

// ---- Tray ----

function createTray(): void {
  const isMac = process.platform === 'darwin';
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  setTrayMenu(null);
  // Windows and Linux open the window on click; macOS shows the menu.
  if (!isMac) tray.on('click', showWindow);
}

/** `update` is a downloaded version waiting for a restart. */
function setTrayMenu(update: string | null): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: showWindow },
      { label: 'Open in browser', click: () => void shell.openExternal(appUrl) },
      ...(update ? [{ type: 'separator' as const }, { label: `Restart to update to ${update}`, click: installNow }] : []),
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, click: () => app.quit() },
    ]),
  );
}

// ---- App lifecycle ----

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running: it shows its window (see 'second-instance').
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  // Stay alive in the tray when every window is closed.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (!server) return;
    event.preventDefault();
    void stopServerProcess().then(() => app.quit());
  });

  app.whenReady().then(async () => {
    // The dashboard needs no camera, microphone, location or notifications yet. Copy buttons need clipboard writes.
    // Downloads (attachments, ZIPs) always ask where to save, starting in the Downloads folder.
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });
    registerBridge(() => mainWindow, () => appUrl);

    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });

    try {
      const settings = readSettings();
      const port = await findFreePort(settings.port ?? DEFAULT_PORT);
      appUrl = await startServerProcess(port);
      // Keep the same port next time: the dashboard stores its preferences per address.
      if (settings.port !== port) writeSettings({ ...settings, port });
    } catch (err) {
      dialog.showErrorBox(APP_NAME, `Could not start: ${err instanceof Error ? err.message : String(err)}`);
      quitting = true;
      app.quit();
      return;
    }

    createTray();
    startUpdateChecks((version) => setTrayMenu(version), async () => {
      // Electron closes windows before before-quit during an update. Allow that only after the server stops.
      quitting = true;
      await stopServerProcess();
    });
    createWindow();
  });
}
