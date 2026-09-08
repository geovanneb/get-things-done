import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ESB_PID_FILE } from './paths';

export interface DaemonState {
  pid: number;
  port: number;
  workspace: string;
  startedAt: string;
}

export function readDaemonState(): DaemonState | null {
  if (!fs.existsSync(ESB_PID_FILE)) return null;

  const raw = fs.readFileSync(ESB_PID_FILE, 'utf-8').trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as DaemonState;
    if (typeof parsed.pid === 'number') return parsed;
  } catch {
    // Older versions stored a bare PID.
    const pid = parseInt(raw, 10);
    if (!Number.isNaN(pid)) {
      return { pid, port: 3001, workspace: '', startedAt: '' };
    }
  }
  return null;
}

export function writeDaemonState(state: DaemonState): void {
  fs.mkdirSync(path.dirname(ESB_PID_FILE), { recursive: true });
  fs.writeFileSync(ESB_PID_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function clearDaemonState(): void {
  if (fs.existsSync(ESB_PID_FILE)) fs.unlinkSync(ESB_PID_FILE);
}

/** Signal 0 tests for existence without delivering anything. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Returns the running daemon, clearing the PID file if the process is gone.
 * Guards against a recycled PID pointing at an unrelated process.
 */
export function getRunningDaemon(): DaemonState | null {
  const state = readDaemonState();
  if (!state) return null;

  if (!isProcessAlive(state.pid)) {
    clearDaemonState();
    return null;
  }
  return state;
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** Finds the first free port at or after `start`, so a busy port does not kill the server. */
export async function findFreePort(start: number, attempts = 20): Promise<number> {
  for (let port = start; port < start + attempts; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found between ${start} and ${start + attempts - 1}.`);
}

function probeHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Polls /health until the server answers, the process dies, or we run out of time. */
export async function waitForServer(
  port: number,
  pid: number,
  timeoutMs = 20000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await probeHealth(port)) return true;
    if (!isProcessAlive(pid)) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function isServerResponding(port: number): Promise<boolean> {
  return probeHealth(port);
}
