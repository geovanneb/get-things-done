import { Command } from 'commander';
import * as fs from 'fs';
import { getWorkspacePath } from '../utils/config';
import { getRunningDaemon, isServerResponding } from '../utils/daemon';
import { getAppVersion } from '../utils/workspace';

export const statusCommand = new Command('status')
  .description('Show whether the dashboard is running, and where')
  .action(async () => {
    const chalk = (await import('chalk')).default;

    const workspacePath = getWorkspacePath();
    const daemon = getRunningDaemon();

    console.log('');
    console.log(chalk.bold('Get Things Done'));
    console.log('');

    let version = 'unknown';
    try {
      version = getAppVersion();
    } catch {
      // The scaffolder is unavailable in a broken install; not fatal for status.
    }
    console.log(`  Version:   ${version}`);

    if (!workspacePath) {
      console.log(`  Workspace: ${chalk.yellow('not configured')} — run ${chalk.bold('gtd init')}`);
    } else if (!fs.existsSync(workspacePath)) {
      console.log(`  Workspace: ${chalk.red(workspacePath)} ${chalk.red('(missing)')}`);
    } else {
      console.log(`  Workspace: ${workspacePath}`);
    }

    if (!daemon) {
      console.log(`  Server:    ${chalk.yellow('stopped')}`);
      console.log('');
      console.log(chalk.dim('Run `gtd start` to launch the dashboard.'));
      console.log('');
      return;
    }

    const responding = await isServerResponding(daemon.port);
    const health = responding ? chalk.green('running') : chalk.yellow('running but not responding');

    console.log(`  Server:    ${health}`);
    console.log(`  URL:       ${chalk.cyan(`http://localhost:${daemon.port}`)}`);
    console.log(`  PID:       ${daemon.pid}`);
    if (daemon.startedAt) console.log(`  Started:   ${daemon.startedAt}`);
    console.log('');
  });
