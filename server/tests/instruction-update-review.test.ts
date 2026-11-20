import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { APP_FILES_RELATIVE_PATH, MANIFEST_RELATIVE_PATH, readManifest, scaffoldWorkspace, upgradeWorkspace, type AiTool } from '../src/services/scaffold';
import { acknowledgeInstructionUpdate, compareInstructionUpdate, listInstructionUpdates, replaceSteps, useAppVersion } from '../src/services/instructionUpdates';
import { recoverInstructionReplace, recoverySteps, REPLACE_JOURNAL_RELATIVE_PATH } from '../src/services/instructionReplace';
import { refreshWorkspace } from '../src/services/workspaceRefresh';

/**
 * Settings → Instruction updates with the shipped text kept: what a release changed (from the version the user last
 * had), "Keep my version" and "Use the app's version". Each test ships its own copy of the templates, so a "release"
 * is a change to that copy.
 */

const profile = { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' };
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const status = (code: number) => (err: Error & { statusCode?: number }) => err.statusCode === code;
const repoTemplates = path.resolve(__dirname, '..', '..', 'templates');

type T = { after: (fn: () => Promise<void>) => void };

/** A workspace (with a Unicode name) set up from its own copy of the templates. */
async function setup(t: T, aiTools: AiTool[] = ['codex']) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-review-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const templates = path.join(root, 'templates');
  await fsp.cp(repoTemplates, templates, { recursive: true });
  process.env['ESB_TEMPLATES_PATH'] = templates;
  t.after(async () => { delete process.env['ESB_TEMPLATES_PATH']; replaceSteps.after = null; recoverySteps.after = null; });
  const dir = path.join(root, 'Workspace Ünïcødé 工作');
  await fsp.mkdir(dir);
  const opts = { profile, aiTools };
  scaffoldWorkspace(dir, opts);
  const template = path.join(templates, 'ai', 'codex', 'AGENTS.md');
  const file = path.join(dir, 'AGENTS.md');
  return {
    dir, file, templates, opts,
    /** A new release of AGENTS.md: the template changed, then the workspace upgraded. */
    async release(change: (text: string) => string) {
      await fsp.writeFile(template, change(await fsp.readFile(template, 'utf8')));
      return upgradeWorkspace(dir, opts);
    },
    entry: (rel = 'AGENTS.md') => readManifest(dir)!.files.find((f) => f.path === rel)!,
    stored: () => fsp.readdir(path.join(dir, APP_FILES_RELATIVE_PATH)),
  };
}

/** The user's own rule in AGENTS.md, and a release that adds the app's rule: a conflict with a known base. */
async function customisedThenReleased(t: T) {
  const ws = await setup(t);
  const v1 = await fsp.readFile(ws.file, 'utf8');
  await fsp.writeFile(ws.file, `${v1}\nMy own rule.\n`);
  const result = await ws.release((text) => `${text}\nA new app rule.\n`);
  assert.ok(result.conflicted.includes('AGENTS.md'));
  return { ...ws, v1 };
}

test('install keeps the exact shipped text of each file, with a base pointer to it', async (t) => {
  const { dir, entry, stored } = await setup(t);
  const agents = entry();
  assert.equal(agents.base_sha256, agents.sha256);
  assert.deepEqual(await fsp.readFile(path.join(dir, APP_FILES_RELATIVE_PATH, agents.sha256)), await fsp.readFile(path.join(dir, 'AGENTS.md')));
  // One copy per distinct version, and nothing else.
  const versions = new Set(readManifest(dir)!.files.flatMap((f) => [f.sha256, f.base_sha256]));
  assert.deepEqual(new Set(await stored()), versions);
});

test('compare shows what the app changed since the version the user had, and a skipped release keeps that base', async (t) => {
  const { dir, file, v1, entry, release } = await customisedThenReleased(t);

  assert.equal(entry().base_sha256, sha(v1), 'an unresolved update keeps the old base');
  // The release itself is kept too, though the base did not move to it.
  assert.equal(sha(await fsp.readFile(path.join(dir, APP_FILES_RELATIVE_PATH, entry().sha256))), entry().sha256);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.equal(c.release, 'changed');
  assert.equal(c.base, v1);
  assert.equal(c.base_sha256, sha(v1));
  assert.match(c.app, /A new app rule\./);
  assert.match(c.mine, /My own rule\./);
  assert.ok(!c.base!.includes('A new app rule.'));

  // Another release while the first is still open: the comparison is still from what the user had.
  await release((text) => `${text}\nAnother app rule.\n`);
  const again = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.equal(again.base, v1);
  assert.match(again.app, /A new app rule\.[\s\S]*Another app rule\./);
  assert.match(await fsp.readFile(file, 'utf8'), /My own rule\./);
});

