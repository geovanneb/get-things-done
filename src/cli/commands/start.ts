import { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspacePath, getPort, writeConfig } from '../utils/config';
import { getBundledServerPath, getBundledUiPath } from '../utils/paths';
import {
  clearDaemonState,
  findFreePort,
  getRunningDaemon,
  waitForServer,
  writeDaemonState,
} from '../utils/daemon';

export const startCommand = new Command('start')
  .description('Start the Get Things Done dashboard')
  .option('-p, --port <number>', 'port to listen on')
  .option('--no-open', 'do not open browser automatically')
  .option('-f, --foreground', 'run in the foreground instead of the background')
  .action(async (options: { port?: string; open: boolean; foreground?: boolean }) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      console.error(chalk.red('No workspace configured. Run ') + chalk.bold('gtd init') + chalk.red(' first.'));
      process.exit(1);
    }

    if (!fs.existsSync(workspacePath)) {
      console.error(chalk.red(`Workspace not found: ${workspacePath}`));
      process.exit(1);
    }

    const existing = getRunningDaemon();
    if (existing) {
      console.log(
        chalk.yellow('Server is already running') +
          ` at ${chalk.cyan(`http://localhost:${existing.port}`)} (pid ${existing.pid}).`
      );
      console.log(chalk.dim('Use `gtd stop` to stop it, or `gtd open` to view it.'));
      return;
    }

    const serverPath = getBundledServerPath();
    if (!fs.existsSync(serverPath)) {
      console.error(chalk.red(`Server not found at ${serverPath}. The installation may be incomplete.`));
      process.exit(1);
    }

    // An explicit --port is a hard request; otherwise fall back to config, then the default.
    const requestedPort = options.port ? parseInt(options.port, 10) : getPort();
    if (Number.isNaN(requestedPort)) {
      console.error(chalk.red(`Invalid port: ${options.port}`));
      process.exit(1);
    }

    let port: number;
    try {
      port = await findFreePort(requestedPort);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
      return;
    }

    if (port !== requestedPort) {
      console.log(chalk.yellow(`Port ${requestedPort} is in use, using ${port} instead.`));
    }

    const env = {
      ...process.env,
      ESB_WORKSPACE_PATH: workspacePath,
      ESB_UI_PATH: getBundledUiPath(),
      PORT: String(port),
      NODE_ENV: 'production',
    };

    console.log('');
    console.log(chalk.bold('Get Things Done'));
    console.log('');

    // The Node running this command, not whichever `node` is first on PATH.
    if (options.foreground) {
      const child = spawn(process.execPath, [serverPath], { env, stdio: 'inherit' });
      process.on('SIGINT', () => child.kill('SIGINT'));
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }

    const logDir = path.join(workspacePath, '.situation-board', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'server.log');
    const logFd = fs.openSync(logPath, 'a');

    const spinner = ora('Starting server...').start();

    // Detached with the parent's stdio released, so the server outlives this terminal.
    const child = spawn(process.execPath, [serverPath], {
      env,
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });

    child.on('error', (err) => {
      spinner.fail('Failed to start server');
      console.error(err.message);
      process.exit(1);
    });

    if (!child.pid) {
      spinner.fail('Failed to start server');
      process.exit(1);
      return;
    }

    child.unref();
    fs.closeSync(logFd);

    const ready = await waitForServer(port, child.pid);

    if (!ready) {
      spinner.fail('Server did not start');
      clearDaemonState();
      console.log('');
      console.log(chalk.dim(`Check the log for details: ${logPath}`));
      const tail = readTail(logPath, 15);
      if (tail) {
        console.log('');
        console.log(chalk.dim(tail));
      }
      process.exit(1);
      return;
    }

    writeDaemonState({
      pid: child.pid,
      port,
      workspace: workspacePath,
      startedAt: new Date().toISOString(),
    });
    writeConfig({ port });

    spinner.succeed(`Server running at ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`  Workspace: ${chalk.dim(workspacePath)}`);
    console.log(`  Logs:      ${chalk.dim(logPath)}`);
    console.log('');
    console.log(chalk.dim('Run `gtd stop` to shut it down.'));
    console.log('');

    if (options.open) {
      try {
        const open = (await import('open')).default;
        await open(`http://localhost:${port}`);
      } catch {
        // Opening a browser is best-effort; the URL is printed above.
      }
    }
  });

function readTail(filePath: string, lines: number): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trimEnd();
    if (!content) return '';
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}
