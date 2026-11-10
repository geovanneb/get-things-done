import * as fs from 'fs';
import * as path from 'path';
import { watch, FSWatcher } from 'chokidar';
import { FileWatchEvent } from '../types';

type WatchEventType = 'change' | 'add' | 'unlink';
type EventHandler = (event: FileWatchEvent) => void;

/** Paths the watcher never reports. Matches both separators: chokidar passes backslash paths on Windows. */
export const IGNORED_PATH = /node_modules|\.git([\\/]|$)|\.tmp$/;

/**
 * A meeting folder's meeting.json: which version of its text is in use. Reported so that choosing a version in one
 * dashboard shows the new text in another one too. Matches both separators.
 */
export const MEETING_MANIFEST = /[\\/]meetings[\\/][^\\/]+[\\/]meeting\.json$/;
/** An AI tool run's record, written when it starts and when it ends: other dashboards learn a run is going. */
export const RUN_RECORD = /[\\/]\.situation-board[\\/]runs[\\/]CU-\d{4}-\d{4}\.json$/;

/** Distinct watch errors logged per start, so running out of file handles cannot flood the log. */
const MAX_LOGGED_ERRORS = 50;

export class WatcherService {
  private watcher: FSWatcher | null = null;
  private handlers: Map<WatchEventType, EventHandler[]> = new Map();
  private ownWrites = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Watch errors already logged, so a folder that stays unreadable is reported once, not on every rescan. */
  private loggedErrors = new Set<string>();

  start(workspacePath: string): void {
    if (this.watcher) {
      this.stop();
    }

    // chokidar 4+ no longer expands globs, so watch the folder and filter here.
    const skipDirs = [
      path.join(workspacePath, '.situation-board', 'cache'),
      path.join(workspacePath, '.situation-board', 'logs'),
      // Soft deletes and backups: a cleanup run moving many files there must not flood the dashboard.
      path.join(workspacePath, '.situation-board', 'trash'),
    ];
    // Symlinked folders are followed (a folder kept on a shared drive), except a link back to a folder the path already
    // went through: chokidar would crawl that loop a level deeper each time, a copy of the workspace per level.
    const realRoot = realPath(workspacePath) ?? path.resolve(workspacePath);
    const isLinkLoop = (dir: string): boolean => {
      const real = realPath(dir);
      if (real === null) return true; // a loop the system already refuses to resolve, or a broken link
      // No link on the way from the workspace folder: the usual case, and never a loop.
      if (path.relative(realRoot, real) === path.relative(workspacePath, dir)) return false;
      // Only folders reached through a link get here, so the extra lookups stay off the usual path.
      for (let up = path.dirname(dir); up.length >= workspacePath.length; up = path.dirname(up)) {
        if (realPath(up) === real) return true;
        if (path.dirname(up) === up) break;
      }
      return false;
    };
    this.loggedErrors.clear();
    this.watcher = watch(workspacePath, {
      ignored: (filePath, stats) => {
        if (IGNORED_PATH.test(filePath)) return true;
        if (skipDirs.some((dir) => filePath === dir || filePath.startsWith(dir + path.sep))) return true;
        if (stats?.isDirectory() && isLinkLoop(filePath)) return true;
        // Only Markdown files matter, plus the routine, system cleanup and meeting digest run state: a failed run writes no task, and the
        // dashboard must still show it; a meeting's meeting.json; and a run's record. Directories must pass so their contents are watched.
        const routineState = filePath.endsWith(path.join('.situation-board', 'routines', 'state.json'))
          || filePath.endsWith(path.join('.situation-board', 'routines', 'system-cleanup-state.json'))
          || filePath.endsWith(path.join('.situation-board', 'routines', 'meeting-digest-state.json'));
        return Boolean(stats?.isFile()) && !filePath.endsWith('.md') && !routineState && !MEETING_MANIFEST.test(filePath) && !RUN_RECORD.test(filePath);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    const emitEvent = (type: WatchEventType, filePath: string): void => {
      // Skip if this was triggered by our own write
      if (this.ownWrites.has(filePath)) {
        return;
      }

      // Debounce per file
      const existing = this.debounceTimers.get(filePath);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        const event: FileWatchEvent = { type, path: filePath, timestamp: new Date().toISOString() };
        const handlers = this.handlers.get(type) || [];
        for (const handler of handlers) {
          handler(event);
        }
      }, 300);

      this.debounceTimers.set(filePath, timer);
    };

    this.watcher.on('change', (p) => emitEvent('change', p));
    this.watcher.on('add', (p) => emitEvent('add', p));
    this.watcher.on('unlink', (p) => emitEvent('unlink', p));
    // Without a listener, chokidar's 'error' (an unreadable folder, a link loop) is thrown and stops the server.
    // Such a folder is not watched; everything else is.
    this.watcher.on('error', (err) => {
      const { code, path: where } = err as NodeJS.ErrnoException;
      const key = `${code}:${where}`;
      if (this.loggedErrors.has(key) || this.loggedErrors.size > MAX_LOGGED_ERRORS) return;
      this.loggedErrors.add(key);
      if (this.loggedErrors.size > MAX_LOGGED_ERRORS) {
        console.warn('[watcher] More folders cannot be watched; further errors are not logged.');
        return;
      }
      console.warn(`[watcher] ${where ?? 'workspace'}: ${code ?? (err as Error).message}; changes there are not shown live.`);
    });
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
    }
  }

  on(event: WatchEventType, handler: EventHandler): void {
    const existing = this.handlers.get(event) || [];
    this.handlers.set(event, [...existing, handler]);
  }

  off(event: WatchEventType, handler: EventHandler): void {
    const existing = this.handlers.get(event) || [];
    this.handlers.set(event, existing.filter((h) => h !== handler));
  }

  /** Call before writing a file to suppress the resulting watch event */
  markOwnWrite(filePath: string): void {
    this.ownWrites.add(filePath);
    // Auto-clear after 2 seconds
    setTimeout(() => this.ownWrites.delete(filePath), 2000);
  }
}

/** The real path of an existing file or folder, or null when it cannot be resolved (missing, a loop, no access). */
function realPath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// Singleton instance
export const watcherService = new WatcherService();
