// Electron main process: starts the same server as `gtd start` in a utility process and shows the dashboard in a window.
// The app keeps running in the tray when the window is closed, so routines still run on schedule.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, powerSaveBlocker, session, shell, utilityProcess, UtilityProcess } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerBridge, type RunNoticeRequest } from './bridge';
import { noticeFromServer, noticeMemory, runNoticeWords, type RunNotice } from './run-notice';
import { randomUUID } from 'crypto';
import { stopServer } from './server-lifecycle';
import { checkNow, holdUpdatesWhile, installNow, startUpdateChecks, updateEnvironment, updateState } from './updates';
import { createQuitFlow, whyNotNow, type DesktopUpdateState } from './update-controller';
import { classifyLink } from './links';
import { RecordingCommands, type RecordingCommand } from './recording-commands';
import type { SpokenLanguageMenu } from './language-menu';
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

/**
 * Asked before quitting: a recording in this window, then what else would stop with the app (a recording from another
 * page, a transcription, an AI tool run; an update waiting would install). A server that can't be asked never keeps
 * the app from quitting.
 */
async function confirmQuit(): Promise<boolean> {
  let recordingAccepted = false;
  if (recording) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning', buttons: ['Keep recording', 'Quit anyway'], defaultId: 0, cancelId: 0,
      message: 'A recording is in progress',
      detail: 'Stop it first to save everything. If you quit, what was already saved stays, and you can finish it on the Routines page.',
    });
    if (choice === 0) return false;
    recordingAccepted = true;
  }
  if (!server) return true;
  const reason = whyNotNow(false, (await serverUpdateStatus())?.busy);
  if (!reason || (recordingAccepted && reason === 'A meeting is being recorded')) return true;
  const { response } = await dialog.showMessageBox({
    type: 'warning', buttons: ['Keep running', 'Quit anyway'], defaultId: 0, cancelId: 0,
    message: reason,
    detail: 'Quitting stops it now. Wait until it is done, or quit anyway.',
  });
  return response === 1;
}

/** One quit at a time; none goes through while the server stops (see createQuitFlow). */
const quitFlow = createQuitFlow({
  confirm: confirmQuit,
  stop: async () => { quitting = true; if (server) await stopServerProcess(); },
  quit: () => app.quit(),
});

/**
 * The app's own server, asked for its update status: what important runs (`busy`) and whether automatic update checks
 * are on. Undefined when it can't be asked in time (it never blocks then).
 */
