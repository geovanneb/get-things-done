import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AiTool } from './scaffold';

export interface AiToolInfo {
  id: AiTool;
  label: string;
  /** One plain sentence for people who have not heard of the tool. */
  description: string;
  installed: boolean;
  install_url: string;
}

interface ToolDefinition {
  id: AiTool;
  label: string;
  description: string;
  install_url: string;
  /** Program names to look for. Copilot counts as present with its CLI or with VS Code. */
  commands: string[];
  /** App folders that also count, for tools that are not always on PATH. */
  apps?: string[];
}

const TOOLS: ToolDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: "Anthropic's assistant. It reads your workspace and works on tasks for you.",
    install_url: 'https://claude.com/product/claude-code',
    commands: ['claude'],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    description: 'GitHub\'s assistant, used in VS Code or on the command line.',
    install_url: 'https://github.com/features/copilot',
    commands: ['copilot', 'code'],
    apps: ['/Applications/Visual Studio Code.app'],
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    description: "OpenAI's assistant for the command line.",
    install_url: 'https://github.com/openai/codex',
    commands: ['codex'],
  },
];

/**
 * Folders where these tools usually install. Apps opened from the Dock or Start menu often get a short PATH
 * without them, so they are searched too.
 */
function extraDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'bin'),
  ];
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (appData) dirs.push(path.join(appData, 'npm'));
    if (localAppData) dirs.push(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }
  return dirs;
}

function searchDirs(): string[] {
  const fromPath = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extraDirs()])];
}

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasCommand(command: string, dirs: string[]): boolean {
  // Windows finds programs by extension (claude.cmd, code.cmd, codex.exe); file names are not case-sensitive there.
  const names = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((ext) => command + ext)
    : [command];
  return dirs.some((dir) => names.some((name) => isExecutable(path.join(dir, name))));
}

/**
 * Which assistants are on this computer. Only looks for the program files; nothing is run.
 * `dirs` and `appExists` are for tests; by default PATH, the usual install folders and the real app folders are used.
 */
export function detectAiTools(dirs: string[] = searchDirs(), appExists: (app: string) => boolean = fs.existsSync): AiToolInfo[] {
  return TOOLS.map(({ commands, apps, ...info }) => ({
    ...info,
    installed: commands.some((command) => hasCommand(command, dirs)) || (apps ?? []).some(appExists),
  }));
}
