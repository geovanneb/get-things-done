/**
 * Sends recorded audio to the server, one block at a time, and keeps what is not stored yet. Nothing here touches the
 * browser's audio or the network directly, so every failure can be tested. `saved` only grows when the server says
 * so: the page shows it next to what was captured, because only saved audio survives a crash of the page.
 */

/** 16 kHz, 16-bit, mono. */
export const BYTES_PER_SECOND = 32_000;
/** Half a megabyte: under the server's limit for a block, and quick to send after an outage. */
const MAX_BLOCK = 512 * 1024;
/** What may wait in memory while the server cannot be reached: 30 minutes. After that, recording stops visibly. */
const MAX_BACKLOG = 30 * 60 * BYTES_PER_SECOND;

/** The server's answer: stored up to `offset`; try again later; or a refusal, with where it stands if it knows. */
export type SendResult = { ok: true; offset: number } | { ok: false; retry: true } | { ok: false; retry: false; message: string; offset?: number };

export interface UploaderOptions {
  send: (offset: number, block: Uint8Array) => Promise<SendResult>;
  sleep?: (ms: number) => Promise<void>;
  onChange?: () => void;
  maxBacklog?: number;
  maxBlock?: number;
}

export class RecordingUploader {
  /** Bytes the server confirmed. */
  saved = 0;
  /** Bytes handed over by the microphone. */
  captured = 0;
  /** Why recording cannot go on; what was saved stays on the server. */
  failed: string | null = null;
  private waiting: Uint8Array[] = [];
  private backlog = 0;
  private running: Promise<void> | null = null;
  private cancelled = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxBacklog: number;
  private readonly maxBlock: number;

  constructor(private readonly options: UploaderOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxBacklog = options.maxBacklog ?? MAX_BACKLOG;
    this.maxBlock = options.maxBlock ?? MAX_BLOCK;
  }

  /** Bytes captured and not stored yet. */
  get unsaved(): number {
    return this.backlog;
  }

  add(bytes: Uint8Array): void {
    if (this.failed || this.cancelled) return;
    if (this.backlog + bytes.length > this.maxBacklog) {
      this.fail('The server could not be reached for too long, so recording stopped. What was saved is kept.');
      return;
    }
    this.waiting.push(bytes);
    this.backlog += bytes.length;
    this.captured += bytes.length;
    this.options.onChange?.();
  }

  /** Sends what is waiting; resolves when nothing is left or it failed. Safe to call any time. */
  flush(): Promise<void> {
    this.running ??= this.pump().finally(() => { this.running = null; });
    return this.running;
  }

  private fail(message: string): void {
    this.failed = message;
    this.waiting = [];
    this.backlog = 0;
    this.options.onChange?.();
  }

  /** Stops for good: nothing more is sent, also not by a send waiting to retry. */
  cancel(): void {
    this.cancelled = true;
    this.waiting = [];
    this.backlog = 0;
  }

  /** The next bytes to send, without taking them off the queue: they go only once they are stored. */
  private peek(): Uint8Array {
    const size = Math.min(this.backlog, this.maxBlock);
    const block = new Uint8Array(size);
    let at = 0;
    for (const chunk of this.waiting) {
      if (at === size) break;
      const part = chunk.subarray(0, size - at);
      block.set(part, at);
      at += part.length;
    }
    return block;
  }

  private drop(count: number): void {
    this.backlog -= count;
    while (count > 0) {
      const first = this.waiting[0]!;
      if (first.length <= count) { count -= first.length; this.waiting.shift(); } else { this.waiting[0] = first.subarray(count); count = 0; }
    }
  }

  private async pump(): Promise<void> {
    for (let attempt = 0; this.backlog > 0 && !this.failed && !this.cancelled;) {
      let result: SendResult;
      try {
        result = await this.options.send(this.saved, this.peek());
      } catch {
        result = { ok: false, retry: true };
      }
      // It ended while this send was out: the queue is gone, but what the server stored still counts.
      if (this.failed || this.cancelled) {
        if (result.ok) this.saved = Math.max(this.saved, result.offset);
        this.options.onChange?.();
        return;
      }
      if (result.ok || (!result.retry && result.offset !== undefined && result.offset > this.saved && result.offset <= this.saved + this.backlog)) {
        // Stored, or stored already by a try whose reply never came: those bytes are done.
        const stored = (result as { offset: number }).offset - this.saved;
        this.drop(stored);
        this.saved += stored;
        attempt = 0;
        this.options.onChange?.();
      } else if (result.retry) {
        await this.sleep(Math.min(30_000, 1000 * 2 ** attempt));
        attempt++;
      } else {
        this.fail(result.message);
      }
    }
  }
}