test('kept copies stay bounded: only bases and current versions; anything else there is left alone', async (t) => {
  const { dir, templates, opts, stored } = await setup(t);
  const schema = path.join(templates, 'workspace', 'README.md');
  await fsp.writeFile(path.join(dir, APP_FILES_RELATIVE_PATH, 'notes.txt'), 'not the app\'s');
  const orphan = sha('an orphan');
  await fsp.writeFile(path.join(dir, APP_FILES_RELATIVE_PATH, orphan), 'an orphan');
  const before = readManifest(dir)!.files.find((f) => f.path === 'README.md')!.sha256;
  await fsp.writeFile(schema, `${await fsp.readFile(schema, 'utf8')}\nRelease two.\n`);
  const result = upgradeWorkspace(dir, opts);
  assert.ok(result.updated.includes('README.md'), 'an untouched file is updated');
  const readme = readManifest(dir)!.files.find((f) => f.path === 'README.md')!;
  assert.equal(readme.base_sha256, readme.sha256, 'and its base follows');
  const names = await stored();
  assert.ok(!names.includes(before), 'the version nothing points to is removed');
  assert.ok(!names.includes(orphan));
  assert.ok(names.includes('notes.txt'), 'a file not named like a kept version is never removed');
  const versions = new Set(readManifest(dir)!.files.flatMap((f) => [f.sha256, f.base_sha256]));
  assert.deepEqual(new Set(names.filter((n) => n !== 'notes.txt')), versions);
});

test('an older manifest has no base: none is guessed, today\'s comparison is shown, and Keep my version sets one', async (t) => {
  const ws = await setup(t);
  const { dir, file } = ws;
  const v1 = await fsp.readFile(file, 'utf8');
  // As an app before this one left it: no base pointers, no kept copies.
  const manifest = readManifest(dir)!;
  for (const f of manifest.files) delete f.base_sha256;
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
  await fsp.rm(path.join(dir, APP_FILES_RELATIVE_PATH), { recursive: true });
  await fsp.writeFile(file, `${v1}\nMy own rule.\n`);
  await ws.release((text) => `${text}\nA new app rule.\n`);
  assert.equal(ws.entry().base_sha256, undefined, 'a conflicted file without a base gets none');

  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.deepEqual([c.release, c.base, c.base_sha256], ['unknown', null, null]);

  // Keep my version: acknowledged, and this release becomes the base.
  const [row] = await listInstructionUpdates(dir);
  assert.deepEqual(await acknowledgeInstructionUpdate(dir, row), []);
  assert.equal(ws.entry().base_sha256, row!.app_sha256);
  assert.equal(ws.entry().merged_sha256, row!.app_sha256);
  assert.match(await fsp.readFile(file, 'utf8'), /My own rule\./, 'the user\'s file is never written');

  // The next release is compared from the release the user kept: only its own change shows.
  const kept = await fsp.readFile(path.join(dir, APP_FILES_RELATIVE_PATH, row!.app_sha256), 'utf8');
  await ws.release((text) => `${text}\nThe third release's rule.\n`);
  const next = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.equal(next.release, 'changed');
  assert.equal(next.base, kept);
  assert.equal(next.app, `${kept}\nThe third release's rule.\n`);
});

test('a damaged kept copy is never shown as the base; an app version equal to the base says the app did not change it', async (t) => {
  const { dir, file, v1 } = await customisedThenReleased(t);
  await fsp.writeFile(path.join(dir, APP_FILES_RELATIVE_PATH, sha(v1)), 'tampered');
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.deepEqual([c.release, c.base], ['unknown', null]);

  // The user edits a file the app has not changed since: the differences are all theirs.
  const ws2 = await setup(t);
  const text = await fsp.readFile(ws2.file, 'utf8');
  await fsp.writeFile(ws2.file, `${text}\nMine only.\n`);
  upgradeWorkspace(ws2.dir, ws2.opts);
  const same = await compareInstructionUpdate(ws2.dir, 'AGENTS.md');
  assert.deepEqual([same.release, same.base, same.base_sha256], ['unchanged', null, same.app_sha256]);
  assert.match(await fsp.readFile(file, 'utf8'), /My own rule\./);
});

test('Use the app\'s version replaces the file, keeps a byte-exact restorable backup, and acknowledges', async (t) => {
  const { dir, file, entry, opts } = await customisedThenReleased(t);
  // A user's file with Windows line endings and non-ASCII text, kept byte for byte.
  const mine = Buffer.from('# Mine\r\nMy own rule — ✓ 規則.\r\n', 'utf8');
  await fsp.writeFile(file, mine);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.equal(c.mine, mine.toString('utf8'), 'CRLF reaches the comparison as it is');
  const { updates, backup } = await useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace });
  assert.deepEqual(updates, []);
  assert.equal(await fsp.readFile(file, 'utf8'), c.app);
  await assert.rejects(fsp.access(`${file}.new`), 'the app\'s .new is removed');
  assert.match(backup, /^\.situation-board\/trash\/.+-AGENTS\.md$/);
  assert.deepEqual(await fsp.readFile(path.join(dir, backup)), mine, 'the backup is the user\'s file, byte for byte');
  assert.equal(entry().merged_sha256, c.app_sha256);
  assert.equal(entry().base_sha256, c.app_sha256);
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  const leftovers = [...await fsp.readdir(dir), ...await fsp.readdir(path.join(dir, '.situation-board'))].filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);

  // Restoring the backup brings the user's file back exactly. This release stays resolved: the next one shows again.
  await fsp.copyFile(path.join(dir, backup), file);
  assert.deepEqual(await fsp.readFile(file), mine);
  assert.deepEqual(await listInstructionUpdates(dir), []);
  assert.ok(upgradeWorkspace(dir, opts).merged.includes('AGENTS.md'), 'kept as the user\'s file, no .new');
  assert.deepEqual(await fsp.readFile(file), mine);
});

