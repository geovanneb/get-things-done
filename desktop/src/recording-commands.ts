// What the menu-bar menu asks the dashboard to do about recording. The recorder runs in the page, so the menu only
// leaves a command and pings the page; the page takes it once. A command left while the page was not ready (the window
// was closed, or still loading) is taken when it is, unless it is old by then: a click from minutes ago must not open
// the record dialog out of nowhere.

export type RecordingCommand = 'open' | 'stop';

/** How long a command waits for the page. */
export const COMMAND_TTL_MS = 30_000;

export class RecordingCommands {
  private pending: { command: RecordingCommand; at: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Leaves `command` for the page; a newer one replaces one not taken yet. */
  leave(command: RecordingCommand): void {
    this.pending = { command, at: this.now() };
  }

  /** The waiting command, once, or null when there is none or it is too old. */
  take(): RecordingCommand | null {
    const pending = this.pending;
    this.pending = null;
    return pending && this.now() - pending.at <= COMMAND_TTL_MS ? pending.command : null;
  }
}
