import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { openCommand } from './commands/open';
import { useCommand } from './commands/use';
import { statusCommand } from './commands/status';
import { upgradeCommand } from './commands/upgrade';
import { routinesCommand } from './commands/routines';
import { migrateLegacyConfig } from './utils/paths';

function readVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../..', 'package.json');
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version);
  } catch {
    return '0.0.0';
  }
}

migrateLegacyConfig();

const program = new Command();

program
  .name('gtd')
  .description('Get Things Done — a local GTD workspace for executives')
  .version(readVersion());

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(openCommand);
program.addCommand(statusCommand);
program.addCommand(upgradeCommand);
program.addCommand(useCommand);
program.addCommand(routinesCommand);

// @inquirer/prompts throws ExitPromptError on Ctrl+C or when stdin closes.
// Exit quietly instead of printing a stack trace at the user.
function isPromptAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError');
}

process.on('uncaughtException', (err) => {
  if (isPromptAbort(err)) {
    console.log('\nCancelled.');
    process.exit(130);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  if (isPromptAbort(err)) {
    console.log('\nCancelled.');
    process.exit(130);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

program.parse();