test('a preview that is no longer true is refused: the file, the app version or the .new changed since', async (t) => {
  const ws = await customisedThenReleased(t);
  const { dir, file } = ws;
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  const preview = { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace };
  const mine = await fsp.readFile(file);

  await fsp.writeFile(file, `${mine}\nEdited after the preview.\n`);
  await assert.rejects(useAppVersion(dir, preview), status(409));
  assert.match(await fsp.readFile(file, 'utf8'), /Edited after the preview\./);
  await fsp.writeFile(file, mine);

  await assert.rejects(useAppVersion(dir, { ...preview, state: 'no_copy' }), status(409), 'the .new is not what was previewed');
  await ws.release((text) => `${text}\nChanged after the preview.\n`);
  await assert.rejects(useAppVersion(dir, preview), status(409), 'the app version is not what was previewed');
  assert.deepEqual(await fsp.readFile(file), mine, 'nothing replaced');
  assert.deepEqual(await fsp.readdir(path.join(dir, '.situation-board', 'trash')), [], 'and nothing backed up');
});

test('links are never followed: a linked file is not offered, a linked .new is refused', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const { dir, file } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-review-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'AGENTS.md');
  await fsp.copyFile(file, target);
  await fsp.rm(file);
  await fsp.symlink(target, file);
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), status(404));
  assert.ok((await fsp.lstat(file)).isSymbolicLink());
  assert.equal(sha(await fsp.readFile(target)), c.mine_sha256, 'the link\'s target is untouched');

  await fsp.rm(file);
  await fsp.copyFile(target, file);
  await fsp.rm(`${file}.new`);
  await fsp.symlink(path.join(outside, 'AGENTS.md'), `${file}.new`);
  const [row] = await listInstructionUpdates(dir);
  assert.equal(row!.state, 'edited');
  await assert.rejects(useAppVersion(dir, { ...row, state: 'edited', workspace: dir }), status(409));
  assert.equal(sha(await fsp.readFile(file)), c.mine_sha256);
});

test('refused while an agent is working', async (t) => {
  const { dir, file } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  await fsp.mkdir(path.join(dir, '.situation-board', 'runs'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.situation-board', 'runs', 'CU-2026-0001.json'), JSON.stringify({ status: 'running', pid: process.pid }));
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), status(409));
  assert.equal(sha(await fsp.readFile(file)), c.mine_sha256);
});

test('a permission file gets the comparison and Keep my version, and the server refuses to replace it', async (t) => {
  const ws = await setup(t, ['claude-code']);
  const rel = path.join('.claude', 'settings.json');
  const settings = path.join(ws.dir, rel);
  const json = JSON.parse(await fsp.readFile(settings, 'utf8')) as { permissions?: { deny?: string[] } };
  json.permissions = { ...json.permissions, deny: [...(json.permissions?.deny ?? []), 'Bash(my-own-rule:*)'] };
  await fsp.writeFile(settings, JSON.stringify(json, null, 2));
  const template = path.join(ws.templates, 'ai', 'claude-code', '.claude', 'settings.json');
  await fsp.writeFile(template, `${(await fsp.readFile(template, 'utf8')).trimEnd()}\n\n`);
  upgradeWorkspace(ws.dir, ws.opts);

  const [row] = await listInstructionUpdates(ws.dir);
  assert.equal(row!.path, rel);
  assert.equal(row!.permission_file, true);
  const c = await compareInstructionUpdate(ws.dir, rel);
  assert.equal(c.release, 'changed');
  await assert.rejects(useAppVersion(ws.dir, { path: rel, mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), status(403));
  assert.match(await fsp.readFile(settings, 'utf8'), /my-own-rule/);
  assert.deepEqual(await acknowledgeInstructionUpdate(ws.dir, row), []);
  assert.match(await fsp.readFile(settings, 'utf8'), /my-own-rule/);
  assert.equal(ws.entry(rel).base_sha256, row!.app_sha256);
});

test('a replace interrupted after the file was written is finished on the next start', async (t) => {
  const { dir, file, entry } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  replaceSteps.after = (step) => { if (step === 'replaced') throw new Error('interrupted'); };
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), /interrupted/);
  replaceSteps.after = null;
  // Written, not yet acknowledged: the journal says so.
  assert.equal(await fsp.readFile(file, 'utf8'), c.app);
  await fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH));
  await fsp.access(`${file}.new`);
  assert.equal(entry().merged_sha256, undefined);

  assert.equal((await refreshWorkspace(dir)).status, 'done');
  assert.equal(entry().merged_sha256, c.app_sha256);
  assert.equal(entry().base_sha256, c.app_sha256);
  await assert.rejects(fsp.access(`${file}.new`), 'the app\'s .new is removed');
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  assert.deepEqual(await listInstructionUpdates(dir), []);
  const trash = await fsp.readdir(path.join(dir, '.situation-board', 'trash'));
  assert.equal(trash.length, 1);
  assert.equal(sha(await fsp.readFile(path.join(dir, '.situation-board', 'trash', trash[0]!))), c.mine_sha256, 'the backup is there');
});

