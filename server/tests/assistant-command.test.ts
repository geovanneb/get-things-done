import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assistantCommand } from '../src/utils/assistantCommand';

const exec = promisify(execFile);

test(
  'copied commands treat shell syntax in workspace names as literal text',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-command-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "Fictional $(touch injected) `echo text` 'quoted' & notes");
    await fs.mkdir(workspace);
    for (const program of ['claude', 'codex', 'copilot', 'code'] as const) {
      // A shell function stands in for the CLI: no assistant, account or network is involved.
      const stub = program === 'code' ? 'code() { printf "%s" "$1"; }; ' : `${program}() { pwd -P; }; `;
      const result = await exec('/bin/sh', ['-c', stub + assistantCommand(workspace, program)], { cwd: root });
      assert.equal(result.stdout.trimEnd(), program === 'code' ? workspace : await fs.realpath(workspace));
      await assert.rejects(fs.stat(path.join(root, 'injected')), { code: 'ENOENT' });
    }
  },
);

test(
  'a command that starts with a request hands it over as literal arguments',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-command-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "Fictional $(touch injected) 'quoted'");
    await fs.mkdir(workspace);
    for (const [program, args] of [['claude', ['/gtd-task TASK-2026-0001']], ['codex', ['Execute task TASK-2026-0001']], ['copilot', ['-i', 'Execute task TASK-2026-0001']]] as const) {
      // The stub prints its arguments, one per line, in place of the CLI.
      const stub = `${program}() { printf '%s\\n' "$@"; }; `;
      const result = await exec('/bin/sh', ['-c', stub + assistantCommand(workspace, program, false, args.at(-1))], { cwd: root });
      assert.deepEqual(result.stdout.trimEnd().split('\n'), [...args]);
    }
    await assert.rejects(fs.stat(path.join(root, 'injected')), { code: 'ENOENT' });
  },
);

test('the Windows command starts with the request as one more single-quoted string', () => {
  const script = decoded(assistantCommand("C:\\Fictional ’notes", 'copilot', true, 'Execute task TASK-2026-0001'));
  assert.equal(script, "Set-Location -LiteralPath 'C:\\Fictional ’’notes' -ErrorAction Stop; copilot '-i' 'Execute task TASK-2026-0001'");
  assert.equal(decoded(assistantCommand('C:\\Fictional', 'code', true, 'Execute task TASK-2026-0001')), "Set-Location -LiteralPath 'C:\\Fictional' -ErrorAction Stop; code .", 'VS Code takes no request');
});

