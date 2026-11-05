/** Keep update policy independent of Electron so shutdown ordering can be regression-tested. */
export function updatesEnabled(packaged: boolean, signedRelease: unknown, disabled: string | undefined): boolean {
  return packaged && signedRelease === true && disabled !== '1';
}

export function createUpdateInstaller(prepare: () => Promise<void>, install: () => void, report: (error: unknown) => void): (() => Promise<void>) & { reset: () => void } {
  let pending: Promise<void> | undefined;
  const restart = () => {
    pending ??= Promise.resolve().then(prepare).then(install).catch((error) => {
      pending = undefined;
      report(error);
    });
    return pending;
  };
  // quitAndInstall can return successfully and emit an error later. That event must release the handoff too.
  return Object.assign(restart, { reset: () => { pending = undefined; } });
}

/** checkForUpdates resolves before its separate background download promise. Consume both failures. */
export async function checkForUpdate(check: () => Promise<{ downloadPromise?: Promise<unknown> | null } | null>, report: (error: unknown) => void): Promise<void> {
  try {
    const result = await check();
    await result?.downloadPromise;
  } catch (error) {
    report(error);
  }
}

/** Where the desktop app's own update is, as the page and the tray show it (#284). */
export interface DesktopUpdateState {
  /** `off`: this build does not update itself; `ready`: downloaded, waiting for a restart. */
  phase: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  /** The version found, downloading or ready. */
  version: string | null;
  /** Download progress, 0 to 100, while downloading. */
  percent: number | null;
  error: string | null;
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'none' }
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  /** Restart to update did not go ahead after all: still ready, with why. */
  | { type: 'restart-failed'; message: string };

const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?$/;

/** One line, without control characters, at most 200 characters: an updater's error is shown as it is. */
function cleanError(message: string): string {
  return message.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'The update check failed';
}

/**
 * The next state after an updater event. A downloaded update stays ready until the restart: a later check, a check
 * finding nothing or a failed check never hides it.
 */
export function nextUpdateState(state: DesktopUpdateState, event: UpdateEvent): DesktopUpdateState {
  if (state.phase === 'off') return state;
  const ready = state.phase === 'ready';
  switch (event.type) {
    case 'checking': return ready ? state : { ...state, phase: 'checking', error: null };
    case 'none': return ready ? state : { phase: 'idle', version: null, percent: null, error: null };
    case 'available': return ready || !VERSION.test(event.version) ? state : { phase: 'downloading', version: event.version, percent: 0, error: null };
    case 'progress': return state.phase !== 'downloading' ? state : { ...state, percent: Math.max(0, Math.min(100, Math.round(event.percent))) };
    case 'downloaded': return VERSION.test(event.version) ? { phase: 'ready', version: event.version, percent: null, error: null } : state;
    case 'error': return ready ? state : { ...state, phase: 'error', percent: null, error: cleanError(event.message) };
    case 'restart-failed': return ready ? { ...state, error: cleanError(event.message) } : state;
  }
}

/**
 * Why the app should not restart (or quit) now, or null: a recording in the window, or what the dashboard's server
 * says is running (a recording from any page, a transcription or an AI tool run), as the npm update checks it.
 * `serverBusy` is null when nothing runs, undefined when the server could not be asked: a restart to update is then
 * refused (`mustKnow`), a quit is not.
 */
export function whyNotNow(recording: boolean, serverBusy: string | null | undefined, mustKnow = false): string | null {
  if (recording) return 'A meeting is being recorded';
  if (serverBusy === undefined) return mustKnow ? 'What runs could not be checked; try again in a moment' : null;
  return serverBusy;
}

/**
 * The app's quit, one attempt at a time (#284): `request` is called from before-quit and says whether that quit may go
 * through now. Otherwise it was held, and either started an attempt (confirm, stop the server, then quit) or joined the
 * one going. No quit goes through while the server stops, for a quit or for an update's restart.
 */
export function createQuitFlow(steps: { confirm: () => Promise<boolean>; stop: () => Promise<void>; quit: () => void }) {
  let attempt = false;
  let stopping = false;
  let allowed = false;
  return {
    request(): boolean {
      if (allowed) return true;
      if (attempt || stopping) return false;
      attempt = true;
      void (async () => {
        try {
          if (!(await steps.confirm())) return;
          stopping = true;
          // A server that fails to stop still lets the app quit, as before.
          await steps.stop().catch(() => undefined);
          allowed = true;
          steps.quit();
        } finally {
          attempt = false;
        }
      })();
      return false;
    },
    /** The update's restart stops the server itself: other quits wait, then the installer's quit goes through. */
    async stopForUpdate(stop: () => Promise<void>): Promise<void> {
      stopping = true;
      await stop();
      allowed = true;
    },
    /** Quit at once, with nothing to stop (the app could not start). */
    allow(): void {
      allowed = true;
    },
    /** A restart to update that did not go ahead: quitting is asked again next time. */
    reset(): void {
      stopping = false;
      allowed = false;
    },
  };
}