test('a replace interrupted before the file was written leaves it as it was, and can be done again', async (t) => {
  const { dir, file } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  const preview = { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace };
  replaceSteps.after = (step) => { if (step === 'backup') throw new Error('interrupted'); };
  await assert.rejects(useAppVersion(dir, preview), /interrupted/);
  replaceSteps.after = null;
  assert.equal(sha(await fsp.readFile(file)), c.mine_sha256, 'the user\'s file is untouched');
  assert.deepEqual((await listInstructionUpdates(dir)).map((u) => u.state), ['ready'], 'still waiting');

  const { backup } = await useAppVersion(dir, preview);
  assert.equal(await fsp.readFile(file, 'utf8'), c.app);
  assert.equal(sha(await fsp.readFile(path.join(dir, backup))), c.mine_sha256);
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  const staged = (await fsp.readdir(path.join(dir, '.situation-board'))).filter((n) => n.startsWith('.instruction-backup-'));
  assert.deepEqual(staged, []);
});

test('an app file with Windows line endings is kept, compared and written byte for byte', async (t) => {
  const ws = await setup(t);
  const { dir, file } = ws;
  // A release whose template uses CRLF: the kept copy and the written file keep every \r.
  const v1 = await fsp.readFile(file, 'utf8');
  await fsp.writeFile(file, `${v1}\nMy own rule.\n`);
  await ws.release((text) => text.replace(/\n/g, '\r\n'));
  const crlf = (await compareInstructionUpdate(dir, 'AGENTS.md'));
  assert.ok(crlf.app.includes('\r\n'));
  const [row] = await listInstructionUpdates(dir);
  await acknowledgeInstructionUpdate(dir, row);
  const kept = await fsp.readFile(path.join(dir, APP_FILES_RELATIVE_PATH, row!.app_sha256));
  assert.equal(sha(kept), row!.app_sha256);
  assert.ok(kept.includes('\r\n'));

  await ws.release((text) => `${text}A CRLF release rule.\r\n`);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.equal(c.base, kept.toString('utf8'));
  await useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace });
  assert.equal(sha(await fsp.readFile(file)), c.app_sha256);
});

test('a file of the app\'s name that the app never installed here is compared but never replaced', async (t) => {
  // Set up for Claude Code only: AGENTS.md is the user's own file, not in the manifest.
  const ws = await setup(t, ['claude-code']);
  await fsp.writeFile(ws.file, '# My own agents file\n');
  assert.equal(readManifest(ws.dir)!.files.some((f) => f.path === 'AGENTS.md'), false);
  const row = (await listInstructionUpdates(ws.dir)).find((u) => u.path === 'AGENTS.md')!;
  assert.equal(row.installed, false);
  // Neither resolution is offered for it: Keep is refused too, until a restart brings the files up to date.
  await assert.rejects(acknowledgeInstructionUpdate(ws.dir, row), status(409));
  const c = await compareInstructionUpdate(ws.dir, 'AGENTS.md');
  await assert.rejects(useAppVersion(ws.dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), status(409));
  assert.equal(await fsp.readFile(ws.file, 'utf8'), '# My own agents file\n');
  assert.deepEqual(await fsp.readdir(path.join(ws.dir, '.situation-board', 'trash')), [], 'no backup made');
  await assert.rejects(fsp.access(path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH)));
});

