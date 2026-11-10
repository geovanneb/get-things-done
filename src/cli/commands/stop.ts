import { Command } from 'commander';
import {
  checkRecordedDaemon,
  clearDaemonState,
  isProcessAlive,
  readDaemonState,
} from '../utils/daemon';
import { ESB_PID_FILE } from '../utils/paths';

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

    // Signal only our dashboard: a leftover PID file can name someone else's process.
    const check = await checkRecordedDaemon(state);
    if (check === 'stale') {
      clearDaemonState();
      console.log(chalk.yellow('Server was not running (stale PID file removed).'));
      return;
    }
    if (check === 'unknown') {
      console.log(chalk.yellow(`Process ${state.pid} could not be confirmed as the dashboard: nothing answers on port ${state.port}.`));
      console.log(chalk.dim(`If it is the dashboard, stop that process yourself. If it is not, delete ${ESB_PID_FILE}.`));
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
