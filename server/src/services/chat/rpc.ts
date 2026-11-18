import type { ChildProcess } from 'child_process';
import { isObject, lineReader, parseLine } from './types';

/**
 * Newline-delimited JSON-RPC 2.0 over a child's stdin and stdout: what Codex's app-server and Copilot's ACP server
 * both speak. Requests from the tool to us (approvals, permission questions) go to `onRequest`, whose answer is
 * sent back; notifications go to `onNotification`. A request with no answer within `timeoutMs` fails, and every
 * request still waiting fails when the process ends.
 */
export class RpcConnection {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  stderr = '';

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: {
      onNotification: (method: string, params: Record<string, unknown>) => void;
      onRequest: (method: string, params: Record<string, unknown>) => unknown;
      onExit: () => void;
    },
  ) {
    const reader = lineReader((line) => this.onLine(line));
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (c: string) => reader.push(c));
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (c: string) => { this.stderr = (this.stderr + c).slice(-4096); });
    child.stdin?.on('error', () => { /* reported on exit */ });
    const gone = () => {
      if (this.closed) return;
      this.closed = true;
      reader.flush();
      for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(this.stderr.trim() || 'The assistant stopped unexpectedly.')); }
      this.waiting.clear();
      handlers.onExit();
    };
    child.on('error', gone);
    child.on('exit', () => setTimeout(gone, 300).unref());
    child.on('close', gone);
  }

  get alive(): boolean {
    return !this.closed;
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    try { this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); } catch { /* reported on exit */ }
  }

  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The assistant is not running.'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The assistant did not answer (${method}).`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ method, ...(params ? { params } : {}) });
  }

  private onLine(line: string): void {
    const m = parseLine(line);
    if (!m) return;
    const params = isObject(m['params']) ? m['params'] : {};
    if (typeof m['method'] === 'string') {
      if (m['id'] === undefined || m['id'] === null) { this.handlers.onNotification(m['method'], params); return; }
      let answer: unknown;
      try { answer = this.handlers.onRequest(m['method'], params); } catch { answer = undefined; }
      if (answer === undefined) this.write({ id: m['id'], error: { code: -32601, message: 'Not supported by the dashboard chat' } });
      else this.write({ id: m['id'], result: answer });
      return;
    }
    if (typeof m['id'] !== 'number') return;
    const w = this.waiting.get(m['id']);
    if (!w) return;
    this.waiting.delete(m['id']);
    clearTimeout(w.timer);
    if (isObject(m['error'])) {
      const err = m['error'];
      w.reject(Object.assign(new Error(typeof err['message'] === 'string' ? err['message'] : 'The assistant reported an error.'), { rpcCode: err['code'] }));
    } else {
      w.resolve(m['result']);
    }
  }
}
