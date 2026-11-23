import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AgentRunnerService, ClaudeCodeAdapter, runnerEnv, type RunOutcome } from '../src/services/agentRunner';
import { AssistantAccountsService, folderSlug, forgetProbes, lockHooks, signInUrl, stopSignIn, terminalCommand, type AccountsView } from '../src/services/assistantAccounts';
import { chosenFolder, savedChoice } from '../src/services/assistantAccountFolder';
import { ClaudeChatAdapter } from '../src/services/chat/claude';
import { CodexChatAdapter, codexChosenEnv } from '../src/services/chat/codex';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { readUserConfig } from '../src/services/userConfig';

// The app's own config lives in ~/.gtd: a fictional home for the whole file, never the real one. Its real path, so
// folders compare as the system reports them (macOS: /var → /private/var).
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-accounts-home-')));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
// The dashboard's own environment names no config folder in these tests: the defaults are ~/.claude and ~/.codex.
delete process.env['CLAUDE_CONFIG_DIR'];
delete process.env['CODEX_HOME'];
const posix = { skip: process.platform === 'win32' };

const log = path.join(home, 'fake-tools.log');
const claudeDefault = path.join(home, '.claude');
const work = path.join(home, '.claude-work');
const codexDefault = path.join(home, '.codex');
const codexWork = path.join(home, '.codex-work');

/**
 * Stand-ins for the Claude Code and Codex CLIs, answering from the config folder they are started with (the variable,
 * or the default under HOME): `fake-account.json` there is the fictional sign-in. Every call is logged with its
 * arguments and folder. A sign-in prints a link, then waits until the test writes `login-go` in that folder.
 */
async function fakeTools(): Promise<{ claude: string; codex: string }> {
  const dir = path.join(home, 'bin');
  await fsp.mkdir(dir, { recursive: true });
  const common = (envVar: string, defaultName: string) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const dir = process.env.${envVar} || path.join(process.env.HOME, '${defaultName}');
const overrides = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'].filter((n) => process.env[n]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: '${defaultName}', args: args.filter((a) => !a.startsWith('features.') && a !== '-c' && a !== 'web_search=disabled'), dir: process.env.${envVar} ?? null, tty: Boolean(process.stdin.isTTY), overrides, pid: process.pid }) + '\\n');
const account = path.join(dir, 'fake-account.json');
const read = () => (fs.existsSync(account) ? JSON.parse(fs.readFileSync(account, 'utf-8')) : null);
/** Waits until the test writes \`name\` in the folder (a barrier, no timing), then runs \`then\` with its contents. */
const gate = (name, then) => {
  const file = path.join(dir, name);
  const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); then(fs.readFileSync(file, 'utf-8')); } }, 20);
};
const waitForBrowser = () => gate('login-go', (answer) => {
  if (answer === 'fail') { process.stderr.write('Error: token exchange failed\\nAuthorization: Bearer FICTIONAL-MARKER\\n'); process.exit(1); }
  fs.writeFileSync(account, answer);
  process.exit(0);
});
`;
  const claude = path.join(dir, 'claude');
  await fsp.writeFile(claude, `${common('CLAUDE_CONFIG_DIR', '.claude')}
const status = () => {
  const a = read();
  process.stdout.write(JSON.stringify(a ? { loggedIn: true, authMethod: a.method || 'claude.ai', email: a.email, subscriptionType: a.plan || 'pro' } : { loggedIn: false, authMethod: 'none' }));
  process.exit(a ? 0 : 1);
};
if (args[0] === 'auth' && args[1] === 'status') {
  if (fs.existsSync(path.join(dir, 'slow-status'))) gate('status-go', status); else status();
} else if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write('Opening browser to sign in\\u2026\\nSee https://github.com/example/project first.\\nIf the browser didn\\'t open, visit:\\n\\u001b[1mhttps://claude.ai/oauth/authorize?code=true&state=fictional\\u001b[0m\\nhttps://evil.example/also-a-link\\n');
  waitForBrowser();
} else if (args[0] === 'auth' && args[1] === 'logout') {
  const out = () => { fs.rmSync(account, { force: true }); process.exit(0); };
  if (fs.existsSync(path.join(dir, 'slow-logout'))) gate('logout-go', out); else out();
} else if (fs.existsSync(path.join(dir, 'slow-run'))) gate('run-go', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, permission_denials: [] })));
else process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, permission_denials: [] }));
`, { mode: 0o755 });
  const codex = path.join(dir, 'codex');
  await fsp.writeFile(codex, `${common('CODEX_HOME', '.codex')}
