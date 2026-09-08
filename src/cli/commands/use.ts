import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { writeConfig } from '../utils/config';

export const useCommand = new Command('use')
  .description('Point Get Things Done at an existing workspace')
  .argument('<path>', 'path to the workspace directory')
  .action(async (workspacePath: string) => {
    const chalk = (await import('chalk')).default;

    const resolved = path.resolve(workspacePath);

    if (!fs.existsSync(resolved)) {
      console.error(chalk.red(`Directory not found: ${resolved}`));
      process.exit(1);
    }

    writeConfig({ workspace_path: resolved });
    console.log(chalk.green('✓') + ` Workspace set to: ${chalk.cyan(resolved)}`);
    console.log('');
    console.log('Run ' + chalk.bold('gtd start') + ' to launch the dashboard.');
  });
