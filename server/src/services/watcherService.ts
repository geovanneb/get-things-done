import chokidar, { FSWatcher } from 'chokidar';
import { FileWatchEvent } from '../types';

type WatchEventType = 'change' | 'add' | 'unlink';
type EventHandler = (event: FileWatchEvent) => void;

export class WatcherService {
  private watcher: FSWatcher | null = null;
  private handlers: Map<WatchEventType, EventHandler[]> = new Map();
  private ownWrites = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  start(workspacePath: string): void {
    if (this.watcher) {
      this.stop();
    }

    this.watcher = chokidar.watch(`${workspacePath}/**/*.md`, {
      ignored: [
        /node_modules/,
        /\.git/,
        /\.tmp$/,
        `${workspacePath}/.situation-board/cache/**`,
        `${workspacePath}/.situation-board/logs/**`,
      ],
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

// Singleton instance
export const watcherService = new WatcherService();