test('a preview from one workspace is refused in another, before anything is written', async (t) => {
  const alpha = await customisedThenReleased(t);
  const beta = path.join(path.dirname(alpha.dir), 'Beta');
  await fsp.cp(alpha.dir, beta, { recursive: true });
  const c = await compareInstructionUpdate(alpha.dir, 'AGENTS.md');
  const preview = { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state };
  const elsewhere = (err: Error & { statusCode?: number; details?: { code?: string } }) => err.statusCode === 409 && err.details?.code === 'other_workspace';
  await assert.rejects(useAppVersion(beta, { ...preview, workspace: alpha.dir }), elsewhere);
  await assert.rejects(useAppVersion(beta, preview), elsewhere, 'a replace must say which workspace it was previewed in');
  await assert.rejects(acknowledgeInstructionUpdate(beta, { ...preview, workspace: alpha.dir }), elsewhere);
  // Keep from the list, without opening the comparison: bound to the workspace the list came from, and never unbound.
  const [listed] = await listInstructionUpdates(alpha.dir);
  assert.equal(listed!.workspace, alpha.dir);
  await assert.rejects(acknowledgeInstructionUpdate(beta, listed), elsewhere);
  await assert.rejects(acknowledgeInstructionUpdate(beta, { ...listed, workspace: undefined }), elsewhere);
  // A page loaded before the update sends no workspace: it is told to reload.
  await assert.rejects(acknowledgeInstructionUpdate(alpha.dir, { ...listed, workspace: undefined }), /Reload the page/);
  await fsp.access(path.join(beta, 'AGENTS.md.new'));
  assert.equal(readManifest(beta)!.files.find((f) => f.path === 'AGENTS.md')!.merged_sha256, undefined);
  assert.equal(sha(await fsp.readFile(path.join(beta, 'AGENTS.md'))), c.mine_sha256);
  assert.deepEqual(await fsp.readdir(path.join(beta, '.situation-board', 'trash')), []);
  assert.equal(sha(await fsp.readFile(alpha.file)), c.mine_sha256);
});

test('a .new edited or an app version changed while the replace runs is caught right before it, and the update stays', async (t) => {
  const ws = await customisedThenReleased(t);
  const { dir, file } = ws;
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  const preview = { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace };
  replaceSteps.after = async (step) => { if (step === 'staged') await fsp.writeFile(`${file}.new`, `${c.app}\nHalf merged.\n`); };
  await assert.rejects(useAppVersion(dir, preview), status(409));
  replaceSteps.after = null;
  assert.equal(sha(await fsp.readFile(file)), c.mine_sha256, 'the user\'s file is not replaced');
  assert.match(await fsp.readFile(`${file}.new`, 'utf8'), /Half merged\./);
  assert.deepEqual((await listInstructionUpdates(dir)).map((u) => u.state), ['edited'], 'still waiting');
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  assert.equal(ws.entry().merged_sha256, undefined);

  // The app version changes (a profile edit, an update on disk) between the preview checks and the replace.
  await fsp.writeFile(`${file}.new`, c.app);
  const again = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.equal(again.state, 'ready');
  const template = path.join(ws.templates, 'ai', 'codex', 'AGENTS.md');
  replaceSteps.after = async (step) => { if (step === 'staged') await fsp.appendFile(template, '\nChanged meanwhile.\n'); };
  await assert.rejects(useAppVersion(dir, { ...preview, state: again.state }), status(409));
  replaceSteps.after = null;
  assert.equal(sha(await fsp.readFile(file)), c.mine_sha256);
});

test('Keep my version is refused, and nothing is settled, when the release\'s text cannot be kept', async (t) => {
  const { dir, file, entry } = await customisedThenReleased(t);
  const [row] = await listInstructionUpdates(dir);
  const blob = path.join(dir, APP_FILES_RELATIVE_PATH, row!.app_sha256);
  await fsp.rm(blob);
  await fsp.mkdir(blob);
  await assert.rejects(acknowledgeInstructionUpdate(dir, row), status(500));
  assert.equal(entry().merged_sha256, undefined);
  assert.notEqual(entry().base_sha256, row!.app_sha256);
  await fsp.access(`${file}.new`);
  assert.deepEqual((await listInstructionUpdates(dir)).map((u) => u.state), ['ready']);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), status(500));
  assert.equal(sha(await fsp.readFile(file)), c.mine_sha256, 'nothing replaced');
});

test('a replace interrupted after the file was written is finished even when the user edited the file since', async (t) => {
  const { dir, file, entry } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  replaceSteps.after = (step) => { if (step === 'replaced') throw new Error('interrupted'); };
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), /interrupted/);
  replaceSteps.after = null;
  const edited = `${c.app}\nA local rule added before the restart.\n`;
  await fsp.writeFile(file, edited);

  await refreshWorkspace(dir);
  assert.equal(await fsp.readFile(file, 'utf8'), edited, 'the user\'s edit is kept');
  assert.equal(entry().merged_sha256, c.app_sha256);
  assert.equal(entry().base_sha256, c.app_sha256);
  await assert.rejects(fsp.access(`${file}.new`));
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  assert.deepEqual(await listInstructionUpdates(dir), [], 'the applied release is not offered again');
});

test('an app version too large to preview is never applied', async (t) => {
  const ws = await setup(t);
  const { dir, file } = ws;
  await fsp.writeFile(file, '# Short and mine\n');
  await ws.release((text) => `${text}\n${'x'.repeat(600 * 1024)}\n`);
  await assert.rejects(compareInstructionUpdate(dir, 'AGENTS.md'), status(413));
  const [row] = await listInstructionUpdates(dir);
  await assert.rejects(useAppVersion(dir, { ...row, workspace: dir }), status(413));
  assert.equal(await fsp.readFile(file, 'utf8'), '# Short and mine\n');
  assert.deepEqual(await fsp.readdir(path.join(dir, '.situation-board', 'trash')), []);
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
});

