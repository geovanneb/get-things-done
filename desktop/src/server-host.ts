// Runs in an Electron utility process: the same server as `gtd start`, started through startServer().
// Messages with the main process: { type: 'ready', url } or { type: 'failed', message } out, { type: 'shutdown' } in.
import * as fs from 'fs';
import * as path from 'path';

// The parts of server/src/server.ts used here. The server is loaded from its build output at runtime.
interface StartServerOptions {
  port: number;
  uiPath?: string;
  templatesPath?: string;
  git?: { binary: string; env?: Record<string, string> };
}
interface RunningServer {
  url: string;
  close(): Promise<void>;
}

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;

const root = process.env['GTD_APP_ROOT'] ?? path.resolve(__dirname, '..', '..');
const port = Number(process.env['GTD_PORT']);

/** The portable git shipped with the app (dugite), so git works on computers without it. Falls back to PATH. */
function bundledGit(): StartServerOptions['git'] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so a broken copy only disables it
    const { setupEnvironment } = require('dugite') as typeof import('dugite');
    const { env, gitLocation } = setupEnvironment({}, {});
    if (!fs.existsSync(gitLocation)) return undefined;
    const vars = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    return { binary: gitLocation, env: vars };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the path is only known at runtime
  const { startServer } = require(path.join(root, 'server', 'dist', 'server.js')) as {
    startServer(options: StartServerOptions): Promise<RunningServer>;
  };

  let running: RunningServer;
  try {
    running = await startServer({
      port,
      uiPath: path.join(root, 'ui', 'dist'),
      templatesPath: path.join(root, 'templates'),
      git: bundledGit(),
    });
  } catch (err) {
    parentPort.postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
    return;
  }

  parentPort.on('message', (event) => {
    if ((event.data as { type?: string })?.type !== 'shutdown') return;
    // A stuck watcher or open connection must not keep the app from quitting.
    setTimeout(() => process.exit(0), 5000).unref();
    running.close().finally(() => process.exit(0));
  });

  parentPort.postMessage({ type: 'ready', url: running.url });
}

void main();