/** The Windows command as v0.17.0 made it, which doubled only ASCII apostrophes. */
function v017Command(workspace: string, program: string): string {
  const script = `Set-Location -LiteralPath '${workspace.replace(/'/g, "''")}' -ErrorAction Stop; ${program === 'code' ? 'code .' : program}`;
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

const PROGRAMS = ['claude', 'codex', 'copilot', 'code'] as const;
const QUOTES = ["'", '\u2018', '\u2019', '\u201a', '\u201b'];
/**
 * The script's UTF-16 code units as encoded in the command. For well-formed text this is the script PowerShell runs;
 * PowerShell's decoder replaces an unpaired surrogate, which Node's keeps, so that case is checked for bytes only.
 */
const decoded = (command: string) => Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le');

/**
 * The single-quoted string the way PowerShell's tokenizer reads it (ScanStringLiteral): a single quote of any kind
 * followed by another one is a literal (the second); one followed by anything else ends the string.
 */
function readSingleQuoted(script: string, start: number): { value: string; end: number } {
  assert.ok(QUOTES.includes(script[start]!), 'a single-quoted string starts here');
  let value = '';
  for (let i = start + 1; i < script.length; i++) {
    const c = script[i]!;
    if (QUOTES.includes(c)) {
      if (!QUOTES.includes(script[i + 1] ?? '')) return { value, end: i };
      i++;
      value += script[i];
      continue;
    }
    value += c;
  }
  assert.fail('the string is never closed');
}

test('Windows copy commands keep every workspace name inside one PowerShell string', () => {
  const names = [
    'C:\\Fictional $(echo text) & 100% 会議 🚚',
    'C:\\Fictional `echo text` $env:PATH ${x} @(1) "double"',
    'D:\\Проект λ 📁 𝒳 notes',
    'C:\\',
    "C:\\Fictional 'notes' $(echo text)",
    'C:\\Team\u2019s notes',
    'C:\\Team\u2018s notes\u201a and \u201b more',
    "C:\\a'b\u2019c'\u2019; Remove-Item x; '",
    "C:\\ends with quotes '\u2018\u2019\u201a\u201b",
    "C:\\mixed pair '\u2019 and \u2018' ''",
  ];
  for (const workspace of names) {
    for (const program of PROGRAMS) {
      const command = assistantCommand(workspace, program, true);
      assert.match(command, /^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/);
      const script = decoded(command);
      const prefix = 'Set-Location -LiteralPath ';
      assert.ok(script.startsWith(prefix), script);
      const { value, end } = readSingleQuoted(script, prefix.length);
      // The string holds the path exactly, and the script goes on as fixed text right after it.
      assert.equal(value, workspace);
      assert.equal(script.slice(end + 1), ` -ErrorAction Stop; ${program === 'code' ? 'code .' : program}`);
      // One character more than the path for each single quote in it, nothing else.
      const quotes = [...workspace].filter((c) => QUOTES.includes(c)).length;
      assert.equal(script.length, `${prefix}'' -ErrorAction Stop; ${program === 'code' ? 'code .' : program}`.length + workspace.length + quotes);
    }
  }
});

test('each kind of single quote is doubled with itself', () => {
  for (const quote of QUOTES) {
    const script = decoded(assistantCommand(`C:\\a${quote}b`, 'claude', true));
    assert.equal(script, `Set-Location -LiteralPath 'C:\\a${quote}${quote}b' -ErrorAction Stop; claude`);
  }
});

test('Windows commands are v0.17.0\'s for quote-free paths, and each typographic quote adds one UTF-16 unit', () => {
  // Without a typographic quote, the very same command as v0.17.0 (which already doubled ASCII apostrophes).
  for (const workspace of ['C:\\Plain notes', "C:\\Team's notes", 'D:\\Проект 📁']) {
    for (const program of PROGRAMS) assert.equal(assistantCommand(workspace, program, true), v017Command(workspace, program));
  }
  // A lone surrogate: the same encoded bytes as v0.17.0. Only byte compatibility is claimed; what PowerShell's
  // decoder makes of the unit (a replacement character) is unchanged by this fix.
  for (const program of PROGRAMS) {
    assert.equal(assistantCommand("C:\\lone \ud800 surrogate's", program, true), v017Command("C:\\lone \ud800 surrogate's", program));
  }
  // The review's long paths: a drive and six or twelve folders of 199 letters.
  const long = (folders: number) => 'C:' + Array.from({ length: folders }, (_, i) => '\\' + String.fromCharCode(97 + (i % 26)).repeat(199)).join('');
  assert.equal(long(6).length, 1202);
  assert.equal(assistantCommand(long(6), 'code', true).length, 3390);
  const straight = long(12).slice(0, -1) + "'";
  assert.equal(assistantCommand(straight, 'code', true).length, 6590);
  assert.equal(assistantCommand(straight, 'code', true), v017Command(straight, 'code'));
  // A curly apostrophe adds one UTF-16 unit to the script: base64 grows by at most 4 characters, as for a straight one.
  const curly = long(12).slice(0, -1) + '\u2019';
  assert.ok(assistantCommand(curly, 'code', true).length <= v017Command(long(12), 'code').length + 4);
  for (const program of PROGRAMS) assert.ok(assistantCommand(curly, program, true).length < 8191, program);
});
