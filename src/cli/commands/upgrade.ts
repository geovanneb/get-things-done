import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspacePath } from '../utils/config';
import { getRunningDaemon } from '../utils/daemon';
import { isExistingWorkspace, upgradeWorkspace, type AiTool, type WorkspaceProfile } from '../utils/workspace';

const AI_TOOLS: AiTool[] = ['claude-code', 'copilot', 'codex'];

/**
 * Reads identity fields out of the executive profile frontmatter so template
 * placeholders interpolate to the same values `gtd init` used.
 */
function readProfile(workspacePath: string): WorkspaceProfile {
  const profile: WorkspaceProfile = { name: '', role: '', organization: '' };
  const profilePath = path.join(workspacePath, 'profile', 'executive-profile.md');

  if (!fs.existsSync(profilePath)) return profile;

  const raw = fs.readFileSync(profilePath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return profile;

  for (const line of (match[1] ?? '').split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1] as string;
    const value = (kv[2] ?? '').trim().replace(/^["']|["']$/g, '');
    if (key === 'name' || key === 'role' || key === 'organization') {
      profile[key] = value;
    }
  }
  return profile;
}

/** Only refresh integrations the workspace already has, so upgrade never adds new ones. */
function detectAiTools(workspacePath: string): AiTool[] {
  const markers: Record<AiTool, string> = {
    'claude-code': '.claude',
    copilot: path.join('.github', 'copilot-instructions.md'),
    codex: 'AGENTS.md',
  };

  const found = AI_TOOLS.filter((tool) => fs.existsSync(path.join(workspacePath, markers[tool])));
  return found.length > 0 ? found : ['claude-code'];
}

export const upgradeCommand = new Command('upgrade')
  .description('Refresh app-provided files in your workspace after updating the package')
  .option('-d, --dir <path>', 'workspace to upgrade (defaults to the configured one)')
  .action(async (options: { dir?: string }) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    const workspacePath = options.dir ? path.resolve(options.dir) : getWorkspacePath();

    if (!workspacePath) {
      console.error(chalk.red('No workspace configured. Run ') + chalk.bold('gtd init') + chalk.red(' first.'));
      process.exit(1);
      return;
    }

    if (!fs.existsSync(workspacePath) || !isExistingWorkspace(workspacePath)) {
      console.error(chalk.red(`Not a Get Things Done workspace: ${workspacePath}`));
      process.exit(1);
      return;
    }

    if (getRunningDaemon()) {
      console.log(chalk.yellow('The dashboard is running.'));
      console.log(chalk.dim('Run `gtd stop` first so it picks up the refreshed files.'));
      console.log('');
    }

    const spinner = ora('Refreshing app-provided files...').start();

    let result;
    try {
      result = upgradeWorkspace(workspacePath, {
        profile: readProfile(workspacePath),
        aiTools: detectAiTools(workspacePath),
      });
    } catch (err) {
      spinner.fail('Upgrade failed');
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }

    spinner.succeed('Workspace up to date');

    console.log('');
    console.log(`  Workspace: ${chalk.dim(workspacePath)}`);
    console.log(
      `  Version:   ${result.fromVersion ?? 'unknown'} ${chalk.dim('->')} ${result.toVersion}`
    );
    console.log('');

    const report = (label: string, files: string[], color: (s: string) => string) => {
      if (files.length === 0) return;
      console.log(color(`  ${label} (${files.length})`));
      for (const file of files) console.log(`    ${file}`);
      console.log('');
    };

    report('Added', result.added, chalk.green);
    report('Updated', result.updated, chalk.cyan);

    if (result.conflicted.length > 0) {
      console.log(chalk.yellow(`  Kept your version (${result.conflicted.length})`));
      for (const file of result.conflicted) {
        console.log(`    ${file} ${chalk.dim(`-> new version saved as ${file}.new`)}`);
      }
      console.log('');
      console.log(chalk.dim('  These files differ from what the app installed, so your edits were kept.'));
      console.log(chalk.dim('  Compare each against its .new file and merge anything you want.'));
      console.log('');
    }

    if (result.added.length === 0 && result.updated.length === 0 && result.conflicted.length === 0) {
      console.log(chalk.dim('  Nothing to change.'));
      console.log('');
    }
  });