test('recovery never removes a .new through a linked folder', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const ws = await setup(t, ['claude-code']);
  const rel = path.join('.claude', 'commands', 'gtd-task.md');
  const file = path.join(ws.dir, rel);
  await fsp.appendFile(file, '\nMy own step.\n');
  const template = path.join(ws.templates, 'ai', 'claude-code', rel);
  await fsp.appendFile(template, '\nA new app step.\n');
  upgradeWorkspace(ws.dir, ws.opts);
  const c = await compareInstructionUpdate(ws.dir, rel);
  assert.equal(c.state, 'ready');
  // A replace that got as far as the rename, then the commands folder became a link to a folder outside.
  replaceSteps.after = (step) => { if (step === 'replaced') throw new Error('interrupted'); };
  await assert.rejects(useAppVersion(ws.dir, { path: rel, mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), /interrupted/);
  replaceSteps.after = null;
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-review-linked-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  const commands = path.join(ws.dir, '.claude', 'commands');
  await fsp.cp(commands, outside, { recursive: true });
  await fsp.rm(commands, { recursive: true });
  await fsp.symlink(outside, commands);
  await fsp.writeFile(path.join(outside, 'gtd-task.md.new'), c.app);

  await recoverInstructionReplace(ws.dir);
  assert.equal(await fsp.readFile(path.join(outside, 'gtd-task.md.new'), 'utf8'), c.app, 'the .new outside is left alone');
});

test('a crash between the rename and the journal\'s next record is still finished, with the user\'s later edit kept', async (t) => {
  const { dir, file, entry } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  replaceSteps.after = (step) => { if (step === 'renamed') throw new Error('crashed'); };
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), /crashed/);
  replaceSteps.after = null;
  const journal = JSON.parse(await fsp.readFile(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH), 'utf8')) as { phase: string };
  assert.equal(journal.phase, 'replacing', 'the phase after the rename was never written');
  const edited = `${c.app}\nEdited before the restart.\n`;
  await fsp.writeFile(file, edited);

  await refreshWorkspace(dir);
  assert.equal(await fsp.readFile(file, 'utf8'), edited);
  assert.equal(entry().merged_sha256, c.app_sha256);
  assert.equal(entry().base_sha256, c.app_sha256);
  await assert.rejects(fsp.access(`${file}.new`));
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  assert.deepEqual(await listInstructionUpdates(dir), []);
});

test('a crash right before the rename leaves the file the user\'s, removes the staged copy, and keeps the update', async (t) => {
  const { dir, file, entry } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  replaceSteps.after = (step) => { if (step === 'committing') throw new Error('crashed'); };
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), /crashed/);
  replaceSteps.after = null;
  const staged = () => fsp.readdir(dir).then((names) => names.filter((n) => n.startsWith('.AGENTS.md.') && n.endsWith('.tmp')));
  assert.equal((await staged()).length, 1);
  // The user edits their own file before the restart: still theirs, never taken for the app's.
  await fsp.appendFile(file, '\nAnother own rule.\n');

  await refreshWorkspace(dir);
  assert.match(await fsp.readFile(file, 'utf8'), /Another own rule\./);
  assert.equal(entry().merged_sha256, undefined);
  assert.deepEqual(await staged(), []);
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  assert.deepEqual((await listInstructionUpdates(dir)).map((u) => u.state), ['ready']);
});

test('the user\'s file saved during the replace is caught by the last check; the verified backup stays in the trash', async (t) => {
  const { dir, file } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  replaceSteps.after = async (step) => { if (step === 'staged') await fsp.appendFile(file, '\nSaved meanwhile.\n'); };
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), status(409));
  replaceSteps.after = null;
  assert.match(await fsp.readFile(file, 'utf8'), /Saved meanwhile\./);
  const trash = await fsp.readdir(path.join(dir, '.situation-board', 'trash'));
  assert.equal(trash.length, 1, 'the backup made before the check stays');
  assert.equal(sha(await fsp.readFile(path.join(dir, '.situation-board', 'trash', trash[0]!))), c.mine_sha256);
  assert.deepEqual((await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  await assert.rejects(fsp.access(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH)));
});

/** A replace that crashed right after its rename, then the user edited the file; release C arrives before the restart. */
async function crashedAfterRenameThenNewRelease(t: T) {
  const ws = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(ws.dir, 'AGENTS.md');
  replaceSteps.after = (step) => { if (step === 'renamed') throw new Error('crashed'); };
  await assert.rejects(useAppVersion(ws.dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), /crashed/);
  replaceSteps.after = null;
  const edited = `${c.app}\nEdited before the restart.\n`;
  await fsp.writeFile(ws.file, edited);
  const template = path.join(ws.templates, 'ai', 'codex', 'AGENTS.md');
  await fsp.appendFile(template, '\nRelease C.\n');
  return { ...ws, b: c.app_sha256, bText: c.app, edited };
}

