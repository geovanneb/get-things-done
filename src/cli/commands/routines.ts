import { Command } from 'commander';
import * as fs from 'fs';
import { getWorkspacePath } from '../utils/config';
import { getBundledRoutineServicePath } from '../utils/paths';

/**
 * `gtd routines`: the same routine engine the dashboard runs, without the dashboard.
 * `gtd routines run` is safe to call from a system scheduler as often as you like: it only acts
 * on runs that came due since the last check, and a lock keeps it from overlapping the server.
 */

interface RoutineRun {
  routine_id: string;
  routine_title: string;
  status: 'ok' | 'error';
  created: string[];
  message: string;
}

interface RoutineView {
  id: string;
  title: string;
  enabled: boolean;
  summary: string;
  next_run_at: string | null;
  state: { last_run_at?: string; last_status?: string; last_message?: string };
  problem?: string;
}

interface RoutineServiceModule {
  RoutineService: new () => {
    runDue(trigger: 'cli' | 'scheduler'): Promise<RoutineRun[]>;
    list(): Promise<RoutineView[]>;
  };
}

/** The engine lives in the server tree; the CLI loads its compiled output, like the scaffolder. */
function loadService(): InstanceType<RoutineServiceModule['RoutineService']> {
  const modulePath = getBundledRoutineServicePath();
  let mod: RoutineServiceModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(modulePath) as RoutineServiceModule;
  } catch (err) {
    throw new Error(`Could not load the routine engine from ${modulePath}. The installation may be incomplete.\n${(err as Error).message}`, { cause: err });
  }
  return new mod.RoutineService();
}

function requireWorkspace(): string {
  const workspacePath = getWorkspacePath();
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    throw new Error('No workspace configured. Run `gtd init` first.');
  }
  // The engine reads the workspace from the environment, like the server started by `gtd start`.
  process.env['ESB_WORKSPACE_PATH'] = workspacePath;
  return workspacePath;
}

const runCommand = new Command('run')
  .description('Create the tasks of every routine that came due, including runs missed while the computer was off')
  .option('-q, --quiet', 'print nothing when there is nothing to do')
  .option('--scheduler', 'mark the run as started by the system scheduler (shown in the run history)')
  .action(async (options: { quiet?: boolean; scheduler?: boolean }) => {
    const chalk = (await import('chalk')).default;
    requireWorkspace();
    const runs = await loadService().runDue(options.scheduler ? 'scheduler' : 'cli');
    if (runs.length === 0) {
      if (!options.quiet) console.log(chalk.dim('No routine is due.'));
      return;
    }
    for (const run of runs) {
      const mark = run.status === 'ok' ? chalk.green('✓') : chalk.red('✗');
      console.log(`${mark} ${run.routine_id} ${run.routine_title}: ${run.message}`);
    }
    if (runs.some((r) => r.status === 'error')) process.exitCode = 1;
  });

const listCommand = new Command('list')
  .description('Show your routines and when they run next')
  .action(async () => {
    const chalk = (await import('chalk')).default;
    requireWorkspace();
    const routines = await loadService().list();
    if (routines.length === 0) {
      console.log(chalk.dim('No routines yet. Create one under Routines in the dashboard.'));
      return;
    }
    console.log('');
    for (const r of routines) {
      if (r.problem) {
        console.log(`${chalk.red('!')} ${r.id}  ${chalk.red(r.problem)}`);
        continue;
      }
      const status = r.enabled ? chalk.green('on    ') : chalk.yellow('paused');
      const next = r.next_run_at ? new Date(r.next_run_at).toLocaleString() : '-';
      console.log(`${status} ${chalk.bold(r.id)}  ${r.title}`);
      console.log(chalk.dim(`         ${r.summary}. Next: ${next}`));
      if (r.state.last_status === 'error') console.log(chalk.red(`         Last run failed: ${r.state.last_message ?? ''}`));
    }
    console.log('');
  });

export const routinesCommand = new Command('routines')
  .description('Recurring tasks: run what is due, or list routines')
  .addCommand(runCommand)
  .addCommand(listCommand);
