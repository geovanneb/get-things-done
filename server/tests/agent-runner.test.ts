import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentRunnerService, ClaudeCodeAdapter, childEnv, explainOutcome, workspaceTrusted, type AgentRunnerAdapter, type RunOutcome, type StopReason } from '../src/services/agentRunner';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace with one context update; the services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }, status = 'ready'): Promise<string> {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-runner-')));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await setStatus(dir, status);
  return dir;
}

async function setStatus(ws: string, status: string): Promise<void> {
  const dir = path.join(ws, 'context-updates', 'CU-2026-0001');
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', { id: 'CU-2026-0001', status, title: 'Fictional', source_date: '2026-10-28', created_at: '2026-10-28T00:00:00.000Z' }));
}

/** An adapter that runs nothing: the test decides when and how the run ends. */
function fakeAdapter(options: { problems?: { code: 'not_logged_in'; message: string }[]; beforeStatus?: () => Promise<void> } = {}) {
  const calls: { workspace: string; prompt: string }[] = [];
  const stops: StopReason[] = [];
  let finish: ((o: RunOutcome) => void) | null = null;
  const adapter: AgentRunnerAdapter = {
    id: 'fake', label: 'Fake tool',
    status: async () => { await options.beforeStatus?.(); return { id: 'fake', label: 'Fake tool', installed: true, logged_in: true, problems: options.problems ?? [] }; },
    start: (workspace, prompt, done) => {
      calls.push({ workspace, prompt });
      finish = done;
      return { pid: null, stop: async (reason) => { stops.push(reason); done({ exit_code: null, result: null, stderr: '', stopped: reason }); } };
    },
  };
  return { adapter, calls, stops, end: (o: RunOutcome) => finish!(o) };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const success = { exit_code: 0, result: { subtype: 'success', num_turns: 12, total_cost_usd: 0.5, permission_denials: [] }, stderr: '' };

test('outcomes are explained in plain words; success needs both the update and the tool to say so', () => {
  const ok = explainOutcome({ ...success, result: { ...success.result, permission_denials: [{}] } }, 'in_review');
  assert.deepEqual([ok.status, ok.turns, ok.usage_usd, ok.refused], ['succeeded', 12, 0.5, 1]);
  assert.equal(explainOutcome({ exit_code: 1, result: { subtype: 'success', is_error: true }, stderr: '' }, 'in_review').status, 'failed', 'an error at the end is not a clean success');
  assert.match(explainOutcome({ exit_code: 1, result: null, stderr: '' }, 'in_review').message, /Proposals are ready to review, but/);
  assert.match(explainOutcome({ exit_code: 1, result: { result: 'Failed to authenticate: OAuth session expired' }, stderr: '' }, 'ready').message, /sign in again/);
  assert.doesNotMatch(explainOutcome({ exit_code: 1, result: { result: 'The note mentions OAuth scopes' }, stderr: '' }, 'ready').message, /sign in/);
  assert.match(explainOutcome({ exit_code: 1, result: { subtype: 'error_max_turns' }, stderr: '' }, 'analyzing').message, /stopped after 80 steps/);
  for (const [stopped, text] of [['timeout', /30 minutes/], ['api_key', /API key instead of your Claude plan/], ['not_trusted', /trust this folder/], ['shutdown', /dashboard stopped/]] as const) {
    assert.match(explainOutcome({ exit_code: null, result: null, stderr: '', stopped }, 'ready').message, text, stopped);
  }
  assert.equal(explainOutcome({ exit_code: null, result: null, stderr: '', stopped: 'cancelled' }, 'analyzing').status, 'cancelled');
});

test('runs inherit no API key or provider setting, and trust is read from Claude Code\'s own settings', async (t) => {
  const env = childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'fictional', ANTHROPIC_BASE_URL: 'https://x.invalid', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/c' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c' });

  const ws = await workspace(t);
  const config = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-claude-config-'));
  t.after(() => fsp.rm(config, { recursive: true, force: true }));
  const trusted = (projects: Record<string, unknown>) => fsp.writeFile(path.join(config, '.claude.json'), JSON.stringify({ projects }));
  assert.equal(await workspaceTrusted(ws, { CLAUDE_CONFIG_DIR: config }), null, 'unreadable settings: unknown');
  await trusted({ [ws]: { hasTrustDialogAccepted: false } });
  assert.equal(await workspaceTrusted(ws, { CLAUDE_CONFIG_DIR: config }), false);
  await trusted({ [path.dirname(ws)]: { hasTrustDialogAccepted: true } });
  assert.equal(await workspaceTrusted(ws, { CLAUDE_CONFIG_DIR: config }), true, 'a trusted parent folder counts');
});