test('a recovery that fails stops the refresh before the upgrade, and the next start finishes both', async (t) => {
  const ws = await crashedAfterRenameThenNewRelease(t);
  const before = await fsp.readFile(path.join(ws.dir, MANIFEST_RELATIVE_PATH), 'utf8');
  let failures = 1;
  recoverySteps.after = (step) => { if (step === 'acknowledging' && failures-- > 0) throw new Error('manifest write failed'); };
  assert.equal((await refreshWorkspace(ws.dir)).status, 'skipped');
  assert.equal(await fsp.readFile(path.join(ws.dir, MANIFEST_RELATIVE_PATH), 'utf8'), before, 'not upgraded meanwhile');
  await fsp.access(path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH));
  assert.equal(sha(await fsp.readFile(path.join(ws.dir, APP_FILES_RELATIVE_PATH, ws.b))), ws.b, 'release B\'s text is still kept');

  assert.equal((await refreshWorkspace(ws.dir)).status, 'done');
  await assert.rejects(fsp.access(path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH)));
  assert.equal(await fsp.readFile(ws.file, 'utf8'), ws.edited);
  assert.equal(ws.entry().base_sha256, ws.b, 'B was applied: it is the base the next release is compared from');
  const c = await compareInstructionUpdate(ws.dir, 'AGENTS.md');
  assert.equal(c.release, 'changed');
  assert.equal(c.base, ws.bText);
  assert.match(c.app, /Release C\./);
  assert.deepEqual(await acknowledgeInstructionUpdate(ws.dir, (await listInstructionUpdates(ws.dir))[0]), []);
});

test('the release an unfinished replace names is never pruned, so it can always be finished', async (t) => {
  const ws = await crashedAfterRenameThenNewRelease(t);
  // An upgrade that runs without recovery first (as an older entry point would) prunes everything else, not B.
  upgradeWorkspace(ws.dir, ws.opts);
  assert.equal(sha(await fsp.readFile(path.join(ws.dir, APP_FILES_RELATIVE_PATH, ws.b))), ws.b);
  // Meanwhile this one file has three kept versions: its base A, the pinned B and the current C.
  const kept = new Set(await ws.stored());
  assert.ok([sha(ws.v1), ws.b, ws.entry().sha256].every((h) => kept.has(h)), 'base, pinned and current are all kept');
  assert.equal(new Set([sha(ws.v1), ws.b, ws.entry().sha256]).size, 3);
  assert.equal(await recoverInstructionReplace(ws.dir), 'finished');
  assert.equal(ws.entry().base_sha256, ws.b);
  assert.equal(await fsp.readFile(ws.file, 'utf8'), ws.edited);
});

test('a rollback interrupted after removing the staged copy stays a rollback on the retry', async (t) => {
  const { dir, file, entry } = await customisedThenReleased(t);
  const c = await compareInstructionUpdate(dir, 'AGENTS.md');
  replaceSteps.after = (step) => { if (step === 'committing') throw new Error('crashed'); };
  await assert.rejects(useAppVersion(dir, { path: 'AGENTS.md', mine_sha256: c.mine_sha256, app_sha256: c.app_sha256, state: c.state, workspace: c.workspace }), /crashed/);
  replaceSteps.after = null;
  recoverySteps.after = (step) => { if (step === 'rolled-back') throw new Error('journal removal failed'); };
  assert.equal((await refreshWorkspace(dir)).status, 'skipped');
  recoverySteps.after = null;
  const journal = JSON.parse(await fsp.readFile(path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH), 'utf8')) as { phase: string };
  assert.equal(journal.phase, 'rolled_back');
  assert.deepEqual((await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp')), [], 'the staged copy is gone');

  assert.equal((await refreshWorkspace(dir)).status, 'done');
  assert.equal(sha(await fsp.readFile(file)), c.mine_sha256, 'the user\'s file was never replaced');
  assert.equal(entry().merged_sha256, undefined, 'and the release is not recorded as applied');
  await fsp.access(`${file}.new`);
  assert.deepEqual((await listInstructionUpdates(dir)).map((u) => u.state), ['ready']);
});

test('a journal that cannot be read stops the refresh and pruning; once readable, the replace is finished', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs file permissions' : false }, async (t) => {
  const ws = await crashedAfterRenameThenNewRelease(t);
  const journal = path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH);
  const before = await fsp.readFile(path.join(ws.dir, MANIFEST_RELATIVE_PATH), 'utf8');
  await fsp.chmod(journal, 0o000);
  t.after(() => fsp.chmod(journal, 0o600).catch(() => {}));
  assert.equal((await refreshWorkspace(ws.dir)).status, 'skipped');
  assert.equal(await fsp.readFile(path.join(ws.dir, MANIFEST_RELATIVE_PATH), 'utf8'), before, 'not upgraded meanwhile');
  // An upgrade run some other way prunes nothing while the journal cannot be read.
  upgradeWorkspace(ws.dir, ws.opts);
  assert.equal(sha(await fsp.readFile(path.join(ws.dir, APP_FILES_RELATIVE_PATH, ws.b))), ws.b, 'release B\'s text survives');
  // A resolution meanwhile is refused with a clear status, not an unexplained error.
  const [row] = await listInstructionUpdates(ws.dir);
  await assert.rejects(acknowledgeInstructionUpdate(ws.dir, row), status(503));

  await fsp.chmod(journal, 0o600);
  assert.equal((await refreshWorkspace(ws.dir)).status, 'done');
  await assert.rejects(fsp.access(journal));
  assert.equal(await fsp.readFile(ws.file, 'utf8'), ws.edited);
  const c = await compareInstructionUpdate(ws.dir, 'AGENTS.md');
  assert.equal(c.base, ws.bText, 'compared from B, the release that was applied');
  assert.match(c.app, /Release C\./);
});