if (args[0] === 'app-server') {
  const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    const reply = (result) => out({ id: m.id, result });
    const a = read();
    switch (m.method) {
      case 'initialize': return reply({});
      case 'account/read': return reply(a ? { account: { type: 'chatgpt', email: a.email, planType: a.plan || 'plus' }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true });
      case 'config/read': {
        const answer = () => reply({ config: { mcp_servers: {} } });
        if (fs.existsSync(path.join(dir, 'slow-config'))) return gate('config-go', answer);
        return answer();
      }
      case 'hooks/list': return reply({ data: [] });
      case 'model/list': return reply({ data: [] });
      default: return reply({});
    }
  });
} else if (args[0] === 'login') {
  process.stderr.write('Starting local login server on http://localhost:1455.\\nIf your browser did not open, navigate to this URL to authenticate:\\n\\nhttps://auth.openai.com/oauth/authorize?response_type=code&state=fictional\\n');
  waitForBrowser();
} else if (args[0] === 'logout') { fs.rmSync(account, { force: true }); process.exit(0); }
`, { mode: 0o755 });
  return { claude, codex };
}

type Call = { tool: string; args: string[]; dir: string | null; tty: boolean; overrides: string[]; pid: number };
const calls = async (): Promise<Call[]> => (await fsp.readFile(log, 'utf-8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call);
const signedInAs = (dir: string, email: string, plan?: string, method?: string) => fsp.writeFile(path.join(dir, 'fake-account.json'), JSON.stringify({ email, plan, method }));
const trust = (dir: string, ws: string) => fsp.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ projects: { [ws]: { hasTrustDialogAccepted: true } } }));
async function eventually(check: () => Promise<boolean> | boolean, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (await check()) return true;
  return check();
}
const of = (view: AccountsView, id: string) => view.assistants.find((a) => a.id === id)!;

/**
 * A fresh fictional home: Claude Code's ~/.claude (signed in) and ~/.claude-work (signed in), Codex's ~/.codex
 * (signed in) and ~/.codex-work (signed in), no app config, and a trusted workspace for the default Claude folder.
 */
async function setup(t: { after: (fn: () => Promise<void> | void) => void }, copilot: { signed_in: boolean | null; plan: string | null } = { signed_in: true, plan: null }) {
  for (const name of await fsp.readdir(home)) await fsp.rm(path.join(home, name), { recursive: true, force: true });
  forgetProbes();
  const bins = await fakeTools();
  for (const dir of [claudeDefault, work, codexDefault, codexWork]) await fsp.mkdir(dir);
  await fsp.writeFile(path.join(work, '.claude.json'), '{}');
  await fsp.writeFile(path.join(codexWork, 'config.toml'), '');
  await signedInAs(claudeDefault, 'personal@example.com');
  await signedInAs(work, 'work@example.com', 'team');
  await signedInAs(codexDefault, 'personal@example.com', 'plus');
  await signedInAs(codexWork, 'work@example.com', 'business');
  const ws = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-accounts-ws-')));
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(ws, d), { recursive: true });
  const previous = process.env['ESB_WORKSPACE_PATH'];
  process.env['ESB_WORKSPACE_PATH'] = ws;
  t.after(async () => {
    if (previous === undefined) delete process.env['ESB_WORKSPACE_PATH'];
    else process.env['ESB_WORKSPACE_PATH'] = previous;
    await fsp.rm(ws, { recursive: true, force: true });
  });
  // The default folder's trust is in ~/.claude.json, as Claude Code keeps it without CLAUDE_CONFIG_DIR.
  await fsp.writeFile(path.join(home, '.claude.json'), JSON.stringify({ projects: { [ws]: { hasTrustDialogAccepted: true } } }));
  const binary = (command: string) => (command === 'claude' ? bins.claude : command === 'codex' ? bins.codex : command === 'copilot' ? '/fictional/copilot' : null);
  const service = new AssistantAccountsService(binary, () => ({ PATH: process.env['PATH'], HOME: home }), 5000, 10_000, async () => copilot);
  return { ...bins, ws, service };
}

test('each assistant lists its accounts with their own sign-in; links, folders without a config and the default folder are not listed twice', posix, async (t) => {
  const { service } = await setup(t, { signed_in: true, plan: 'Copilot Business' });
  await fsp.mkdir(path.join(home, '.claude-empty')); // no .claude.json: not a Claude Code config folder
  await fsp.symlink(work, path.join(home, '.claude-link')); // a link is never followed
  await fsp.writeFile(path.join(home, '.claude-file'), 'not a folder');
  const outside = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-accounts-outside-')));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await service.addFolder('claude-code', outside);

  await fsp.rm(log, { force: true });
  forgetProbes();
  const [view, again] = await Promise.all([service.list(), service.list()]);
  const claude = of(view, 'claude-code');
  assert.deepEqual(claude.accounts.map((a) => [a.folder, a.kind, a.signed_in, a.account?.email ?? null, a.chosen]), [
    [null, 'default', true, 'personal@example.com', true],
    [work, 'found', true, 'work@example.com', false],
    [outside, 'added', false, null, false],
  ]);
  assert.equal(claude.accounts[1].account?.plan, 'team');
  assert.equal(claude.accounts[0].plan_ok, true);
  assert.deepEqual([claude.methods, claude.sso, claude.choosable], [['claudeai', 'sso', 'console'], 'option', true]);
  const codex = of(view, 'codex');
  assert.deepEqual(codex.accounts.map((a) => [a.folder, a.signed_in, a.account?.email ?? null, a.account?.plan ?? null]), [
    [null, true, 'personal@example.com', 'plus'],
    [codexWork, true, 'work@example.com', 'business'],
  ]);
  assert.deepEqual([codex.methods, codex.sso], [['browser'], 'on_page'], 'Codex: single sign-on happens on its own sign-in page');
  const copilot = of(view, 'copilot');
  assert.deepEqual([copilot.choosable, copilot.methods, copilot.can_sign_out, copilot.accounts.length, copilot.accounts[0].signed_in, copilot.accounts[0].account?.plan],
    [false, [], false, 1, true, 'Copilot Business'], 'Copilot: the account only, as the chat check found it');

  assert.deepEqual(of(again, 'claude-code').accounts.map((a) => a.account?.email ?? null), claude.accounts.map((a) => a.account?.email ?? null));
  const probes = await calls();
  assert.deepEqual(probes.filter((c) => c.tool === '.claude').map((c) => c.dir).sort(), [null, outside, work].sort(), 'one probe per folder, shared by both requests, the default without a folder');
  assert.ok(probes.filter((c) => c.tool === '.claude').every((c) => c.args.join(' ') === 'auth status --json'), 'Claude Code: only its status, no model call');
  assert.deepEqual(probes.filter((c) => c.tool === '.codex').map((c) => [c.args[0], c.dir]).sort(), [['app-server', codexWork], ['app-server', null]].sort(), 'Codex: its own account check, per folder');
});

test('the chosen account is saved per computer and used by the runner, its trust check and the chat; nothing chosen is exactly as before', posix, async (t) => {
  const { claude, codex, ws, service } = await setup(t);
  assert.equal(runnerEnv({ PATH: '/bin' })['CLAUDE_CONFIG_DIR'], undefined);
  assert.equal(runnerEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/inherited' })['CLAUDE_CONFIG_DIR'], '/inherited', 'unset: the inherited environment');
  assert.equal(codexChosenEnv({ PATH: '/bin' })['CODEX_HOME'], undefined);

  const adapter = new ClaudeCodeAdapter(() => claude);
  assert.equal((await adapter.status(ws)).account?.email, 'personal@example.com');

  const chosen = await service.choose('claude-code', work);
  assert.equal(of(chosen, 'claude-code').chosen, work);
  assert.equal(savedChoice('claude-code').folder, work, 'kept in the app\'s own config, not in the workspace');
  assert.ok(!fs.existsSync(path.join(ws, '.gtd')));
  assert.equal(chosenFolder('claude-code'), work);
  assert.equal(chosenFolder('codex'), null, 'one assistant\'s choice leaves the others alone');
  assert.equal(runnerEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/inherited', ANTHROPIC_API_KEY: 'fictional' })['CLAUDE_CONFIG_DIR'], work);
  assert.equal(runnerEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'fictional' })['ANTHROPIC_API_KEY'], undefined, 'billing overrides still removed');

  // The trust comes from the chosen folder's own settings: not trusted there yet.
  const after = await new ClaudeCodeAdapter(() => claude).status(ws);
  assert.equal(after.account?.email, 'work@example.com');
  assert.deepEqual(after.problems.map((p) => p.code), ['not_trusted']);
  await trust(work, ws);
  assert.deepEqual((await new ClaudeCodeAdapter(() => claude).status(ws)).problems, []);
  assert.equal((await adapter.status(ws)).account?.email, 'work@example.com', 'an adapter made before the switch checks the new folder');
  assert.equal((await new ClaudeChatAdapter(() => claude).status(ws)).plan, 'team', 'the chat uses the chosen account too');

  await fsp.rm(log, { force: true });
  await new Promise<RunOutcome>((resolve) => adapter.start(ws, '/gtd-context-analyze CU-2026-0001', resolve));
  assert.equal((await calls()).find((c) => c.args[0] === '-p')?.dir, work, 'the run is started with the chosen folder');

  // Codex: the chat's own check and its sessions follow the choice.
  const chat = new CodexChatAdapter(() => codex);
  assert.equal((await chat.status(ws)).plan, 'plus');
  await service.choose('codex', codexWork);
  assert.equal(codexChosenEnv({ PATH: '/bin', OPENAI_API_KEY: 'fictional' })['CODEX_HOME'], codexWork);
  assert.equal(codexChosenEnv({ PATH: '/bin', OPENAI_API_KEY: 'fictional' })['OPENAI_API_KEY'], undefined);
  assert.equal((await chat.status(ws)).plan, 'business', 'a cached check is not reused after the switch');

  // Back to the default: the folder is removed and the environment is the inherited one again.
  assert.equal(of(await service.choose('claude-code', null), 'claude-code').chosen, null);
  assert.equal(savedChoice('claude-code').folder, undefined);
  assert.equal(runnerEnv({ PATH: '/bin' })['CLAUDE_CONFIG_DIR'], undefined);
  assert.equal((await adapter.status(ws)).account?.email, 'personal@example.com');
  assert.equal(chosenFolder('codex'), codexWork);
});

test('a run starts only with the account its own check approved, even when another check ran meanwhile (finding 4)', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  const adapter = new ClaudeCodeAdapter(() => claude);
  // A slow check of the trusted default account; meanwhile the untrusted work account is chosen and checked too.
  await fsp.writeFile(path.join(claudeDefault, 'slow-status'), '');
  const first = adapter.status(ws);
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[1] === 'status' && c.dir === null)));
  // Settings lists the accounts after saving, and that check of the default waits too: not awaited until released.
  const chosen = service.choose('claude-code', work);
  assert.ok(await eventually(() => savedChoice('claude-code').folder === work));
  assert.deepEqual((await adapter.status(ws)).problems.map((p) => p.code), ['not_trusted'], 'the second check, on the same adapter');
  await fsp.writeFile(path.join(claudeDefault, 'status-go'), '');
  const approved = await first;
  await chosen;
  assert.deepEqual(approved.problems, [], 'the first check approved the default account');
  assert.throws(() => adapter.start(ws, '/gtd-context-analyze CU-2026-0001', () => {}, undefined, undefined, approved.launch_key), /changed while this run was being checked/);
  await fsp.rm(log, { force: true });
  await trust(work, ws);
  const fresh = await adapter.status(ws);
  await new Promise<RunOutcome>((resolve) => adapter.start(ws, '/gtd-context-analyze CU-2026-0001', resolve, undefined, undefined, fresh.launch_key));
  assert.equal((await calls()).find((c) => c.args[0] === '-p')?.dir, work);
});

test('signing in again in the same folder is checked again at once by the runner and the Codex chat (finding 11)', posix, async (t) => {
  const { claude, codex, ws, service } = await setup(t);
  const adapter = new ClaudeCodeAdapter(() => claude);
  const before = await adapter.status(ws);
  assert.deepEqual(before.problems, []);
  const chat = new CodexChatAdapter(() => codex);
  assert.equal((await chat.status(ws)).plan, 'plus');
  // Signed in again in the default folders, now with an API account for Claude and another plan for Codex.
  await service.startSignIn('claude-code', null, 'console');
  await fsp.writeFile(path.join(claudeDefault, 'login-go'), JSON.stringify({ email: 'personal@example.com', method: 'console' }));
  assert.ok(await eventually(() => service.signInState()?.status === 'succeeded'));
  assert.deepEqual((await adapter.status(ws)).problems.map((p) => p.code), ['not_subscription'], 'the cached check is not reused');
  assert.throws(() => adapter.start(ws, '/gtd-context-analyze CU-2026-0001', () => {}, undefined, undefined, before.launch_key), /changed/, 'nor the approval of the check before');
  await service.startSignIn('codex', null, null);
  await fsp.writeFile(path.join(codexDefault, 'login-go'), JSON.stringify({ email: 'personal@example.com', plan: 'pro' }));
  assert.ok(await eventually(() => service.signInState()?.status === 'succeeded'));
  assert.equal((await chat.status(ws)).plan, 'pro', 'the Codex chat checks again too');
});

test('folders that are not plain folders in reach are refused, and a chosen account that goes away stops its assistant rather than switching', posix, async (t) => {
  const { claude, codex, ws, service } = await setup(t);
  const bad = (err: Error & { statusCode?: number }) => err.statusCode === 400;
  const outside = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-accounts-outside-')));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(home, 'a-file'), 'x');
  await fsp.symlink(work, path.join(home, 'link-to-work'));
  await fsp.mkdir(path.join(home, 'real', 'inner'), { recursive: true });
  await fsp.symlink(path.join(home, 'real'), path.join(home, 'linked-parent'));

  for (const folder of ['relative/folder', '', 42, path.join(home, 'missing'), path.join(home, 'a-file'), path.join(home, 'link-to-work'),
    path.join(home, 'linked-parent', 'inner'), home, claudeDefault, '/']) {
    await assert.rejects(service.addFolder('claude-code', folder), bad, `add ${String(folder)}`);
  }
  await assert.rejects(service.addFolder('codex', codexDefault), bad, 'Codex\'s default folder is the default account');
  await assert.rejects(service.choose('claude-code', outside), /not in the list/, 'outside the home folder: only once added');
  await assert.rejects(service.choose('claude-code', path.join(home, 'real')), /not in the list/, 'inside home but neither found nor added');
  await assert.rejects(service.choose('claude-code', codexWork), /not in the list/, 'another assistant\'s folder');
  await assert.rejects(service.choose('nobody', null), (err: Error & { statusCode?: number }) => err.statusCode === 404);
  await assert.rejects(service.choose('copilot', work), /default account only/, 'Copilot offers no choice');
  await assert.rejects(service.addFolder('copilot', outside), /default account only/);
  await service.addFolder('claude-code', outside);
  assert.equal(of(await service.choose('claude-code', outside), 'claude-code').chosen, outside);
  await service.choose('claude-code', null);

  // Chosen, then replaced by a link: nothing starts, and nothing falls back to another account.
  await service.choose('claude-code', work);
  await service.choose('codex', codexWork);
  for (const [dir, moved] of [[work, 'moved'], [codexWork, 'moved-codex']]) {
    await fsp.rename(dir, path.join(home, moved));
    await fsp.symlink(path.join(home, moved), dir);
  }
  assert.throws(() => runnerEnv(), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  const check = await new ClaudeCodeAdapter(() => claude).status(ws);
  assert.deepEqual(check.problems.map((p) => p.code), ['account_folder']);
  assert.equal(check.account, null);
  const chat = await new CodexChatAdapter(() => codex).status(ws);
  assert.equal(chat.ready, false);
  assert.match(chat.problems[0].message, /can no longer be found/);
  const listed = of(await service.list(), 'claude-code');
  assert.ok(listed.accounts.find((a) => a.folder === work)?.problem, 'the chosen account is still listed, with its problem');
  await assert.rejects(service.removeFolder('claude-code', work), /Choose another one first/);
  assert.equal(of(await service.choose('claude-code', null), 'claude-code').chosen, null, 'the default can always be chosen again');
});

test('signing in and out starts each tool\'s own command with that account\'s folder, without a terminal, and remembers only the method', posix, async (t) => {
  const { service } = await setup(t);
  await fsp.rm(path.join(work, 'fake-account.json'));
  await fsp.rm(log, { force: true });

  await assert.rejects(service.startSignIn('claude-code', work, 'password'), /sign-in methods offered/);
  await assert.rejects(service.startSignIn('codex', null, 'sso'), /sign-in methods offered/, 'Codex has no SSO option of its own');
  await assert.rejects(service.startSignIn('copilot', null, null), /cannot be signed in from the dashboard/);
  const started = await service.startSignIn('claude-code', work, 'sso');
  assert.equal(started.status, 'running');
  await assert.rejects(service.startSignIn('claude-code', null, null), /already going/, 'one sign-in at a time');
  assert.ok(await eventually(() => service.signInState()?.url !== null), 'the link the tool prints is shown');
  assert.equal(service.signInState()?.url, 'https://claude.ai/oauth/authorize?code=true&state=fictional', 'only the sign-in page itself, without colour codes: not the repository link printed before it');
  const login = (await calls()).find((c) => c.args[1] === 'login')!;
  assert.deepEqual(login.args, ['auth', 'login', '--sso'], 'single sign-on is the tool\'s own --sso');
  assert.equal(login.dir, work);
  assert.equal(login.tty, false, 'no terminal: its input is closed');

  // The user finishes in the browser; the app then checks the sign-in again and remembers the method, nothing else.
  await fsp.writeFile(path.join(work, 'login-go'), JSON.stringify({ email: 'new@example.com' }));
  assert.ok(await eventually(() => service.signInState()?.status === 'succeeded'));
  const after = of(await service.list(), 'claude-code').accounts.find((a) => a.folder === work)!;
  assert.equal(after.account?.email, 'new@example.com');
  assert.ok(await eventually(() => savedChoice('claude-code').methods[work] === 'sso'));
  assert.equal(of(await service.list(), 'claude-code').accounts.find((a) => a.folder === work)?.last_method, 'sso', '"Sign in again" uses it');
  assert.doesNotMatch(JSON.stringify(readUserConfig()), /new@example\.com|token/i, 'no account details or tokens are stored');

  // The default Claude account: no folder variable at all, the Claude account by default. Cancel ends it.
  await service.startSignIn('claude-code', null, null);
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[1] === 'login' && c.dir === null)));
  assert.deepEqual((await calls()).filter((c) => c.args[1] === 'login').at(-1)!.args, ['auth', 'login', '--claudeai']);
  assert.equal((await service.cancelSignIn())?.status, 'cancelled');
  assert.ok(await eventually(() => service.signInState()?.ended_at !== null));
  assert.equal(service.signInState()?.status, 'cancelled');

  // Codex: its own `codex login` under CODEX_HOME; a failure is said in plain words, the tool's words only as detail.
  await service.startSignIn('codex', codexWork, null);
  assert.ok(await eventually(() => service.signInState()?.url !== null));
  assert.equal(service.signInState()?.url, 'https://auth.openai.com/oauth/authorize?response_type=code&state=fictional');
  assert.deepEqual((await calls()).filter((c) => c.tool === '.codex' && c.args[0] === 'login').map((c) => [c.args, c.dir, c.tty]), [[['login'], codexWork, false]]);
  // Finding 7: whatever the tool said when it failed is neither returned nor kept, only a fixed sentence.
  await fsp.writeFile(path.join(codexWork, 'login-go'), 'fail');
  assert.ok(await eventually(() => service.signInState()?.status === 'failed'));
  assert.equal(service.signInState()?.message, 'The sign-in did not finish. Try again.');
  assert.doesNotMatch(JSON.stringify(service.signInState()) + JSON.stringify(await service.list()), /FICTIONAL-MARKER|Bearer|token exchange/);

  await assert.rejects(service.signOut('claude-code', work, undefined), /Confirm/);
  await assert.rejects(service.signOut('copilot', null, true), /cannot be signed out from the dashboard/);
  const out = await service.signOut('claude-code', work, true);
  await service.signOut('codex', codexWork, true);
  assert.deepEqual((await calls()).filter((c) => c.args.includes('logout')).map((c) => [c.tool, c.args, c.dir]), [['.claude', ['auth', 'logout'], work], ['.codex', ['logout'], codexWork]]);
  assert.equal(of(out, 'claude-code').accounts.find((a) => a.folder === work)?.signed_in, false);
  assert.equal(of(out, 'claude-code').accounts.find((a) => a.folder === null)?.account?.email, 'personal@example.com', 'the other sign-in is untouched');
});

test('"Add another account" makes an empty folder named after what the user called it; the user never types a path', posix, async (t) => {
  const { service } = await setup(t);
  for (const name of ['x'.repeat(41), 42, 'bad\u0007name']) {
    await assert.rejects(service.createAccount('claude-code', name), (err: Error & { statusCode?: number }) => err.statusCode === 400, `name ${String(name)}`);
  }
  await assert.rejects(service.createAccount('copilot', 'Work'), /default account only/);
  const made = await service.createAccount('claude-code', 'Work');
  assert.equal(made.folder, path.join(home, '.claude-work-2'), '"work" is taken: the next free name');
  assert.deepEqual(await fsp.readdir(made.folder), [], 'empty');
  assert.equal((await fsp.stat(made.folder)).mode & 0o777, 0o700);
  const account = of(made.view, 'claude-code').accounts.find((a) => a.folder === made.folder)!;
  assert.deepEqual([account.kind, account.name, account.signed_in], ['added', 'Work', false]);
  const unnamed = await service.createAccount('codex', null);
  assert.equal(unnamed.folder, path.join(home, '.codex-account'));
  assert.equal((await service.createAccount('codex', '../../etc')).folder, path.join(home, '.codex-etc'), 'a name never becomes a path');
  await service.removeFolder('claude-code', made.folder);
  assert.ok(fs.existsSync(made.folder), 'removing from the list leaves the folder');
  assert.equal(savedChoice('claude-code').names[made.folder], undefined);
});

test('hands-off analysis asks for consent again after the account is switched (#496)', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  await trust(work, ws);
  const digest = new MeetingDigestService(new AgentRunnerService(new ClaudeCodeAdapter(() => claude)));
  const changed = (err: Error & { statusCode?: number; details?: { code?: string } }) => err.statusCode === 409 && err.details?.code === 'runner_account_changed';

  // Confirmed for the default account; then the work account is chosen before Turn on: refused, nothing on.
  await service.choose('claude-code', work);
  await assert.rejects(digest.update({ after_each_meeting: true, auto_analyze: true, account: 'personal@example.com' }), changed);
  assert.equal((await digest.readSettings()).auto_analyze, false);
  // Confirmed again for the account shown now: on.
  await digest.update({ after_each_meeting: true, auto_analyze: true, account: 'work@example.com' });
  assert.equal((await digest.readSettings()).auto_analyze, true);
  await digest.update({ after_each_meeting: false, auto_analyze: false });
  await service.choose('claude-code', null);
  await assert.rejects(digest.update({ after_each_meeting: true, auto_analyze: true, account: 'work@example.com' }), changed);
});

test('hands-off analysis never sends meeting material to an account switched to after it was confirmed (finding 1)', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  await trust(work, ws);
  const digest = new MeetingDigestService(new AgentRunnerService(new ClaudeCodeAdapter(() => claude)));
  await digest.update({ after_each_meeting: true, auto_analyze: true, account: 'personal@example.com' });
  const confirmed = (await digest.readSettings()).confirmed_account;
  assert.match(confirmed ?? '', /^[0-9a-f]{64}$/, 'kept as a fingerprint, never the account itself');
  assert.doesNotMatch(await fsp.readFile(path.join(ws, '.situation-board', 'routines', 'meeting-digest.json'), 'utf-8'), /example\.com|\.claude/);

  // Switched to the work account while hands-off is on; then a meeting comes in and its digest is made.
  await service.choose('claude-code', work);
  const m = await digest.createMeeting({ title: 'Fictional sync', meeting_date: '2026-11-20' });
  await digest.addFile(m.id, 'notes.md', Buffer.from('Fictional notes.'));
  await digest.queue(m.id);
  await fsp.rm(log, { force: true });
  const made = await digest.runNow(new Date('2026-11-20T18:00:00'));
  assert.ok(made.context_update);
  assert.equal(made.analysis, 'account_changed');
  assert.equal((await digest.readState()).analysis?.status, 'account_changed', 'a clear state: confirm the new account');
  assert.equal((await calls()).filter((c) => c.args[0] === '-p').length, 0, 'nothing ran under the new account');
  assert.equal((await digest.runIfDue(new Date('2026-11-20T18:05:00')))?.analysis, undefined, 'and nothing on the next check either');
  assert.equal((await calls()).filter((c) => c.args[0] === '-p').length, 0);

  // A manual run is the user's own click and is not held back.
  const runner = new AgentRunnerService(new ClaudeCodeAdapter(() => claude));
  // The user confirms the new account (the switch on the Meetings page): the held-back digest starts with it.
  await digest.update({ after_each_meeting: true, auto_analyze: true, account: 'work@example.com' });
  assert.notEqual((await digest.readSettings()).confirmed_account, confirmed);
  await digest.runIfDue(new Date('2026-11-20T18:10:00'));
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[0] === '-p' && c.dir === work)), 'started with the confirmed account');
  assert.ok(await eventually(async () => !AgentRunnerService.busy()));
  assert.equal((await runner.get(made.context_update!))?.status !== undefined, true);
});

test('a chosen account is not overridden by sign-in variables the dashboard inherited; the default keeps them (finding 2)', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  const inherited = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'FICTIONAL-A', ANTHROPIC_AUTH_TOKEN: 'x', OPENAI_API_KEY: 'y', CODEX_ACCESS_TOKEN: 'z' };
  assert.equal(runnerEnv(inherited)['CLAUDE_CODE_OAUTH_TOKEN'], 'FICTIONAL-A', 'nothing chosen: exactly as before');
  await service.choose('claude-code', work);
  await service.choose('codex', codexWork);
  const claudeEnv = runnerEnv(inherited);
  assert.deepEqual([claudeEnv['CLAUDE_CONFIG_DIR'], claudeEnv['CLAUDE_CODE_OAUTH_TOKEN'], claudeEnv['ANTHROPIC_AUTH_TOKEN']], [work, undefined, undefined]);
  const codexEnv = codexChosenEnv(inherited);
  assert.deepEqual([codexEnv['CODEX_HOME'], codexEnv['OPENAI_API_KEY'], codexEnv['CODEX_ACCESS_TOKEN']], [codexWork, undefined, undefined]);

  // Every process for a named folder (checks, sign-in), but not for the default.
  const withToken = new AssistantAccountsService((c) => (c === 'claude' ? claude : null), () => ({ PATH: process.env['PATH'], HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'FICTIONAL-A' }), 5000, 10_000, async () => ({ signed_in: null, plan: null }));
  await fsp.rm(log, { force: true });
  forgetProbes();
  await withToken.list();
  await withToken.startSignIn('claude-code', work, null);
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[1] === 'login')));
  await withToken.cancelSignIn();
  assert.ok(await eventually(() => withToken.signInState()?.ended_at !== null));
  const seen = await calls();
  assert.ok(seen.filter((c) => c.dir === work).every((c) => c.overrides.length === 0), 'the work folder never saw the token');
  assert.ok(seen.some((c) => c.dir === null && c.overrides.includes('CLAUDE_CODE_OAUTH_TOKEN')), 'the default still does');
  await new Promise<RunOutcome>((resolve) => new ClaudeCodeAdapter(() => claude, () => runnerEnv({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'FICTIONAL-A' })).start(ws, '/gtd-context-analyze CU-2026-0001', resolve));
  assert.deepEqual((await calls()).find((c) => c.args[0] === '-p')?.overrides, [], 'nor the run');
});

test('a chat session opens only with the account its check approved (finding 3)', posix, async (t) => {
  const { claude, codex, ws, service } = await setup(t);
  const claudeChat = new ClaudeChatAdapter(() => claude);
  const approved = await claudeChat.status(ws);
  assert.ok(approved.ready && approved.launch_key);
  await signedInAs(work, 'work@example.com', 'team', 'console');
  await service.choose('claude-code', work);
  const codexChat = new CodexChatAdapter(() => codex);
  const codexApproved = await codexChat.status(ws);
  await service.choose('codex', codexWork);
  // Settings' own checks of the new accounts ran above; from here, nothing may start.
  await fsp.rm(log, { force: true });
  const options = { workspace: ws, model: null, effort: null, resume: null, instructions: 'Read only.' };
  await assert.rejects(claudeChat.open({ ...options, launch_key: approved.launch_key }), /changed while the message was being sent/);
  await assert.rejects(codexChat.open({ ...options, launch_key: codexApproved.launch_key }), /changed while the message was being sent/);
  assert.deepEqual(await calls(), [], 'no process started under the new accounts');
});

test('one sign-in or sign-out at a time, on this computer; shutdown ends whichever is going (finding 5)', posix, async (t) => {
  const { service } = await setup(t);
  const second = new AssistantAccountsService((c) => (c === 'claude' ? path.join(home, 'bin', 'claude') : null), () => ({ PATH: process.env['PATH'], HOME: home }), 5000, 10_000, async () => ({ signed_in: null, plan: null }));
  const results = await Promise.allSettled([service.startSignIn('claude-code', work, null), second.startSignIn('claude-code', null, null)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[1] === 'login')));
  assert.equal((await calls()).filter((c) => c.args[1] === 'login').length, 1, 'only one tool started');
  await assert.rejects(service.signOut('claude-code', null, true), /already going/, 'no sign-out meanwhile');
  const pid = (await calls()).find((c) => c.args[1] === 'login')!.pid;
  await stopSignIn();
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  assert.ok(await eventually(() => !alive(pid)), 'shutdown ended the sign-in');

  // A slow sign-out holds the slot too; shutdown ends it as well.
  await fsp.writeFile(path.join(work, 'slow-logout'), '');
  const out = service.signOut('claude-code', work, true).catch((e: Error) => e);
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[1] === 'logout')));
  await assert.rejects(service.startSignIn('claude-code', work, null), /Signing out is still going/);
  const logoutPid = (await calls()).find((c) => c.args[1] === 'logout')!.pid;
  await stopSignIn();
  assert.ok(await eventually(() => !alive(logoutPid)));
  assert.ok((await out) instanceof Error, 'a stopped sign-out is not reported as done');

  // Another live dashboard on this computer holds the lock: refused. A lock left by a process that is gone is taken over.
  const lock = path.join(home, '.gtd', 'assistant-sign-in-claude-code.lock');
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  await fsp.writeFile(lock, String(process.ppid));
  await assert.rejects(service.startSignIn('claude-code', work, null), /Another dashboard/);
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' });
  await fsp.writeFile(lock, gone.stdout);
  await service.startSignIn('claude-code', work, null);
  assert.equal(await fsp.readFile(lock, 'utf-8'), String(process.pid));
  await service.cancelSignIn();
  assert.ok(await eventually(() => !fs.existsSync(lock)), 'released once the tool has exited');
});

test('an account a run is using cannot be signed out, even after another account is chosen (finding 6)', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  await trust(work, ws);
  await service.choose('claude-code', work);
  await fsp.writeFile(path.join(work, 'slow-run'), '');
  const adapter = new ClaudeCodeAdapter(() => claude);
  const check = await adapter.status(ws);
  const ran = new Promise<RunOutcome>((resolve) => adapter.start(ws, '/gtd-context-analyze CU-2026-0001', resolve, undefined, undefined, check.launch_key));
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[0] === '-p')));
  await service.choose('claude-code', null);
  await assert.rejects(service.signOut('claude-code', work, true), /using this account right now/);
  assert.equal((await calls()).filter((c) => c.args[1] === 'logout').length, 0);
  await fsp.writeFile(path.join(work, 'run-go'), '');
  await ran;
  await service.signOut('claude-code', work, true);
  assert.deepEqual((await calls()).filter((c) => c.args[1] === 'logout').map((c) => c.dir), [work], 'once the run has ended');
});

test('folders whose sign-in or trust files are links are not offered, added or used (finding 10)', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  // A real sibling folder whose settings file links to the default account's trust.
  const borrowed = path.join(home, '.claude-borrowed');
  await fsp.mkdir(borrowed);
  await signedInAs(borrowed, 'borrowed@example.com');
  await fsp.symlink(path.join(home, '.claude.json'), path.join(borrowed, '.claude.json'));
  assert.equal(of(await service.list(), 'claude-code').accounts.some((a) => a.folder === borrowed), false, 'not found');
  await assert.rejects(service.addFolder('claude-code', borrowed), /point somewhere else/);
  // A Codex folder whose sign-in links outside the home folder.
  const outside = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-accounts-outside-')));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'auth.json'), '{}');
  const linked = path.join(home, '.codex-linked');
  await fsp.mkdir(linked);
  await fsp.symlink(path.join(outside, 'auth.json'), path.join(linked, 'auth.json'));
  assert.equal(of(await service.list(), 'codex').accounts.some((a) => a.folder === linked), false);
  await assert.rejects(service.addFolder('codex', linked), /point somewhere else/);
  // Chosen while plain, then its settings replaced by a link: nothing is probed or started there.
  await service.choose('claude-code', work);
  await fsp.rm(path.join(work, '.claude.json'));
  await fsp.symlink(path.join(home, '.claude.json'), path.join(work, '.claude.json'));
  assert.throws(() => runnerEnv(), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  await fsp.rm(log, { force: true });
  assert.deepEqual((await new ClaudeCodeAdapter(() => claude).status(ws)).problems.map((p) => p.code), ['account_folder']);
  assert.equal((await calls()).length, 0, 'not even checked');
});

test('recheck 1: hands-off settings from before confirmations were kept ask for a confirmation before any analysis', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  await trust(work, ws);
  const runner = new AgentRunnerService(new ClaudeCodeAdapter(() => claude));
  const requested: unknown[] = [];
  const spy = { status: () => runner.status(), get: (id: string) => runner.get(id), startAnalysis: (id: string, options?: { queue?: boolean; expect_account?: string }) => { requested.push(options); return runner.startAnalysis(id, options); } };
  const digest = new MeetingDigestService(spy);
  await digest.update({ after_each_meeting: true, auto_analyze: true, account: 'personal@example.com' });
  // As an older version saved it: automatic analysis on, no confirmed account. Then another account is chosen.
  const file = path.join(ws, '.situation-board', 'routines', 'meeting-digest.json');
  const saved = JSON.parse(await fsp.readFile(file, 'utf-8'));
  delete saved.confirmed_account;
  await fsp.writeFile(file, JSON.stringify(saved));
  await service.choose('claude-code', work);
  const m = await digest.createMeeting({ title: 'Fictional sync', meeting_date: '2026-11-20' });
  await digest.addFile(m.id, 'notes.md', Buffer.from('Fictional notes.'));
  await digest.queue(m.id);
  const made = await digest.runNow(new Date('2026-11-20T18:00:00'));
  assert.equal(made.analysis, 'account_changed');
  assert.deepEqual(requested, [], 'no analysis was even requested');
  assert.equal((await digest.readSettings()).confirmed_account, undefined, 'nothing adopted by itself');
  await digest.runIfDue(new Date('2026-11-20T18:05:00'));
  assert.deepEqual(requested, []);
  // Confirmed once: from then on with that account.
  await digest.update({ after_each_meeting: true, auto_analyze: true, account: 'work@example.com' });
  await digest.runIfDue(new Date('2026-11-20T18:10:00'));
  assert.equal(requested.length, 1);
  assert.match((requested[0] as { expect_account?: string }).expect_account ?? '', /^[0-9a-f]{64}$/, 'always with the confirmed account');
  assert.ok(await eventually(async () => !AgentRunnerService.busy()));
});

test('recheck 5: confirming the same account again releases a digest held back by a switch', posix, async (t) => {
  const { claude, ws, service } = await setup(t);
  await trust(work, ws);
  const digest = new MeetingDigestService(new AgentRunnerService(new ClaudeCodeAdapter(() => claude)));
  await digest.update({ after_each_meeting: true, auto_analyze: true, account: 'personal@example.com' });
  const confirmed = (await digest.readSettings()).confirmed_account;
  await service.choose('claude-code', work);
  const m = await digest.createMeeting({ title: 'Fictional sync', meeting_date: '2026-11-20' });
  await digest.addFile(m.id, 'notes.md', Buffer.from('Fictional notes.'));
  await digest.queue(m.id);
  assert.equal((await digest.runNow(new Date('2026-11-20T18:00:00'))).analysis, 'account_changed');
  await service.choose('claude-code', null);
  await fsp.rm(log, { force: true });
  await digest.update({ after_each_meeting: true, auto_analyze: true, account: 'personal@example.com' });
  assert.equal((await digest.readSettings()).confirmed_account, confirmed, 'the same account as before');
  assert.equal((await digest.readState()).analysis, undefined, 'the hold is cleared');
  await digest.runIfDue(new Date('2026-11-20T18:05:00'));
  assert.ok(await eventually(async () => (await calls()).some((c) => c.args[0] === '-p' && c.dir === null)), 'and the digest starts');
  assert.ok(await eventually(async () => !AgentRunnerService.busy()));
});

test('recheck 6: a change for one assistant leaves the other\'s approvals alone', posix, async (t) => {
  const { claude, codex, ws, service } = await setup(t);
  const adapter = new ClaudeCodeAdapter(() => claude);
  const check = await adapter.status(ws);
  const chat = new CodexChatAdapter(() => codex);
  await service.choose('codex', codexWork);
  await new Promise<RunOutcome>((resolve) => adapter.start(ws, '/gtd-context-analyze CU-2026-0001', resolve, undefined, undefined, check.launch_key));
  const codexCheck = await chat.status(ws);
  await service.choose('claude-code', work);
  await service.choose('claude-code', null);
  assert.equal((await chat.status(ws)).launch_key, codexCheck.launch_key, 'a Claude change leaves the Codex approval as it was');
  assert.throws(() => adapter.start(ws, '/gtd-context-analyze CU-2026-0001', () => {}, undefined, undefined, check.launch_key), /changed/, 'its own changes still count');
});

test('recheck 3: shutdown right after a sign-in or sign-out was asked for starts no tool', posix, async (t) => {
  const { service } = await setup(t);
  await fsp.rm(log, { force: true });
  const signingIn = service.startSignIn('claude-code', work, null);
  await stopSignIn();
  await assert.rejects(signingIn, /dashboard is stopping/);
  const signingOut = service.signOut('codex', codexWork, true);
  await stopSignIn();
  await assert.rejects(signingOut, /dashboard is stopping/);
  assert.deepEqual((await calls()).filter((c) => c.args.includes('login') || c.args.includes('logout')), [], 'no sign-in or sign-out tool was started');
  assert.equal(fs.existsSync(path.join(home, '.gtd', 'assistant-sign-in-claude-code.lock')), false, 'and the lock is free');
  await service.startSignIn('claude-code', work, null);
  await service.cancelSignIn();
  assert.ok(await eventually(() => service.signInState()?.ended_at !== null));
});

test('recheck 2: a lock is recovered from a dashboard that is gone, never taken from a live one', posix, async (t) => {
  const { service } = await setup(t);
  const dir = path.join(home, '.gtd');
  const lock = path.join(dir, 'assistant-sign-in-claude-code.lock');
  const mutex = `${lock}.recover`;
  await fsp.mkdir(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' }).stdout;
  const live = String(process.ppid); // another dashboard that is running
  const publish = (pid: string) => { const f = `${lock}.other`; fs.writeFileSync(f, pid); fs.linkSync(f, lock); fs.rmSync(f); };
  t.after(() => { for (const k of Object.keys(lockHooks)) delete lockHooks[k as keyof typeof lockHooks]; });
  const ownedBy = () => fs.readFileSync(lock, 'utf-8');
  const endSignIn = async () => { await service.cancelSignIn(); assert.ok(await eventually(() => !fs.existsSync(lock))); };

  // A live owner: busy, and its lock is never touched.
  publish(live);
  await assert.rejects(service.startSignIn('claude-code', work, null), /Another dashboard/);
  assert.equal(ownedBy(), live);

  // The live owner releases right after our link failed: the lock is free, so this one takes it (no stale busy).
  lockHooks.afterLinkFailed = () => fs.rmSync(lock);
  await service.startSignIn('claude-code', work, null);
  assert.equal(ownedBy(), String(process.pid));
  await endSignIn();
  delete lockHooks.afterLinkFailed;

  // A dead owner, and another dashboard tries to recover it while this one is recovering: it cannot get the recovery
  // mutex, so it cannot remove anything; this one removes the dead lock and takes it.
  publish(dead);
  let otherGotMutex: boolean | null = null;
  lockHooks.underRecovery = () => {
    const f = `${lock}.other-recover`;
    fs.writeFileSync(f, live);
    try { fs.linkSync(f, mutex); otherGotMutex = true; } catch { otherGotMutex = false; }
    fs.rmSync(f);
  };
  await service.startSignIn('claude-code', work, null);
  assert.equal(otherGotMutex, false);
  assert.equal(ownedBy(), String(process.pid), 'exactly one owner');
  await endSignIn();
  delete lockHooks.underRecovery;

  // A dead owner, and another dashboard links its own lock between this one's recovery and its link: that one owns it,
  // this one reports busy. One live owner either way.
  publish(dead);
  lockHooks.afterRecovery = () => publish(live);
  await assert.rejects(service.startSignIn('claude-code', work, null), /Another dashboard/);
  assert.equal(ownedBy(), live, 'their lock stays');
  assert.equal(fs.existsSync(mutex), false, 'the recovery mutex is released');
  delete lockHooks.afterRecovery;

  // A recovery mutex of a live dashboard (perhaps paused while the computer slept) is kept whatever its age: busy.
  fs.rmSync(lock);
  publish(dead);
  fs.writeFileSync(mutex, live);
  const old = new Date(Date.now() - 24 * 3600_000);
  fs.utimesSync(mutex, old, old);
  await assert.rejects(service.startSignIn('claude-code', work, null), /Another dashboard/);
  assert.equal(fs.readFileSync(mutex, 'utf-8'), live, 'a live recovery owner keeps its mutex');
  // One left by a dashboard whose process is gone (it stopped during recovery) is removed, and the lock is recovered.
  fs.writeFileSync(mutex, dead);
  await service.startSignIn('claude-code', work, null);
  assert.equal(ownedBy(), String(process.pid));
  await endSignIn();
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('assistant-sign-in-claude-code.lock')), [], 'no lock, mutex or temporary file left');
});

test('recheck 4: a Codex chat starts only if no sign-in changed while its configuration was read; the account is held meanwhile', posix, async (t) => {
  const { codex, ws, service } = await setup(t);
  const chat = new CodexChatAdapter(() => codex);
  const approved = await chat.status(ws);
  await fsp.writeFile(path.join(codexDefault, 'slow-config'), '');
  await fsp.rm(log, { force: true });
  const opening = chat.open({ workspace: ws, model: null, effort: null, resume: null, instructions: 'Read only.', launch_key: approved.launch_key });
  assert.ok(await eventually(async () => (await calls()).some((c) => c.tool === '.codex' && c.args[0] === 'app-server')), 'reading the configuration');
  await assert.rejects(service.signOut('codex', null, true), /using this account right now/, 'held from before startup');
  // The same folder signs in again (another account) while the configuration is read.
  await service.startSignIn('codex', null, null);
  await fsp.writeFile(path.join(codexDefault, 'login-go'), JSON.stringify({ email: 'other@example.com', plan: 'pro' }));
  assert.ok(await eventually(() => service.signInState()?.status === 'succeeded'));
  await fsp.writeFile(path.join(codexDefault, 'config-go'), '');
  await assert.rejects(opening, /changed while the message was being sent/);
  assert.equal((await calls()).filter((c) => c.tool === '.codex' && c.args[0] === 'app-server').length, 1, 'the chat process itself never started');
  await service.signOut('codex', null, true);
  assert.equal((await calls()).filter((c) => c.args[0] === 'logout').length, 1, 'released on the error path');
});

test('sign-in links, terminal commands and folder names', () => {
  // Finding 8: only each tool's own authorization page, by exact origin and path.
  const claudePages = ['https://claude.ai/oauth/authorize', 'https://claude.com/cai/oauth/authorize', 'https://console.anthropic.com/oauth/authorize'];
  const codexPages = ['https://auth.openai.com/oauth/authorize'];
  assert.equal(signInUrl('visit:\n\u001b]8;;https://x\u0007https://claude.com/cai/oauth/authorize?a=1\u001b]8;;\u0007\n', claudePages), 'https://claude.com/cai/oauth/authorize?a=1');
  assert.equal(signInUrl('http://claude.ai/oauth/authorize https://claude.ai.evil.example/oauth/authorize https://notclaude.ai/oauth/authorize', claudePages), null);
  assert.equal(signInUrl('https://github.com/example/project https://claude.ai/settings https://claude.ai/oauth/authorize/../x', claudePages), null, 'other pages of the same hosts are not shown');
  assert.equal(signInUrl('https://user:pw@claude.ai/oauth/authorize?a=1', claudePages), null);
  assert.equal(signInUrl('https://claude.ai/oauth/authorize?a=1', codexPages), null, 'another tool\'s page is not this tool\'s');
  assert.equal(signInUrl('https://auth.openai.com/oauth/authorize?b=2', codexPages), 'https://auth.openai.com/oauth/authorize?b=2');
  assert.equal(signInUrl('nothing here', claudePages), null);
  assert.equal(terminalCommand('claude-code', null), 'claude auth login');
  assert.equal(terminalCommand('claude-code', '/Users/x/.claude-work', 'sso', 'darwin'), "CLAUDE_CONFIG_DIR='/Users/x/.claude-work' claude auth login --sso");
  assert.equal(terminalCommand('claude-code', "/home/o'neil/.claude-a", 'claudeai', 'linux'), "CLAUDE_CONFIG_DIR='/home/o'\\''neil/.claude-a' claude auth login");
  // Finding 9: PowerShell gets a single-quoted literal, so nothing in a folder name is evaluated.
  assert.equal(terminalCommand('codex', 'C:\\Users\\x\\.codex-work', 'browser', 'win32'), "$env:CODEX_HOME='C:\\Users\\x\\.codex-work'; codex login");
  assert.equal(terminalCommand('claude-code', "C:\\Accounts\\Work$(1+1) O'Neil `$x", 'sso', 'win32'), "$env:CLAUDE_CONFIG_DIR='C:\\Accounts\\Work$(1+1) O''Neil `$x'; claude auth login --sso");
  assert.equal(terminalCommand('claude-code', '/home/x/.claude-$(id)`id`', 'claudeai', 'linux'), "CLAUDE_CONFIG_DIR='/home/x/.claude-$(id)`id`' claude auth login");
  assert.equal(terminalCommand('copilot', null), 'copilot login');
  assert.deepEqual(['Work', 'Équipe Nord', '../..', '', '  ', 'a'.repeat(40)].map(folderSlug), ['work', 'equipe-nord', 'account', 'account', 'account', 'a'.repeat(24)]);
});