test('an analysis runs the workspace\'s own command, one at a time, and locks the update while it runs', async (t) => {
  const ws = await workspace(t);
  const fake = fakeAdapter();
  const service = new AgentRunnerService(fake.adapter);
  const updates = new ContextUpdateService();

  const run = await service.startAnalysis('CU-2026-0001');
  assert.equal(run.status, 'running');
  assert.deepEqual(fake.calls, [{ workspace: ws, prompt: '/gtd-context-analyze CU-2026-0001' }], 'exactly what the user would type');
  await assert.rejects(new AgentRunnerService(fake.adapter).startAnalysis('CU-2026-0001'), /Another analysis is running/);
  await assert.rejects(updates.addMaterial('CU-2026-0001', 'more.txt', Buffer.from('x')), /while an analysis is running/);
  await assert.rejects(updates.remove('CU-2026-0001'), /while an analysis is running/);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(ws, '.situation-board', 'runs', 'runner-settings.json'), 'utf-8')), { disableAllHooks: true });

  await setStatus(ws, 'in_review'); // what the command does
  fake.end(success);
  await settle();
  const done = await service.get('CU-2026-0001');
  assert.deepEqual([done?.status, done?.turns, done?.usage_usd], ['succeeded', 12, 0.5]);
  assert.equal(JSON.parse(await fsp.readFile(path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json'), 'utf-8')).status, 'succeeded');
  await updates.reopen('CU-2026-0001'); // unlocked again
  await setStatus(ws, 'in_review');
  await assert.rejects(service.startAnalysis('CU-2026-0001'), /while the update is "in_review"/, 'only a ready update is analyzed');
  await assert.rejects(service.startAnalysis('../x'), /Invalid context update id/);
});

test('startup checks the update again right before launch, and a Stop before launch means it never starts', async (t) => {
  const ws = await workspace(t);
  const changed = fakeAdapter({ beforeStatus: () => setStatus(ws, 'in_review') });
  await assert.rejects(new AgentRunnerService(changed.adapter).startAnalysis('CU-2026-0001'), /while the update is "in_review"/);
  assert.equal(changed.calls.length, 0);

  await setStatus(ws, 'ready');
  let release!: () => void;
  const slow = fakeAdapter({ beforeStatus: () => new Promise((r) => { release = r; }) });
  const service = new AgentRunnerService(slow.adapter);
  const starting = service.startAnalysis('CU-2026-0001');
  await settle();
  const cancelling = service.cancel('CU-2026-0001');
  release();
  await starting.catch(() => {});
  await cancelling;
  assert.equal(slow.calls.length, 0, 'never launched');
  assert.equal((await service.get('CU-2026-0001'))?.status, 'cancelled');

  const notSignedIn = fakeAdapter({ problems: [{ code: 'not_logged_in', message: 'Claude Code is not signed in.' }] });
  await assert.rejects(new AgentRunnerService(notSignedIn.adapter).startAnalysis('CU-2026-0001'), /not signed in/);
  assert.equal(notSignedIn.calls.length, 0);
});

test('a stopped or interrupted run says what to do, and a failed final save does not crash the dashboard', async (t) => {
  const ws = await workspace(t);
  const fake = fakeAdapter();
  const service = new AgentRunnerService(fake.adapter);
  await service.startAnalysis('CU-2026-0001');
  await setStatus(ws, 'analyzing');
  await service.cancel('CU-2026-0001');
  const stopped = await service.get('CU-2026-0001');
  assert.equal(stopped?.status, 'cancelled');
  assert.match(stopped!.message, /go back to collecting/);
  assert.deepEqual(fake.stops, ['cancelled']);
  await assert.rejects(service.cancel('CU-2026-0001'), /No analysis is running/);

  const file = path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json');
  // A later run recorded as running (as left by a dashboard that stopped), not the one this dashboard saw end.
  const later = new Date(Date.now() + 1000).toISOString();
  await fsp.writeFile(file, JSON.stringify({ ...stopped, started_at: later, status: 'running', ended_at: null, pid: null }));
  assert.match((await service.get('CU-2026-0001'))!.message, /dashboard stopped/);
  await fsp.writeFile(file, JSON.stringify({ ...stopped, started_at: later, status: 'running', ended_at: null, pid: process.pid }));
  assert.match((await service.get('CU-2026-0001'))!.message, /may still be going/, 'a run whose process is alive is not reported as over');
  await setStatus(ws, 'ready');
  await assert.rejects(service.startAnalysis('CU-2026-0001'), /may still be going/);

  await fsp.rm(file);
  await service.startAnalysis('CU-2026-0001');
  await fsp.rm(path.join(ws, '.situation-board', 'runs'), { recursive: true });
  await fsp.writeFile(path.join(ws, '.situation-board', 'runs'), 'not a folder'); // the record cannot be saved now
  fake.end(success);
  await settle();
  assert.equal((await service.get('CU-2026-0001'))?.status, 'failed', 'the outcome is kept in memory, and the next run is possible');
});

/** A stand-in for the Claude Code CLI. `script` runs for the analysis; `auth` answers `auth status`. */
async function fakeCli(ws: string, auth: string, script: string): Promise<string> {
  const bin = path.join(ws, 'fake-claude');
  await fsp.writeFile(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { ${auth} }
fs.writeFileSync(${JSON.stringify(path.join(ws, 'seen.json'))}, JSON.stringify({ args, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null }));
${script}
`, { mode: 0o755 });
  return bin;
}

const posix = { skip: process.platform === 'win32' };
const signedIn = `process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0);`;
const trust = async (ws: string) => {
  const config = path.join(ws, 'claude-config');
  await fsp.mkdir(config, { recursive: true });
  await fsp.writeFile(path.join(config, '.claude.json'), JSON.stringify({ projects: { [ws]: { hasTrustDialogAccepted: true } } }));
  return config;
};

test('the Claude Code adapter checks sign-in, plan, workspace settings and trust before anything runs', posix, async (t) => {
  const ws = await workspace(t);
  const config = await trust(ws);
  const env = () => childEnv({ PATH: process.env.PATH, HOME: ws, CLAUDE_CONFIG_DIR: config });
  const codes = async (a: ClaudeCodeAdapter) => (await a.status(ws)).problems.map((p) => p.code);

  assert.deepEqual(await codes(new ClaudeCodeAdapter(() => null, env)), ['not_installed']);
  const bin = await fakeCli(ws, signedIn, '');
  assert.deepEqual(await codes(new ClaudeCodeAdapter(() => bin, env)), []);
  const api = await fakeCli(ws, `process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'apiKey' })); process.exit(0);`, '');
  assert.deepEqual(await codes(new ClaudeCodeAdapter(() => api, env)), ['not_subscription']);
  const out = await fakeCli(ws, `process.stdout.write(JSON.stringify({ loggedIn: false })); process.exit(0);`, '');
  assert.deepEqual(await codes(new ClaudeCodeAdapter(() => out, env)), ['not_logged_in']);
  const hung = await fakeCli(ws, `process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);`, '');
  const started = Date.now();
  assert.deepEqual(await codes(new ClaudeCodeAdapter(() => hung, env, 300)), ['auth_unknown'], 'a hung check ends at its deadline');
  assert.ok(Date.now() - started < 3000);

  const fine = await fakeCli(ws, signedIn, '');
  await fsp.mkdir(path.join(ws, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fictional' } }));
  assert.deepEqual(await codes(new ClaudeCodeAdapter(() => fine, env)), ['workspace_auth']);
  await fsp.rm(path.join(ws, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(config, '.claude.json'), JSON.stringify({ projects: {} }));
  assert.deepEqual(await codes(new ClaudeCodeAdapter(() => fine, env)), ['not_trusted']);
});

test('the adapter runs the CLI headless with the workspace\'s own settings and no API key', posix, async (t) => {
  const ws = await workspace(t);
  process.env.ANTHROPIC_API_KEY = 'fictional-key';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const bin = await fakeCli(ws, signedIn, `
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.1, permission_denials: [] }));`);
  const outcome = await new Promise<RunOutcome>((resolve) => new ClaudeCodeAdapter(() => bin).start(ws, '/gtd-context-analyze CU-2026-0001', resolve));
  assert.equal(outcome.exit_code, 0);
  assert.equal(outcome.result?.num_turns, 3, 'a last line without a newline is read too');
  const seen = JSON.parse(await fsp.readFile(path.join(ws, 'seen.json'), 'utf-8'));
  assert.equal(await fsp.realpath(seen.cwd), ws);
  assert.equal(seen.apiKey, null, 'the inherited API key is not passed on');
  assert.deepEqual(seen.args.slice(0, 6), ['-p', '/gtd-context-analyze CU-2026-0001', '--setting-sources', 'project', '--permission-mode', 'dontAsk']);
  assert.ok(seen.args.includes('--strict-mcp-config'), 'no MCP servers');
  assert.equal(seen.args[seen.args.indexOf('--settings') + 1], path.join(ws, '.situation-board', 'runs', 'runner-settings.json'));
  assert.equal((parseMarkdown(await fsp.readFile(path.join(ws, 'context-updates', 'CU-2026-0001', 'update.md'), 'utf-8')).data as Record<string, unknown>)['status'], 'ready', 'the adapter itself changes nothing');
});

test('a run that reports an API key or an untrusted folder is stopped at once, and Stop ends everything it started', posix, async (t) => {
  const ws = await workspace(t);
  const slow = `setTimeout(() => {}, 60000);`;
  const apiKey = await fakeCli(ws, signedIn, `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }) + '\\n'); ${slow}`);
  const a = await new Promise<RunOutcome>((resolve) => new ClaudeCodeAdapter(() => apiKey).start(ws, '/gtd-context-analyze CU-2026-0001', resolve));
  assert.equal(a.stopped, 'api_key');

  const untrusted = await fakeCli(ws, signedIn, `process.stderr.write('Ignoring 8 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.\\n'); ${slow}`);
  const u = await new Promise<RunOutcome>((resolve) => new ClaudeCodeAdapter(() => untrusted).start(ws, '/gtd-context-analyze CU-2026-0001', resolve));
  assert.equal(u.stopped, 'not_trusted');

  const pids = path.join(ws, 'child.pid');
  const tree = await fakeCli(ws, signedIn, `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(${JSON.stringify(pids)}, String(child.pid));
