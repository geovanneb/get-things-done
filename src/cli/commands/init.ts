import { Command } from 'commander';
import { input, checkbox, confirm } from '@inquirer/prompts';
import * as path from 'path';
import * as fs from 'fs';
import { writeConfig } from '../utils/config';
import { isExistingWorkspace, scaffoldWorkspace, type AiTool } from '../utils/workspace';

interface InitOptions {
  dir?: string;
  yes?: boolean;
  name?: string;
  role?: string;
  org?: string;
  workspaceName?: string;
  ai?: string;
}

export const initCommand = new Command('init')
  .description('Initialize a new executive workspace in the current directory')
  .option('-d, --dir <path>', 'target directory (defaults to current directory)')
  .option('-y, --yes', 'accept defaults and skip all prompts')
  .option('--name <name>', 'your name')
  .option('--role <role>', 'your role or title')
  .option('--org <organization>', 'your organization')
  .option('--workspace-name <name>', 'name for the workspace')
  .option('--ai <tools>', 'comma-separated AI tools: claude-code,copilot,codex')
  .action(async (options: InitOptions) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    console.log('');
    console.log(chalk.bold('Get Things Done'));
    console.log(chalk.dim('─'.repeat(40)));
    console.log('');

    const targetDir = path.resolve(options.dir || process.cwd());

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const alreadyInitialized = isExistingWorkspace(targetDir);
    const nonInteractive = Boolean(options.yes) || !process.stdin.isTTY;

    if (alreadyInitialized) {
      const proceed = nonInteractive
        ? true
        : await confirm({
            message: `A workspace already exists at ${targetDir}. Use it as-is and just update the config?`,
            default: true,
          });
      if (!proceed) {
        console.log(chalk.yellow('Aborted.'));
        process.exit(0);
      }
      writeConfig({ workspace_path: targetDir });
      console.log('');
      console.log(chalk.green('✓') + ` Workspace configured: ${chalk.cyan(targetDir)}`);
      console.log('');
      console.log('Run ' + chalk.bold('gtd start') + ' to launch the dashboard.');
      console.log('');
      return;
    }

    if (!nonInteractive) {
      console.log(chalk.dim('Answer a few questions to set up your workspace.\n'));
    }

    const workspaceName = options.workspaceName
      ?? (nonInteractive
        ? 'Executive Workspace'
        : await input({ message: 'Workspace name:', default: 'Executive Workspace' }));

    const executiveName = options.name
      ?? (nonInteractive ? '' : await input({ message: 'Your name:' }));

    const role = options.role
      ?? (nonInteractive ? '' : await input({ message: 'Your role/title:' }));

    const organization = options.org
      ?? (nonInteractive ? '' : await input({ message: 'Organization:' }));

    if (!nonInteractive) console.log('');

    const aiTools = options.ai
      ? parseAiTools(options.ai)
      : nonInteractive
      ? (['claude-code'] as AiTool[])
      : await checkbox<AiTool>({
      message: 'Select AI tools to configure (space to select, enter to confirm):',
      choices: [
        {
          name: 'Claude Code  — slash commands, agents, skills',
          value: 'claude-code',
          checked: true,
        },
        {
          name: 'GitHub Copilot  — copilot-instructions.md',
          value: 'copilot',
          checked: false,
        },
        {
          name: 'OpenAI Codex  — AGENTS.md',
          value: 'codex',
          checked: false,
        },
      ],
    });

    console.log('');

    const profile = { name: executiveName, role, organization };

    const spinner = ora('Setting up workspace structure...').start();

    try {
      scaffoldWorkspace(targetDir, { profile, workspaceName, aiTools });

      spinner.succeed('Workspace structure created');

      for (const tool of aiTools) {
        console.log(`${chalk.green('\u2713')} ${toolLabel(tool)} configured`);
      }

      writeConfig({ workspace_path: targetDir });

      console.log('');
      console.log(chalk.green.bold('Your workspace is ready.'));
      console.log('');
      console.log(`  Location: ${chalk.cyan(targetDir)}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  ${chalk.bold('gtd start')}   — launch the dashboard`);
      console.log(`  ${chalk.bold('gtd open')}    — open it in the browser`);
      console.log('');
    } catch (err) {
      spinner.fail('Setup failed');
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const VALID_AI_TOOLS: AiTool[] = ['claude-code', 'copilot', 'codex'];

function parseAiTools(raw: string): AiTool[] {
  const requested = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const unknown = requested.filter((t) => !VALID_AI_TOOLS.includes(t as AiTool));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown AI tool(s): ${unknown.join(', ')}. Valid options: ${VALID_AI_TOOLS.join(', ')}`
    );
  }
  return requested as AiTool[];
}

function toolLabel(tool: AiTool): string {
  switch (tool) {
    case 'claude-code': return 'Claude Code';
    case 'copilot': return 'GitHub Copilot';
    case 'codex': return 'OpenAI Codex';
  }
}
