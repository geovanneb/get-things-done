import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
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
    const parsed: unknown = JSON.parse(raw);
    // Older versions wrote a bare positive PID, which is itself valid JSON.
    if (validPid(parsed)) return { pid: parsed, port: 3001, workspace: '', startedAt: '' };
    if (parsed && typeof parsed === 'object') {
      const state = parsed as Partial<DaemonState>;
      if (validPid(state.pid) && validPort(state.port)
        && typeof state.workspace === 'string' && typeof state.startedAt === 'string') return state as DaemonState;
    }
  } catch { /* malformed state is never a process identity */ }
  return null;
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
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
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Slack for clock adjustments when comparing the recorded start with the last boot. */
const BOOT_MARGIN_MS = 60_000;

/** The PID reported by a successful, bounded health response; undefined if identity cannot be confirmed. */
function healthPid(port: number, timeoutMs = 2000): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (pid?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(pid);
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      if (res.statusCode !== 200) { finish(); return; }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 16 * 1024) finish();
      });
      res.on('error', () => finish());
      res.on('end', () => {
        try {
          const health = JSON.parse(body) as { status?: unknown; pid?: unknown } | null;
          finish(health?.status === 'ok' && validPid(health.pid) ? health.pid : undefined);
        } catch {
          finish();
        }
      });
    });
    // A socket inactivity timeout alone never expires when an unrelated server keeps sending bytes.
    const deadline = setTimeout(() => finish(), timeoutMs);
    req.on('error', () => finish());
  });
}

/**
 * Whether the recorded process is our dashboard. A live PID is not enough: after a crash or a reboot a leftover
 * PID file can name an unrelated process. 'stale' only when we know it is not ours (gone, started before the last
 * boot, or the dashboard on its port is another process); 'unknown' when nothing answers, e.g. a hung dashboard.
 */
export async function checkRecordedDaemon(state: DaemonState): Promise<'ours' | 'stale' | 'unknown'> {
  if (!validPid(state.pid) || !validPort(state.port) || !isProcessAlive(state.pid)) return 'stale';
  const startedAt = Date.parse(state.startedAt);
  if (startedAt < Date.now() - os.uptime() * 1000 - BOOT_MARGIN_MS) return 'stale';
  const pid = await healthPid(state.port);
  // A legacy or unrelated service saying only 'ok' cannot prove which process owns the listener.
  if (pid == null) return 'unknown';
  return pid === state.pid ? 'ours' : 'stale';
}

/**
 * The recorded daemon and whether it is confirmed as ours, clearing the PID file if the process is gone.
 * Guards against a recycled PID pointing at an unrelated process.
 */
export async function findRecordedDaemon(): Promise<{ state: DaemonState; check: 'ours' | 'unknown' } | null> {
  const state = readDaemonState();
  if (!state) return null;

  const check = await checkRecordedDaemon(state);
  if (check === 'stale') {
    clearDaemonState();
    return null;
  }
  return { state, check };
}

/** Returns the running daemon (confirmed or not), clearing the PID file if the process is gone. */
export async function getRunningDaemon(): Promise<DaemonState | null> {
  return (await findRecordedDaemon())?.state ?? null;
}

/**
 * What the user can do when the recorded process could not be confirmed as the dashboard: the CLI does not signal
 * it, because it may be another program that now has this process ID.
 */
export function unconfirmedDaemonAdvice(state: DaemonState): string[] {
  const windows = process.platform === 'win32';
  const show = windows ? `tasklist /FI "PID eq ${state.pid}" /V` : `ps -p ${state.pid} -o command=`;
  const stop = windows
    ? `\`taskkill /PID ${state.pid} /F\``
    : `\`kill ${state.pid}\` (\`kill -9 ${state.pid}\` if it does not exit)`;
  return [
    `Process ${state.pid} could not be confirmed as the dashboard: port ${state.port} did not confirm its process identity.`,
    'It may be an older dashboard, a dashboard that is not responding, or another program that now has this process ID.',
    `To see which program it is: \`${show}\`.`,
    `If it is the dashboard, stop it yourself: ${stop}.`,
    `If it is another program, leave it running and delete ${ESB_PID_FILE}.`,
  ];
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