async function serverUpdateStatus(): Promise<{ busy: string | null; auto_check: boolean } | undefined> {
  if (!appUrl) return undefined;
  try {
    const res = await fetch(new URL('/api/app/update', appUrl), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const body = await res.json() as { busy?: unknown; auto_check?: unknown };
    // Automatic checks only when the setting says so: anything else counts as off.
    return { busy: typeof body.busy === 'string' ? body.busy : null, auto_check: body.auto_check === true };
  } catch {
    return undefined;
  }
}

/** A downloaded update said once in a system notification, when the window is not there to show the banner. */
let notifiedUpdate: string | null = null;

/** The update changed: the tray, the page (banner and Settings), and a notification when no window shows it. */
function onUpdateState(state: DesktopUpdateState): void {
  setTrayMenu(state.phase === 'ready' ? state.version : null);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('gtd:update-state', { ...state, dismissed: readSettings().dismissedUpdate ?? null });
  if (state.phase === 'ready' && state.version && notifiedUpdate !== state.version && !mainWindow?.isVisible() && Notification.isSupported()) {
    notifiedUpdate = state.version;
    const note = new Notification({ title: `${APP_NAME} ${state.version} is ready`, body: 'Restart to update from the menu, or it is installed the next time you quit.' });
    note.on('click', showWindow);
    note.show();
  }
}

/**
 * Gets the app's server ready for a restart to update: it closes admission and checks again what runs. Null when it
 * may go ahead; otherwise why not (also when the server can't be asked: never a restart blindly).
 */
async function prepareServerForRestart(): Promise<string | null> {
  if (!appUrl) return 'The dashboard is not running';
  try {
    const res = await fetch(new URL('/api/app/update/desktop-restart', appUrl), { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (res.ok) return null;
    const body = await res.json().catch(() => ({})) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : 'What runs could not be checked; try again in a moment';
  } catch {
    return 'What runs could not be checked; try again in a moment';
  }
}

/** The restart to update did not go ahead: the server takes runs again, or, if it already stopped, the app starts over. */
function afterFailedRestart(): void {
  quitting = false;
  quitFlow.reset();
  if (server && appUrl) {
    void fetch(new URL('/api/app/update/desktop-restart/cancel', appUrl), { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  } else {
    app.relaunch();
    app.exit(0);
  }
}

/** The page's view of the update: the updater's state, and the version put off with Later. */
function pageUpdateState(): DesktopUpdateState & { dismissed: string | null } {
  return { ...updateState(), dismissed: readSettings().dismissedUpdate ?? null };
}

/** Later on the banner: that downloaded version is not offered again there (the tray and Settings still offer it). */
function dismissUpdate(version: unknown): void {
  if (typeof version !== 'string' || version !== updateState().version) return;
  writeSettings({ ...readSettings(), dismissedUpdate: version });
  onUpdateState(updateState());
}

/** Restart to update from the tray: says why when it has to wait. */
function restartFromTray(): void {
  void installNow().then((reason) => {
    if (reason) void dialog.showMessageBox({ type: 'info', message: 'Not now', detail: reason });
  });
}
/** A recording runs in the window; set by the dashboard through the bridge. */
let recording = false;
/** The spoken languages the page offers for the running recording, for the menu-bar menu. */
let languageMenu: SpokenLanguageMenu | null = null;
/** What the menu-bar menu asked the page to do about recording, until the page takes it. */
const recordingCommands = new RecordingCommands();
/** A downloaded update waiting for a restart, so the menu can be rebuilt when recording starts or stops. */
let pendingUpdate: string | null = null;
let keepAwake: number | null = null;

// ---- Settings kept by the desktop app (not the workspace) ----

interface DesktopSettings {
  port?: number;
  /** A downloaded update put off with Later on the banner. */
  dismissedUpdate?: string;
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
    env: {
      ...process.env, GTD_PORT: String(port), GTD_APP_ROOT: appRoot, NODE_ENV: 'production', ...updateEnvironment(),
      // Whisper on the GPU: built for Apple Silicon Macs only, and the server checks it is really there.
      ...(process.platform === 'darwin' && process.arch === 'arm64' ? { GTD_WHISPER_HELPER: path.join(process.resourcesPath, 'whisper', 'gtd-whisper') } : {}),
    },
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
  return stopServer(server);
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
  // A page that is gone records nothing, whatever it last said.
  mainWindow.webContents.on('render-process-gone', () => setRecording(false));
  // Closing the window keeps the app (and its routines) running in the tray. Quit from the tray or the app menu.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    setRecording(false);
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

// ---- Recording ----

/** While recording: the computer stays awake, the hidden window keeps working, and the tray says so. */
function setRecording(active: boolean): void {
  recording = active;
  if (!active) {
    languageMenu = null;
    recordingCommands.dropLanguage();
    announced.clear();
    closeSuggestionNote();
  }
  // Also called from the window's 'closed' event, when its page is already destroyed and cannot be changed.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(!active);
  }
  if (active && keepAwake === null) keepAwake = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && keepAwake !== null) {
    powerSaveBlocker.stop(keepAwake);
    keepAwake = null;
  }
  tray?.setToolTip(active ? `${APP_NAME}: recording` : APP_NAME);
  showRecordingTitle();
  setTrayMenu(pendingUpdate);
}

/** macOS shows text next to the menu-bar icon: a recording is visible even with the window closed, and a suggestion too. */
function showRecordingTitle(): void {
  if (process.platform !== 'darwin') return;
  const offer = recording ? languageMenu?.suggested : undefined;
  tray?.setTitle(!recording ? '' : offer ? `REC · ${offer.language.toUpperCase()}?` : 'REC');
}

/** The suggestions already said in this recording, so each is said once however often the page reports its menu. */
const announced = new Set<string>();
/** The notification of the current suggestion, closed when the suggestion goes. */
let shownNote: { id: string; note: Notification } | null = null;

/** Answers a suggestion from the menu bar or a notification, only while it is still the one offered. */
function answerSuggestion(answer: 'switch' | 'keep', id: string): void {
  if (recording && languageMenu?.suggested?.id === id) sendRecordingCommand(`suggestion:${answer}:${id}`);
}

/** The suggestion went (answered, replaced, or the recording ended): its notification must not act any more. */
function closeSuggestionNote(): void {
  if (shownNote && shownNote.id !== (recording ? languageMenu?.suggested?.id : undefined)) {
    shownNote.note.close();
    shownNote = null;
  }
}

/**
 * Says a new suggestion through the system, for when the app is hidden behind a call: switch from the notification
 * (an action on macOS, a click on Windows). Closing it, or letting it time out, changes nothing.
 */
function announceSuggestion(menu: SpokenLanguageMenu): void {
  closeSuggestionNote();
  const offer = menu.suggested;
  if (!recording || !offer || announced.has(offer.id) || !Notification.isSupported()) return;
  const current = menu.current === 'auto' ? 'Auto' : menu.options.find((o) => o.id === menu.current)?.label ?? menu.current;
  const mac = process.platform === 'darwin';
  const switchLabel = offer.mode === 'auto' ? `Set ${offer.label}` : `Switch to ${offer.label}`;
  const note = new Notification({
    title: offer.mode === 'auto' ? `Most speech sounds like ${offer.label}` : `This sounds like ${offer.label}`,
    body: offer.mode === 'auto'
      ? `Set ${offer.label} for a more accurate transcript.${mac ? '' : ' Click to set it.'}`
      : `The recording is set to ${current}.${mac ? '' : ` Click to switch to ${offer.label}.`}`,
    ...(mac ? { actions: [{ type: 'button' as const, text: switchLabel }, { type: 'button' as const, text: `Keep ${current}` }] } : {}),
  });
  // Buttons depend on the system's alert style and may not show: the menu bar and the banner offer the same choice.
  note.on('action', (_event, index) => {
    if (index === 0) answerSuggestion('switch', offer.id);
    else if (index === 1) answerSuggestion('keep', offer.id);
  });
  // On macOS a click on the notification itself opens the app; elsewhere it is the way to switch.
  note.on('click', () => { if (mac) showWindow(); else answerSuggestion('switch', offer.id); });
  // Said once; a notification the system could not show may be tried again with the next report of the menu.
  note.on('failed', () => {
    announced.delete(offer.id);
    if (shownNote?.note === note) shownNote = null;
  });
  try {
    announced.add(offer.id);
    shownNote = { id: offer.id, note };
    note.show();
  } catch {
    // No notification: the menu bar still shows it.
    announced.delete(offer.id);
    shownNote = null;
  }
}

/** A run started from the dashboard ended while the app was not in front: said once by the system; a click opens it. */
const notices = noticeMemory();
/** Notices read and checked, waiting for the page's last word (by token), for a short while only. */
const readyNotices = new Map<string, { notice: RunNotice; at: number }>();
const READY_FOR_MS = 30_000;
/** Drops notices kept longer than they may wait. */
function sweepReadyNotices(now: number): void {
  for (const [token, ready] of readyNotices) if (now - ready.at > READY_FOR_MS) readyNotices.delete(token);
}
/** Reads one of the app's own API answers, or null. */
async function own(pathname: string): Promise<unknown> {
  try {
    const res = await fetch(`${appUrl}${pathname}`, { headers: { Accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
/**
 * A finished run, step one: read it from the app's own server, in one request with its workspace, and keep it ready.
 * Only a run the server confirms ended; null otherwise or when already said. The page then decides (step two).
 */
async function prepareRunNotice(req: RunNoticeRequest): Promise<string | null> {
  if (!appUrl || !Notification.isSupported()) return null;
  const query = new URLSearchParams({ workspace: req.workspace, started_at: req.started_at });
  const notice = noticeFromServer(req, await own(`/api/context-updates/${req.update_id}/run-notice?${query}`));
  if (!notice || notices.said(notice)) return null;
  const now = Date.now();
  sweepReadyNotices(now);
  const token = randomUUID().replace(/-/g, '');
  readyNotices.set(token, { notice, at: now });
  return token;
}

/**
 * Step two, right after the page's own last checks: shown at once, nothing awaited, unless the app's window is in
 * front. Counted as said only once it showed. Answers whether it did.
 */
function showRunNotice(token: string): boolean {
  const now = Date.now();
  const ready = readyNotices.get(token);
  readyNotices.delete(token);
  sweepReadyNotices(now);
  // Kept too long (the page or the app was held up): old news, not said.
  if (!ready || now - ready.at > READY_FOR_MS || mainWindow?.isFocused() || notices.said(ready.notice)) return false;
  const { notice } = ready;
  try {
    const note = new Notification(runNoticeWords(notice));
    // With its workspace: the page opens it only there, never an update of the same id in another workspace.
    note.on('click', () => {
      showWindow();
      mainWindow?.webContents.send('gtd:open-update', { update_id: notice.update_id, workspace: notice.workspace });
    });
    note.show();
    notices.remember(notice);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the page to open the record dialog or to stop the recording. Opening needs the window; stopping does not,
 * since the recorder keeps running while the window is hidden.
 */
function sendRecordingCommand(command: RecordingCommand): void {
  recordingCommands.leave(command);
  if (command === 'open') showWindow();
  // A page that is not there yet takes the command once it loads (onRecordingCommand takes it on start).
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('gtd:recording-command');
}

/** The microphone only, for the app's own main window. Preview windows and any other page never get it. */
function mayRecord(contents: Electron.WebContents | null, origin: string | undefined, types: string[] | undefined, isMainFrame: boolean): boolean {
  if (!mainWindow || contents !== mainWindow.webContents || !origin || !isMainFrame) return false;
  if (classifyLink(origin, new URL(appUrl).origin) !== 'app') return false;
  return !types || (types.length > 0 && types.every((t) => t === 'audio'));
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
  pendingUpdate = update;
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      recording
        ? { label: 'Stop recording and save', click: () => sendRecordingCommand('stop') }
        : { label: 'Record a meeting…', click: () => sendRecordingCommand('open') },
      ...(recording && languageMenu?.suggested ? (() => {
        const offer = languageMenu.suggested;
        const current = languageMenu.current === 'auto' ? 'Auto' : languageMenu.options.find((o) => o.id === languageMenu?.current)?.label ?? languageMenu.current;
        return [
          { label: offer.mode === 'auto' ? `Most speech sounds like ${offer.label}` : `Sounds like ${offer.label}`, enabled: false },
          { label: offer.mode === 'auto' ? `Set ${offer.label}` : `Switch to ${offer.label}`, click: () => answerSuggestion('switch', offer.id) },
          { label: `Keep ${current}`, click: () => answerSuggestion('keep', offer.id) },
          { type: 'separator' as const },
        ];
      })() : []),
      ...(recording && languageMenu ? [{
        label: 'Spoken language',
        submenu: languageMenu.options.map(({ id, label }) => ({
          label, type: 'radio' as const, checked: id === languageMenu?.current, click: () => sendRecordingCommand(`language:${id}`),
        })),
      }] : []),
      { type: 'separator' },
      { label: `Open ${APP_NAME}`, click: showWindow },
      { label: 'Open in browser', click: () => void shell.openExternal(appUrl) },
      ...(update ? [{ type: 'separator' as const }, { label: `Restart to update to ${update}`, click: restartFromTray }] : []),
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
    if (!quitFlow.request()) event.preventDefault();
  });

  app.whenReady().then(async () => {
    // The dashboard needs no camera, location or notifications. Copy buttons need clipboard writes; recording a meeting
    // needs the microphone, for the main window only.
    // Downloads (attachments, ZIPs) always ask where to save, starting in the Downloads folder.
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });
    registerBridge(() => mainWindow, () => appUrl, setRecording, () => recordingCommands.take(), (menu) => {
      languageMenu = menu;
      if (menu) announceSuggestion(menu);
      showRecordingTitle();
      setTrayMenu(pendingUpdate);
    }, { prepare: prepareRunNotice, show: showRunNotice }, { state: pageUpdateState, check: checkNow, restart: installNow, dismiss: dismissUpdate });
    // A restart to update waits for what the npm update waits for (a recording, a transcription, an AI tool run): the
    // server closes admission and checks again, and the recording in this window is read again after that.
    holdUpdatesWhile(async () => {
      if (recording) return whyNotNow(true, null);
      const reason = await prepareServerForRestart();
      if (reason) return reason;
      if (recording) {
        void fetch(new URL('/api/app/update/desktop-restart/cancel', appUrl), { method: 'POST' }).catch(() => undefined);
        return whyNotNow(true, null);
      }
      return null;
    });

    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'media') {
        const media = details as { securityOrigin?: string; mediaTypes?: string[] };
        callback(mayRecord(contents, media.securityOrigin ?? details.requestingUrl, media.mediaTypes ?? [], details.isMainFrame));
        return;
      }
      // The computer's sound comes through a display capture: the handler below decides what it really gets.
      if (permission === 'display-capture') {
        callback(mayRecord(contents, details.requestingUrl, undefined, details.isMainFrame));
        return;
      }
      callback(permission === 'clipboard-sanitized-write');
    });
    // The computer's sound, for a recording the main window starts: its own page as the picture (no screen access is
    // needed for that, and the page stops it at once) and the system's loopback as the sound. Anything else gets nothing.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame;
      const allowed = Boolean(frame && mainWindow && frame === mainWindow.webContents.mainFrame && request.audioRequested
        && classifyLink(request.securityOrigin, new URL(appUrl).origin) === 'app');
      callback(allowed && frame ? { video: frame, audio: 'loopback' } : {});
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (permission !== 'media') return true;
      return (details as { mediaType?: string }).mediaType === 'audio' && mayRecord(contents, origin, undefined, details.isMainFrame);
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
      quitFlow.allow();
      app.quit();
      return;
    }

    createTray();
    startUpdateChecks(onUpdateState, async () => {
      // Electron closes windows before before-quit during an update. Allow that only after the server stops; other
      // quits wait meanwhile.
      await quitFlow.stopForUpdate(async () => { quitting = true; await stopServerProcess(); });
    }, async () => (await serverUpdateStatus())?.auto_check ?? false, afterFailedRestart);
    createWindow();
  });
}