test('a journal that is not one the app can read is never taken for none', async (t) => {
  const ws = await crashedAfterRenameThenNewRelease(t);
  const journal = path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH);
  const original = await fsp.readFile(journal);
  await fsp.writeFile(journal, '{ not json');
  assert.equal((await refreshWorkspace(ws.dir)).status, 'skipped');
  upgradeWorkspace(ws.dir, ws.opts);
  assert.equal(sha(await fsp.readFile(path.join(ws.dir, APP_FILES_RELATIVE_PATH, ws.b))), ws.b);
  await fsp.writeFile(journal, original);
  assert.equal(await recoverInstructionReplace(ws.dir), 'finished');
  assert.equal(ws.entry().base_sha256, ws.b);
});

test('a manifest that cannot be read never makes recovery forget an applied release', async (t) => {
  const ws = await crashedAfterRenameThenNewRelease(t);
  const manifestPath = path.join(ws.dir, MANIFEST_RELATIVE_PATH);
  const manifest = await fsp.readFile(manifestPath);
  await fsp.writeFile(manifestPath, '{ damaged');
  assert.equal((await refreshWorkspace(ws.dir)).status, 'skipped', 'not upgraded or pruned meanwhile');
  await fsp.access(path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH));
  assert.equal(await fsp.readFile(manifestPath, 'utf8'), '{ damaged');
  await fsp.writeFile(manifestPath, manifest);
  assert.equal((await refreshWorkspace(ws.dir)).status, 'done');
  assert.equal(ws.entry().base_sha256, ws.b);
  assert.equal((await compareInstructionUpdate(ws.dir, 'AGENTS.md')).base, ws.bText);
});

test('a manifest without read permission is the same: the journal is kept until it can be read', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs file permissions' : false }, async (t) => {
  const ws = await crashedAfterRenameThenNewRelease(t);
  const manifestPath = path.join(ws.dir, MANIFEST_RELATIVE_PATH);
  await fsp.chmod(manifestPath, 0o000);
  t.after(() => fsp.chmod(manifestPath, 0o600).catch(() => {}));
  assert.equal((await refreshWorkspace(ws.dir)).status, 'skipped');
  await fsp.access(path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH));
  await fsp.chmod(manifestPath, 0o600);
  assert.equal((await refreshWorkspace(ws.dir)).status, 'done');
  assert.equal(ws.entry().base_sha256, ws.b);
});

test('a journal with a phase the app does not know is kept, never read as a rollback', async (t) => {
  const ws = await crashedAfterRenameThenNewRelease(t);
  const journalPath = path.join(ws.dir, REPLACE_JOURNAL_RELATIVE_PATH);
  const journal = JSON.parse(await fsp.readFile(journalPath, 'utf8')) as Record<string, unknown>;
  await fsp.writeFile(journalPath, JSON.stringify({ ...journal, phase: 'from-the-future' }));
  assert.equal((await refreshWorkspace(ws.dir)).status, 'skipped');
  const [row] = await listInstructionUpdates(ws.dir);
  await assert.rejects(acknowledgeInstructionUpdate(ws.dir, row), status(503));
  await fsp.access(journalPath);
  await fsp.writeFile(journalPath, JSON.stringify(journal));
  assert.equal((await refreshWorkspace(ws.dir)).status, 'done');
  assert.equal(ws.entry().base_sha256, ws.b);
});

test('a folder in the journal\'s place stops Keep, the refresh and pruning', async (t) => {
  const { dir, entry, stored } = await customisedThenReleased(t);
  const journalPath = path.join(dir, REPLACE_JOURNAL_RELATIVE_PATH);
  await fsp.mkdir(journalPath);
  const orphan = sha('an orphan');
  await fsp.writeFile(path.join(dir, APP_FILES_RELATIVE_PATH, orphan), 'an orphan');
  const [row] = await listInstructionUpdates(dir);
  await assert.rejects(acknowledgeInstructionUpdate(dir, row), status(503));
  assert.equal(entry().merged_sha256, undefined, 'nothing settled');
  assert.equal((await refreshWorkspace(dir)).status, 'skipped');
  upgradeWorkspace(dir, { profile, aiTools: ['codex'] });
  assert.ok((await stored()).includes(orphan), 'pruning waits while the journal cannot be told');
  assert.ok((await fsp.lstat(journalPath)).isDirectory(), 'and the folder is left alone');
});
