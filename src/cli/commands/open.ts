import { Command } from 'commander';
import { getPort } from '../utils/config';
import { getRunningDaemon } from '../utils/daemon';

export const openCommand = new Command('open')
  .description('Open the dashboard in your browser')
  .action(async () => {
    const chalk = (await import('chalk')).default;

    // Prefer the port the server actually bound, which may differ from the
    // requested one if that port was busy.
    const daemon = getRunningDaemon();
    const port = daemon?.port ?? getPort();

    if (!daemon) {
      console.log(chalk.yellow('The dashboard does not appear to be running.'));
      console.log(chalk.dim('Run `gtd start` first. Trying anyway...'));
    }

    const url = `http://localhost:${port}`;
    const openLib = await import('open');
    await openLib.default(url);
    console.log(`Opening ${url}`);
  });
