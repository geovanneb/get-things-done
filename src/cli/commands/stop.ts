import { Command } from 'commander';
import {
  clearDaemonState,
  isProcessAlive,
  readDaemonState,
} from '../utils/daemon';

const GRACE_PERIOD_MS = 5000;
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

    if (!isProcessAlive(state.pid)) {
      clearDaemonState();
      console.log(chalk.yellow('Server was not running (stale PID file removed).'));
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
