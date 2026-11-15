import { Command } from 'commander';
import {
  checkRecordedDaemon,
  clearDaemonState,
  isProcessAlive,
  readDaemonState,
  unconfirmedDaemonAdvice,
} from '../utils/daemon';

/**
 * How long to wait after SIGTERM before SIGKILL. The server gives itself 10 s to close cleanly
 * (SHUTDOWN_TIMEOUT_MS in server/src/server.ts) and then exits on its own; waiting longer than that keeps
 * a slow but healthy shutdown from being cut off. A test checks the two stay in this order.
 */
export const GRACE_PERIOD_MS = 12_000;
const POLL_INTERVAL_MS = 200;

export const stopCommand = new Command('stop')
  .description('Stop the Get Things Done dashboard')
  .action(async () => {
    const chalk = (await import('chalk')).default;

    const state = readDaemonState();
    if (!state) {
      console.log(chalk.yellow('No running server found.'));
      return;
    }

    // Signal only our dashboard: a leftover PID file can name someone else's process.
    const check = await checkRecordedDaemon(state);
    if (check === 'stale') {
      clearDaemonState();
      console.log(chalk.yellow('Server was not running (stale PID file removed).'));
      return;
    }
    if (check === 'unknown') {
      const [headline, ...advice] = unconfirmedDaemonAdvice(state);
      console.log(chalk.yellow(`${headline} It was not stopped.`));
      for (const line of advice) console.log(chalk.dim(line));
      process.exitCode = 1;
      return;
    }

    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      clearDaemonState();
      console.log(chalk.yellow('Server was not running (stale PID file removed).'));
      return;
    }

    // Give it a chance to shut down cleanly before forcing the issue.
    const deadline = Date.now() + GRACE_PERIOD_MS;
    while (Date.now() < deadline) {
      if (!isProcessAlive(state.pid)) {
        clearDaemonState();
        console.log(chalk.green('✓') + ' Server stopped.');
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    try {
      process.kill(state.pid, 'SIGKILL');
      console.log(chalk.yellow('✓') + ' Server did not exit cleanly and was force-stopped.');
    } catch {
      console.log(chalk.green('✓') + ' Server stopped.');
    }
    clearDaemonState();
  });
