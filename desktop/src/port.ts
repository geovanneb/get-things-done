import * as net from 'net';

/** Default first try. Same as `gtd start`, so the dashboard keeps its saved preferences (they are stored per port). */
export const DEFAULT_PORT = 3001;
const ATTEMPTS = 20;

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** The preferred port if it is free, otherwise the next free one after it. */
export async function findFreePort(preferred: number = DEFAULT_PORT): Promise<number> {
  const start = Number.isInteger(preferred) && preferred > 0 && preferred < 65536 ? preferred : DEFAULT_PORT;
  const end = Math.min(start + ATTEMPTS, 65536);
  for (let port = start; port < end; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port between ${start} and ${end - 1}.`);
}
