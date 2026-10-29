interface ServerChild {
  once(event: 'exit', listener: () => void): unknown;
  kill(): boolean;
  postMessage(message: unknown): void;
}

/** Resolve only on exit, including when graceful shutdown needs a forced kill. */
export function stopServer(child: ServerChild | null, timeoutMs = 7000): Promise<void> {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage({ type: 'shutdown' });
  });
}