process.on('SIGTERM', () => {});
${slow}`);
  let resolveDone!: (o: RunOutcome) => void;
  const finished = new Promise<RunOutcome>((r) => { resolveDone = r; });
  const handle = new ClaudeCodeAdapter(() => tree).start(ws, '/gtd-context-analyze CU-2026-0001', resolveDone);
  for (let i = 0; i < 50 && !(await fsp.access(pids).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 50));
  const childPid = Number(await fsp.readFile(pids, 'utf-8'));
  await handle.stop('cancelled');
  const outcome = await finished;
  assert.equal(outcome.stopped, 'cancelled');
  const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && isAlive(childPid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(isAlive(childPid), false, 'a process the run started (even one ignoring SIGTERM, holding the pipes) is gone too');
});

test('while a run is going, or a run from before a restart still is, the update cannot be closed, approved or deleted', async (t) => {
  const ws = await workspace(t, 'in_review');
  const updates = new ContextUpdateService();
  const fake = fakeAdapter();
  await setStatus(ws, 'ready');
  const service = new AgentRunnerService(fake.adapter);
  await service.startAnalysis('CU-2026-0001');
  await setStatus(ws, 'in_review'); // the command has written its proposals but is still running
  await assert.rejects(updates.close('CU-2026-0001'), /while an analysis is running/);
  await assert.rejects(updates.approve('CU-2026-0001'), /while an analysis is running/);
  await service.cancel('CU-2026-0001');

  const file = path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json');
  await fsp.writeFile(file, JSON.stringify({ update_id: 'CU-2026-0001', status: 'running', started_at: new Date().toISOString(), pid: process.pid }));
  await assert.rejects(updates.remove('CU-2026-0001'), /while an analysis is running/, 'a run that outlived a restart still protects the update');
});

test('the ended state wins over a "running" record left on disk, and a fast exit is never overwritten by a late save', posix, async (t) => {
  const ws = await workspace(t);
  const fake = fakeAdapter();
  const service = new AgentRunnerService(fake.adapter);
  await service.startAnalysis('CU-2026-0001');
  const runs = path.join(ws, '.situation-board', 'runs');
  await fsp.chmod(runs, 0o555); // the final save fails, the earlier "running" record stays readable
  t.after(() => fsp.chmod(runs, 0o755).catch(() => {}));
  await setStatus(ws, 'in_review');
  fake.end(success);
  await settle();
  assert.equal((await service.get('CU-2026-0001'))?.status, 'succeeded');
  await fsp.chmod(runs, 0o755);

  // A tool that ends while the runner is still saving that it started.
  await setStatus(ws, 'ready');
  const instant: AgentRunnerAdapter = {
    ...fake.adapter,
    start: (_w, _p, done) => { setStatus(ws, 'in_review').then(() => done(success)); return { pid: 4242, stop: async () => {} }; },
  };
  const fast = new AgentRunnerService(instant);
  await fast.startAnalysis('CU-2026-0001');
  await new Promise((r) => setTimeout(r, 100));
  const record = JSON.parse(await fsp.readFile(path.join(runs, 'CU-2026-0001.json'), 'utf-8'));
  assert.equal(record.status, 'succeeded', 'the late "running" save did not land after the end');
});

test('stream lines that are not message objects are ignored, and a failed sign-in check start is reported, not thrown', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await fakeCli(ws, signedIn, `
process.stdout.write('null\\n5\\n[1]\\n"text"\\n');
process.stderr.write('Ignoring rules: this workspace has not been ');
setTimeout(() => {
  process.stderr.write('trusted.\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2 }) + '\\n'), 3000);
}, 100);
setTimeout(() => {}, 60000);`);
  const outcome = await new Promise<RunOutcome>((resolve) => new ClaudeCodeAdapter(() => bin).start(ws, '/gtd-context-analyze CU-2026-0001', resolve));
  assert.equal(outcome.stopped, 'not_trusted', 'a warning split across chunks is still seen');

  const throwing = new ClaudeCodeAdapter(() => bin, () => { throw new Error('no environment'); });
  assert.ok((await throwing.status(ws)).problems.some((p) => p.code === 'auth_unknown'));
});
