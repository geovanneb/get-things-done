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

test('Windows copy commands keep shell syntax and Unicode out of the calling shell', () => {
  const workspace = "C:\\Fictional 'notes' $(echo text) & 100% 会議 🚚";
  for (const program of ['claude', 'codex', 'copilot', 'code'] as const) {
    const command = assistantCommand(workspace, program, true);
    assert.match(command, /^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le');
    assert.equal(
      script,
      `Set-Location -LiteralPath 'C:\\Fictional ''notes'' $(echo text) & 100% 会議 🚚' -ErrorAction Stop; ${program === 'code' ? 'code .' : program}`,
    );
  }
});
