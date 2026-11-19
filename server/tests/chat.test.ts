import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { existsSync, promises } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeChatAdapter, claudeLimits, claudeModels, conversationArgs, modelProbeArgs } from '../src/services/chat/claude';
import { CodexChatAdapter, codexEnv, codexHooksProblem, codexLaunchArgs, codexLimits, codexServersOn, codexThreadSettings, codexTurnError, refuse } from '../src/services/chat/codex';
import { CopilotChatAdapter, copilotArgs, copilotEnv, copilotLockdownProblem, copilotModels, copilotScan, parseJsonc, refusePermission } from '../src/services/chat/copilot';
import { ChatService, CHAT_INSTRUCTIONS, carryOverText, composePrompt, normalize, titleFrom, type Conversation } from '../src/services/chat/chatService';
import { classifyError, type ChatAdapter, type ChatEvent, type ChatOpenOptions, type ChatProviderId, type ChatSession, type ProviderStatus, type TurnOutcome } from '../src/services/chat/types';
import { childEnv, runnerSettingsFile } from '../src/services/agentRunner';
import { errorHandler } from '../src/middleware/errorHandler';
import { applyStreamEvent, newerOf } from '../../ui/src/utils/chat';

/** A throwaway fictional workspace; the services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-chat-')));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'tasks', 'TASK-2026-0001'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'tasks', 'TASK-2026-0001', 'task.md'), '---\nid: TASK-2026-0001\ntitle: Fictional budget review\n---\n');
  t.after(async () => {
    await ChatService.stopAll();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 15))) if (await check()) return true;
  return check();
}

const posix = { skip: process.platform === 'win32' };

/** Sends one message to a real adapter session and collects everything until its end. */
/** Real tool processes left by a failed test are ended, so the test run can exit. */
const opened: ChatSession[] = [];
function track<T extends ChatSession>(session: T): T { opened.push(session); return session; }
test.afterEach(async () => { await Promise.all(opened.splice(0).map((s) => s.close().catch(() => {}))); });

function ask(session: ChatSession, text: string): Promise<{ text: string; events: ChatEvent[]; outcome: TurnOutcome }> {
  return new Promise((resolve) => {
    let out = '';
    const events: ChatEvent[] = [];
    session.send(text, (e) => {
      events.push(e);
      if (e.type === 'text') out += e.text;
      if (e.type === 'end') resolve({ text: out, events, outcome: e.outcome });
    });
  });
}

async function script(dir: string, name: string, body: string): Promise<string> {
  const bin = path.join(dir, name);
  await fsp.writeFile(bin, `#!/usr/bin/env node\n'use strict';\nconst fs = require('fs');\nconst SEEN = ${JSON.stringify(path.join(dir, `${name}.seen.jsonl`))};\nconst seen = (x) => fs.appendFileSync(SEEN, JSON.stringify(x) + '\\n');\n${body}\n`, { mode: 0o755 });
  return bin;
}

async function seenOf(dir: string, name: string): Promise<Record<string, unknown>[]> {
  const raw = await fsp.readFile(path.join(dir, `${name}.seen.jsonl`), 'utf-8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------- pure helpers

/** What `copilot --help` lists of the options the chat's lock-down needs. */
const REQUIRED_HELP = '--available-tools --deny-tool --disable-builtin-mcps --disable-mcp-server --no-experimental --no-ask-user';

test('errors are classified for what the user can do: sign in again, wait for the plan, start a new chat', () => {
  assert.equal(classifyError('Failed to authenticate. API Error: 401 OAuth token has expired'), 'sign_in');
  assert.equal(classifyError('Authentication required'), 'sign_in');
  assert.equal(classifyError("You've hit your weekly limit · resets 2am (UTC)"), 'plan_limit');
  assert.equal(classifyError('You have reached your premium requests quota'), 'plan_limit');
  assert.equal(classifyError('Prompt is too long'), 'context_full');
  assert.equal(classifyError('No conversation found with session ID: x'), 'resume_failed');
  assert.equal(classifyError('no rollout found for thread id x'), 'resume_failed');
  // A server slowing down is not the plan: waiting for a reset would not help.
  assert.equal(classifyError('Rate limited by the server, this is not your usage limit'), 'provider');
  assert.equal(classifyError('API Error: 529 Overloaded'), 'provider');
  assert.equal(classifyError('', 'crashed'), 'crashed');
});

test('usage windows and models are read from what each tool reports', () => {
  assert.deepEqual(claudeLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.53, resetsAt: 1794991800, status: 'allowed' }, seven_day: { utilization: 1, resetsAt: 1795348800, status: 'rejected' } } }), [
    { kind: 'five_hour', used_percent: 53, resets_at: new Date(1794991800 * 1000).toISOString(), limited: false },
    { kind: 'weekly', used_percent: 100, resets_at: new Date(1795348800 * 1000).toISOString(), limited: true },
  ]);
  assert.equal(claudeLimits('nonsense'), null);
  assert.deepEqual(claudeModels([{ value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'high'] }, { value: '' }, 'x']).map((m) => [m.id, m.is_default, m.efforts.length]), [['default', true, 2]]);
  const limits = codexLimits({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1795001148 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1795563279 } } });
  assert.deepEqual(limits?.map((w) => [w.kind, w.used_percent, w.limited]), [['five_hour', 12, false], ['weekly', 100, true]]);
  assert.deepEqual(codexTurnError({ message: 'x', codexErrorInfo: 'contextWindowExceeded' }).code, 'context_full');
  assert.deepEqual(codexTurnError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }, '2026-11-20T00:00:00.000Z'), { code: 'plan_limit', detail: 'x', resets_at: '2026-11-20T00:00:00.000Z' });
  assert.deepEqual(codexTurnError({ message: 'x', codexErrorInfo: 'unauthorized' }).code, 'sign_in');
  assert.deepEqual(copilotModels({ models: { availableModels: [{ modelId: 'm1', name: 'Model one' }, { modelId: '' }], currentModelId: 'm1' } }).map((m) => [m.id, m.is_default]), [['m1', true]]);
  assert.deepEqual(copilotModels({ configOptions: [{ id: 'model', category: 'model', currentValue: 'b', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }] }).map((m) => [m.id, m.is_default]), [['a', false], ['b', true]]);
});

test('approvals and permission questions from the tools are always refused', () => {
  assert.deepEqual(refuse('item/commandExecution/requestApproval'), { decision: 'decline' });
  assert.deepEqual(refuse('item/fileChange/requestApproval'), { decision: 'decline' });
  assert.deepEqual(refuse('execCommandApproval'), { decision: 'denied' });
  assert.equal(refuse('something/else'), undefined, 'an unknown request is answered with an error, never a yes');
  assert.deepEqual(refusePermission({ options: [{ optionId: 'yes', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }] }), { outcome: { outcome: 'selected', optionId: 'no' } });
  assert.deepEqual(refusePermission({ options: [{ optionId: 'yes', kind: 'allow_once' }] }), { outcome: { outcome: 'cancelled' } }, 'with no way to say no, the question is cancelled');
});

test('environments lose every variable that would bill another account instead of the plan', () => {
  const base = { PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CODEX_API_KEY: 'k', COPILOT_PROVIDER_BASE_URL: 'http://x', COPILOT_PROVIDER_API_KEY: 'k', COPILOT_ALLOW_ALL: 'true', GH_TOKEN: 'user-sign-in' };
  assert.equal(childEnv(base)['ANTHROPIC_API_KEY'], undefined);
  const codex = codexEnv(base);
  assert.equal(codex['OPENAI_API_KEY'], undefined);
  assert.equal(codex['CODEX_API_KEY'], undefined);
  const copilot = copilotEnv(base);
  assert.equal(copilot['COPILOT_PROVIDER_BASE_URL'], undefined);
  assert.equal(copilot['COPILOT_PROVIDER_API_KEY'], undefined);
  assert.equal(copilot['COPILOT_ALLOW_ALL'], undefined, 'allow-all would let it write');
  assert.equal(copilot['GH_TOKEN'], 'user-sign-in', 'the GitHub sign-in itself stays');
  assert.equal(copilotEnv({ ...base, GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: 'true', GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true' })['GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS'], undefined, 'opt-ins that load a folder\'s hooks are removed');
  assert.equal(copilot['COPILOT_PLUGIN_DIR_ONLY'], 'true', 'no installed plugin (with its hooks and MCP servers) is loaded');
});

test('Copilot is offered only its read tools, denied shell, writes, URLs and memory, and every MCP server it would start is off', async (t) => {
  const ws = await workspace(t);
  const home = path.join(ws, 'copilot-home');
  await fsp.mkdir(home, { recursive: true });
  // Any name Copilot accepts is passed on, as one argument each and never through a shell.
  await fsp.writeFile(path.join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { 'fictional-crm': {}, 'fictional/search': {}, 'with space': {}, 'ünïcode': {}, '-dash': {}, 'odd(name)': {} } }));
  // The workspace's own MCP files (Copilot loads them once the folder is trusted) are turned off too.
  await fsp.writeFile(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { 'project-notes': {} } }));
  await fsp.mkdir(path.join(ws, '.github'), { recursive: true });
  await fsp.writeFile(path.join(ws, '.github', 'mcp.json'), JSON.stringify({ mcpServers: { 'project-tracker': {}, 'fictional-crm': {} } }));
  assert.deepEqual(copilotArgs({ COPILOT_HOME: home }, ws, 'gpt-x', 'low'), [
    '--acp', '--stdio', '--disable-builtin-mcps', '--disallow-temp-dir', '--no-ask-user', '--no-experimental',
    '--available-tools=view,grep,glob',
    '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url', '--deny-tool=memory',
    '--disable-mcp-server=fictional-crm', '--deny-tool=fictional-crm',
    '--disable-mcp-server=fictional/search', '--deny-tool=fictional/search',
    '--disable-mcp-server=with space',
    '--disable-mcp-server=ünïcode',
    '--disable-mcp-server=-dash', '--deny-tool=-dash',
    '--disable-mcp-server=odd(name)',
    '--disable-mcp-server=project-notes', '--deny-tool=project-notes',
    '--disable-mcp-server=project-tracker', '--deny-tool=project-tracker',
    '--model', 'gpt-x', '--effort', 'low',
  ], 'a name Copilot would not read as a deny rule gets none (it refuses to start on one): the allow-list covers it');
  assert.deepEqual(copilotScan({ COPILOT_HOME: home }, null).servers, ['fictional-crm', 'fictional/search', 'with space', 'ünïcode', '-dash', 'odd(name)'], 'without a workspace, the user\'s servers are still off');
});

test('Copilot settings are read as JSON with comments, as Copilot reads them', () => {
  assert.deepEqual(parseJsonc('{\n  // personal\n  "a": "x // not a comment", /* block */ "b": [1, 2,],\n  "c": "quote \\" /* still text */",\n}\n'), { a: 'x // not a comment', b: [1, 2], c: 'quote " /* still text */' });
  assert.deepEqual(parseJsonc('{"a": 1, // trailing\n}'), { a: 1 });
  assert.deepEqual(parseJsonc('\ufeff{"disableAllHooks": true}'), { disableAllHooks: true }, 'a byte order mark, as Windows editors save it');
  assert.deepEqual(parseJsonc('{\r  // CR line endings\r  "disableAllHooks": true\r}\r'), { disableAllHooks: true }, 'CR ends a line comment');
  assert.deepEqual(parseJsonc('{\r\n  "a": 1, // CRLF\r\n  "b": [2, /* last */],\r\n}'), { a: 1, b: [2] }, 'CRLF, and trailing commas followed by comments');
  assert.deepEqual(parseJsonc('{"a": [1, // after the comma\n], }'), { a: [1] });
  assert.throws(() => parseJsonc('{"a": 1 /* unclosed'));
  assert.throws(() => parseJsonc('{"a": }'));
});

test('Copilot is not used while hooks are set up that it would run, its configuration cannot be read, or it lacks an option', async (t) => {
  const ws = await workspace(t);
  const home = path.join(ws, 'copilot-home');
  const env = { COPILOT_HOME: home };
  const help = REQUIRED_HELP;
  const scan = () => copilotScan(env, ws);
  assert.deepEqual(scan(), { servers: [], hooks: [], unreadable: [] });
  assert.equal(copilotLockdownProblem(help, scan(), ws), null);
  assert.match(copilotLockdownProblem(help.replace('--available-tools', ''), scan(), ws)!, /cannot be limited to reading files/);
  assert.match(copilotLockdownProblem(null, scan(), ws)!, /cannot be limited to reading files/, 'a version whose options cannot be read is not used');
  // Each place Copilot reads hooks from; a settings file that turns its hooks off does not count.
  const hook = { hooks: { sessionStart: [{ type: 'command', bash: 'true' }] } };
  await fsp.mkdir(path.join(home, 'hooks'), { recursive: true });
  for (const dir of [['.github', 'hooks'], ['.github', 'copilot'], ['.claude']]) await fsp.mkdir(path.join(ws, ...dir), { recursive: true });
  await fsp.writeFile(path.join(home, 'settings.json'), JSON.stringify({ ...hook, disableAllHooks: true }));
  await fsp.writeFile(path.join(home, 'hooks', 'empty.json'), JSON.stringify({ version: 1, hooks: {} }));
  await fsp.writeFile(path.join(ws, '.github', 'copilot', 'settings.json'), '{\n  // the repository turns its own hooks off\n  "disableAllHooks": true,\n  "hooks": {"sessionStart": [{"type": "command", "bash": "true"}]},\n}\n');
  await fsp.writeFile(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ ...hook, disableAllHooks: true }));
  assert.deepEqual(scan().hooks, [], 'hooks a file turns off itself, and an empty hooks file, do not count');
  // Settings with comments are read the way Copilot reads them: the hook is found.
  await fsp.writeFile(path.join(home, 'settings.json'), '{\n  // personal settings\n  "hooks": {"sessionStart": [{"type": "command", "bash": "true"}]},\n}\n');
  await fsp.writeFile(path.join(home, 'hooks', 'user.json'), JSON.stringify({ version: 1, ...hook }));
  await fsp.writeFile(path.join(ws, '.github', 'hooks', 'repo.json'), JSON.stringify({ version: 1, ...hook }));
  await fsp.writeFile(path.join(ws, '.github', 'copilot', 'settings.local.json'), JSON.stringify(hook));
  await fsp.writeFile(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ permissions: {}, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
  assert.deepEqual(scan().hooks.map((f) => path.relative(ws, f)), [
    path.join('copilot-home', 'settings.json'), path.join('copilot-home', 'hooks', 'user.json'),
    path.join('.github', 'hooks', 'repo.json'), path.join('.github', 'copilot', 'settings.local.json'), path.join('.claude', 'settings.json'),
  ]);
  assert.match(copilotLockdownProblem(help, scan(), ws)!, /would run the hooks set up in .*\.github[\\/]hooks[\\/]repo\.json/);
  // A file that exists but cannot be read: what it sets up is unknown, so Copilot is not used.
  await fsp.writeFile(path.join(ws, '.mcp.json'), '{ "mcpServers": { broken');
  assert.deepEqual(scan().unreadable, [path.join(ws, '.mcp.json')]);
  assert.match(copilotLockdownProblem(help, scan(), ws)!, /configuration in \.mcp\.json could not be read/);
  // A server name no command line can carry is refused, not left out.
  assert.match(copilotLockdownProblem(help, { servers: ['bad\nname'], hooks: [], unreadable: [] }, ws)!, /cannot be passed to it/);
  assert.match(copilotLockdownProblem(help, { servers: ['50%'], hooks: [], unreadable: [] }, ws, true)!, /cannot be passed to it/, 'through cmd.exe on Windows');
  assert.equal(copilotLockdownProblem(help, { servers: ['50%'], hooks: [], unreadable: [] }, ws, false), null);
});

test('Copilot\'s inline hooks are judged as Copilot runs them: a trusted workspace\'s disableAllHooks covers personal hooks too', async (t) => {
  const ws = await workspace(t);
  const home = path.join(ws, 'copilot-home');
  const env = { COPILOT_HOME: home };
  const hook = { hooks: { sessionStart: [{ type: 'command', bash: 'true' }] } };
  await fsp.mkdir(path.join(ws, '.github', 'copilot'), { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  const personal = path.join(home, 'settings.json');
  const repo = path.join(ws, '.github', 'copilot', 'settings.json');
  const trust = (on: boolean) => fsp.writeFile(path.join(home, 'config.json'), on ? `// managed by Copilot\n{"trustedFolders": [${JSON.stringify(path.dirname(ws))}],}` : '{}');
  await fsp.writeFile(personal, JSON.stringify(hook));
  await fsp.writeFile(repo, '{\n  // the repository turns hooks off\n  "disableAllHooks": true,\n}\n');
  await trust(true);
  assert.deepEqual(copilotScan(env, ws).hooks, [], 'trusted (here through a parent folder): the repository setting turns the personal hooks off');
  await trust(false);
  assert.deepEqual(copilotScan(env, ws).hooks, [personal], 'not trusted: Copilot does not read the repository settings, so the personal hook runs');
  await trust(true);
  await fsp.writeFile(path.join(ws, '.github', 'copilot', 'settings.local.json'), JSON.stringify({ disableAllHooks: false }));
  assert.deepEqual(copilotScan(env, ws).hooks, [personal], 'a repository file that turns hooks back on: not counted as off');
  await fsp.rm(path.join(ws, '.github', 'copilot', 'settings.local.json'));
  // A personal disableAllHooks turns off only the personal settings' hooks.
  await fsp.writeFile(personal, JSON.stringify({ ...hook, disableAllHooks: true }));
  await fsp.writeFile(repo, JSON.stringify(hook));
  assert.deepEqual(copilotScan(env, ws).hooks, [repo]);
  // Hook files run whatever the settings say.
  await fsp.writeFile(repo, JSON.stringify({ disableAllHooks: true }));
  await fsp.mkdir(path.join(home, 'hooks'), { recursive: true });
  await fsp.writeFile(path.join(home, 'hooks', 'h.json'), JSON.stringify({ version: 1, ...hook }));
  assert.deepEqual(copilotScan(env, ws).hooks, [path.join(home, 'hooks', 'h.json')]);
});

test('Copilot reads a workspace\'s configuration up to its repository root, however deep the workspace is', async (t) => {
  const ws = await workspace(t);
  let deep = ws;
  for (let i = 0; i < 70; i++) deep = path.join(deep, `d${i}`);
  await fsp.mkdir(path.join(ws, '.git'), { recursive: true });
  await fsp.mkdir(deep, { recursive: true });
  await fsp.writeFile(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { 'repo-root-server': {} } }));
  assert.deepEqual(copilotScan({ COPILOT_HOME: path.join(ws, 'none') }, deep).servers, ['repo-root-server']);
});

test('prompts carry the page and, when no session has them, the earlier messages, newest kept', () => {
  assert.equal(composePrompt('What is late?', {}), 'What is late?');
  assert.match(composePrompt('Summarize it', { page: '/board/task/TASK-2026-0001' }), /^\(I am on this dashboard page: \/board\/task\/TASK-2026-0001\)\n\nSummarize it$/);
  const messages = [
    { id: '1', role: 'user' as const, text: 'old '.repeat(100), created_at: '' },
    { id: '2', role: 'notice' as const, text: '', created_at: '' },
    { id: '3', role: 'assistant' as const, text: 'newest answer', created_at: '' },
  ];
  assert.equal(carryOverText(messages, 30), 'Assistant: newest answer');
  assert.match(carryOverText(messages), /^User: old .*\nAssistant: newest answer$/s);
  assert.equal(titleFrom('  What is due\n this week?  '), 'What is due this week?');
  assert.equal(titleFrom('x'.repeat(100)).length, 60);
});

test('a conversation saved while it streamed is read back as stopped; anything unexpected is dropped', () => {
  const c = normalize({ provider: 'codex', messages: [{ id: 'a', role: 'assistant', text: 'half', status: 'streaming' }, { id: 'b', role: 'system', text: 'x' }, 'junk'], provider_session: { provider: 'evil', id: 'x' } }, 'chat-abcdefgh01');
  assert.equal(c?.messages.length, 1);
  assert.equal(c?.messages[0]?.status, 'stopped');
  assert.equal(c?.provider_session, null);
  assert.equal(normalize({ provider: 'unknown' }, 'chat-abcdefgh01'), null);
});

// ---------------------------------------------------------------- Claude Code, with a fake `claude`

const FAKE_CLAUDE = String.raw`
const args = process.argv.slice(2);
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'someone@example.com' })); process.exit(0); }
const si = args.indexOf('--settings');
seen({ args, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null, settings: si >= 0 ? fs.readFileSync(args[si + 1], 'utf-8') : null });
const ri = args.indexOf('--resume');
if (ri >= 0 && args[ri + 1] === 'missing') { process.stderr.write('No conversation found with session ID: missing\n'); process.exit(1); }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let slow = false;
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') return out({ type: 'control_response', response: { response: { models: [{ value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'high'] }, { value: 'haiku', displayName: 'Haiku' }] } } });
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') { if (slow) out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-1' }); return; }
  if (m.type !== 'user') return;
  const text = m.message.content;
  seen({ prompt: text });
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fictional', apiKeySource: text === 'apikey' ? 'ANTHROPIC_API_KEY' : 'none' });
  if (text === 'apikey') return;
  if (text === 'expire') { process.stderr.write('Failed to authenticate. API Error: 401 OAuth token has expired\n'); process.exit(1); }
  if (text === 'limit') return out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets 2am", session_id: 'sess-1' });
  out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1794991800, status: 'allowed' } } }, session_id: 'sess-1' });
  out({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null, session_id: 'sess-1' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Due ' } }, parent_tool_use_id: null, session_id: 'sess-1' });
  if (text === 'slow') { slow = true; return; }
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Friday.' } }, parent_tool_use_id: null, session_id: 'sess-1' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'tasks/TASK-2026-0001/task.md' } }, { type: 'text', text: 'Due Friday.' }], usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 90 } }, parent_tool_use_id: null, session_id: 'sess-1' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Due Friday.', session_id: 'sess-1', modelUsage: { 'claude-fictional': { contextWindow: 200000 } } });
});
`;

function claude(ws: string, bin: string): ClaudeChatAdapter {
  return new ClaudeChatAdapter(() => bin, () => childEnv({ PATH: process.env.PATH, HOME: ws, CLAUDE_CONFIG_DIR: path.join(ws, 'claude-config'), ANTHROPIC_API_KEY: 'should-be-removed' }));
}
const open = (ws: string, extra: Partial<ChatOpenOptions> = {}): ChatOpenOptions => ({ workspace: ws, model: null, effort: null, resume: null, instructions: CHAT_INSTRUCTIONS, ...extra });

test('Claude Code chats read-only, on the plan only, with no MCP servers, and streams the answer', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'claude', FAKE_CLAUDE);
  const adapter = claude(ws, bin);
  const status = await adapter.status(ws);
  assert.equal(status.ready, true, 'folder trust is not needed for a read-only chat');
  assert.equal(status.plan, 'pro');
  assert.deepEqual(status.models.map((m) => m.id), ['default', 'haiku']);
  assert.ok(!JSON.stringify(status).includes('someone@example.com'), 'the account email never reaches the page');
  // Regression: a workspace that never ran an analysis has no .situation-board/runs yet.
  assert.equal(existsSync(path.join(ws, '.situation-board', 'runs')), false);
  const session = track(await adapter.open(open(ws, { model: 'haiku', effort: 'low' })));
  const r = await ask(session, 'hello');
  assert.equal(r.text, 'Due Friday.', 'the text arrives once, streamed, not again with the whole message');
  assert.deepEqual(r.outcome, { status: 'done' });
  assert.equal(session.sessionId, 'sess-1');
  const step = r.events.find((e) => e.type === 'step');
  assert.deepEqual(step && step.type === 'step' ? step.step : null, { kind: 'read', path: 'tasks/TASK-2026-0001/task.md' });
  assert.ok(r.events.some((e) => e.type === 'usage' && e.context_used === 1000));
  assert.ok(r.events.some((e) => e.type === 'usage' && e.context_window === 200000));
  assert.ok(r.events.some((e) => e.type === 'limits'));
  // The chat itself, not the model check that also reads stream-json.
  const launched = (await seenOf(ws, 'claude')).find((s) => Array.isArray(s['args']) && (s['args'] as string[]).includes('--include-partial-messages'))!;
  const args = launched['args'] as string[];
  assert.equal(launched['apiKey'], null, 'no API key reaches Claude Code');
  assert.equal(launched['cwd'], ws);
  for (const [flag, value] of [['--tools', 'Read,Glob,Grep'], ['--permission-mode', 'dontAsk'], ['--setting-sources', 'project'], ['--model', 'haiku'], ['--effort', 'low']]) {
    assert.equal(args[args.indexOf(flag!) + 1], value, flag);
  }
  assert.ok(args.includes('--strict-mcp-config'), 'no MCP server, not even the claude.ai connectors');
  assert.ok(!args.includes('--resume'));
  const instructions = args[args.indexOf('--append-system-prompt-file') + 1]!;
  assert.equal(await fsp.readFile(instructions, 'utf-8'), CHAT_INSTRUCTIONS, 'instructions go in a file, never through a command line');
  assert.deepEqual(args, conversationArgs(runnerSettingsFile(ws), instructions, { model: 'haiku', effort: 'low', resume: null }));
  assert.deepEqual(JSON.parse(launched['settings'] as string), { disableAllHooks: true }, 'no hooks run in the chat');
  await session.close();
  const resumed = track(await adapter.open(open(ws, { resume: 'sess-1' })));
  assert.deepEqual((await ask(resumed, 'hello')).outcome, { status: 'done' });
  await resumed.close();
  const again = (await seenOf(ws, 'claude')).filter((s) => Array.isArray(s['args']) && (s['args'] as string[]).includes('--resume'));
  assert.deepEqual(again.map((s) => s['args']), [conversationArgs(runnerSettingsFile(ws), instructions, { model: null, effort: null, resume: 'sess-1' })], 'a resumed conversation is locked down the same way');
  assert.deepEqual(JSON.parse(again[0]!['settings'] as string), { disableAllHooks: true });
});

test('Claude Code\'s model check runs no hooks and no MCP servers, in an empty folder of its own that is removed after', posix, async (t) => {
  const ws = await workspace(t);
  const adapter = claude(ws, await script(ws, 'claude', FAKE_CLAUDE));
  assert.deepEqual((await adapter.status(ws)).models.map((m) => m.id), ['default', 'haiku']);
  const probes = (await seenOf(ws, 'claude')).filter((s) => Array.isArray(s['args']) && !(s['args'] as string[]).includes('--include-partial-messages'));
  assert.equal(probes.length, 1);
  const probe = probes[0]!;
  const args = probe['args'] as string[];
  const settings = args[args.indexOf('--settings') + 1]!;
  assert.deepEqual(args, modelProbeArgs(settings), 'the same lock-down as a conversation: read tools only, strict MCP, hook-free settings');
  assert.deepEqual(JSON.parse(probe['settings'] as string), { disableAllHooks: true });
  const cwd = probe['cwd'] as string;
  assert.notEqual(cwd, ws, 'not the workspace');
  assert.notEqual(cwd, os.homedir(), 'not the home folder, whose personal settings would count as the folder\'s');
  assert.equal(path.basename(path.dirname(settings)), path.basename(cwd), 'its settings file is in that folder');
  assert.equal(existsSync(cwd), false, 'and the folder is gone afterwards');
});

test('Claude Code\'s model check removes its folder even when its settings cannot be written', posix, async (t) => {
  const ws = await workspace(t);
  const adapter = claude(ws, await script(ws, 'claude', FAKE_CLAUDE));
  const made: string[] = [];
  // The fs/promises module object itself, which the adapter reads its functions from.
  const real = promises;
  const mkdtemp = real.mkdtemp.bind(real);
  t.mock.method(real, 'mkdtemp', async (prefix: string) => { const dir = await mkdtemp(prefix); made.push(dir); return dir; });
  const writeFile = real.writeFile.bind(real);
  t.mock.method(real, 'writeFile', async (file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string' && made.some((d) => file.startsWith(d))) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return (writeFile as (...a: unknown[]) => Promise<void>)(file, ...rest);
  });
  assert.deepEqual((await adapter.status(ws)).models, [], 'no models without the hook-free settings');
  assert.ok(made.some((d) => path.basename(d).startsWith('gtd-chat-models-')), 'the probe folder was made');
  for (const dir of made) assert.equal(existsSync(dir), false, `removed: ${dir}`);
  assert.deepEqual((await seenOf(ws, 'claude')).filter((s) => Array.isArray(s['args']) && !(s['args'] as string[]).includes('--include-partial-messages')), [], 'and Claude Code was never started without them');
});

test('Claude Code: an expired sign-in, a plan limit, an API key and Stop each end the answer in their own way', posix, async (t) => {
  const ws = await workspace(t);
  const adapter = claude(ws, await script(ws, 'claude', FAKE_CLAUDE));
  let session = track(await adapter.open(open(ws)));
  assert.equal((await ask(session, 'limit')).outcome.error?.code, 'plan_limit');
  const slow = new Promise<TurnOutcome>((resolve) => session.send('slow', (e) => { if (e.type === 'end') resolve(e.outcome); }));
  await new Promise((r) => setTimeout(r, 100));
  await session.interrupt();
  assert.deepEqual(await slow, { status: 'stopped' });
  assert.equal((await ask(session, 'expire')).outcome.error?.code, 'sign_in');
  assert.equal(session.alive, false);
  session = track(await adapter.open(open(ws)));
  assert.equal((await ask(session, 'apikey')).outcome.error?.code, 'api_billing', 'stopped before anything is billed to an API account');
  session = track(await adapter.open(open(ws, { resume: 'missing' })));
  assert.equal((await ask(session, 'hello')).outcome.error?.code, 'resume_failed');
});

// ---------------------------------------------------------------- Codex, with a fake `codex app-server`

const FAKE_CODEX = String.raw`
const argv = process.argv.slice(2);
seen({ args: argv, apiKey: process.env.OPENAI_API_KEY ?? null });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const account = process.env.FAKE_ACCOUNT || 'chatgpt';
const mode = process.env.FAKE_MODE || '';
// Like Codex: the configured MCP servers start as soon as a thread starts, unless the process was launched with
// them off (\`-c mcp_servers={...}\`); a thread's own overrides only change what it reports afterwards, so an adapter
// that relied on them would leave a marker file. Hooks are on unless the process was started with them off.
const late = mode === 'late' && argv.some((a) => a.startsWith('mcp_servers='));
const SERVERS = ['fictional-crm', 'project-notes', 'fictional/search', 'notes.v2', ...(late ? ['late-server'] : [])];
const hooksOff = argv.includes('features.hooks=false') && mode !== 'hooks-stay';
const launchOff = new Set();
for (const a of argv.filter((x) => x.startsWith('mcp_servers={'))) {
  for (const k of a.matchAll(/(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))=\{enabled=false\}/g)) launchOff.add(k[1] !== undefined ? JSON.parse('"' + k[1] + '"') : k[2]);
}
if (mode === 'ignore-launch') launchOff.clear();
const marker = (name) => fs.writeFileSync(require('path').join(require('path').dirname(SEEN), 'mcp-started-' + encodeURIComponent(name)), '1');
let disabled = new Set();
let slow = null;
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 99) { seen({ approval: m.result }); out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } }); return; }
  const reply = (result) => out({ id: m.id, result });
  const startThread = (params) => {
    for (const name of SERVERS) if (!launchOff.has(name)) marker(name);
    const servers = (params.config && params.config.mcp_servers) || {};
    disabled = mode === 'keep-server' ? new Set() : new Set([...launchOff, ...Object.keys(servers).filter((n) => servers[n].enabled === false)]);
  };
  if (mode === 'old' && (m.method === 'hooks/list' || m.method === 'mcpServerStatus/list')) return out({ id: m.id, error: { code: -32601, message: 'unknown method' } });
  switch (m.method) {
    case 'initialize': return reply({});
    case 'config/read': seen({ configRead: m.params }); return reply({ config: { mcp_servers: Object.fromEntries(SERVERS.map((n) => [n, { command: 'fictional', enabled: !launchOff.has(n) }])), features: { hooks: !hooksOff } } });
    case 'hooks/list': seen({ hooksList: m.params }); return reply({ data: [{ cwd: m.params.cwds ? m.params.cwds[0] : null, hooks: hooksOff ? [] : [{ key: 'h', eventName: 'sessionStart', enabled: true }] }] });
    case 'mcpServerStatus/list':
      seen({ mcpStatus: m.params });
      if (!m.params.threadId) { for (const name of SERVERS) marker(name); return reply({ data: SERVERS.map((name) => ({ name, runtimeStatus: 'connected' })), nextCursor: null }); }
      return reply({ data: SERVERS.map((name) => ({ name, runtimeStatus: disabled.has(name) ? 'disabled' : 'connected' })), nextCursor: null });
    case 'account/read': return reply(account === 'none' ? { account: null, requiresOpenaiAuth: true } : { account: { type: account, planType: 'plus', email: 'someone@example.com' }, requiresOpenaiAuth: true });
    case 'model/list': return reply({ data: [{ model: 'gpt-fictional', displayName: 'GPT Fictional', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }, { model: 'hidden-one', hidden: true }] });
    case 'account/rateLimits/read': return reply({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1795001148 } } });
    case 'thread/start': seen({ start: m.params }); startThread(m.params); return reply({ thread: { id: 'thr-1' } });
    case 'thread/resume': seen({ resume: m.params }); if (m.params.threadId === 'missing') return out({ id: m.id, error: { code: -32600, message: 'no rollout found for thread id missing' } }); startThread(m.params); return reply({ thread: { id: m.params.threadId } });
    case 'turn/interrupt': out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'interrupted' } } }); return reply({});
    case 'turn/start': {
      const text = m.params.input[0].text;
      seen({ turn: m.params });
      reply({ turn: { id: 'turn-1' } });
      out({ method: 'turn/started', params: { threadId: m.params.threadId, turn: { id: 'turn-1' } } });
      if (text === 'approve') return out({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-1', command: 'touch x' } });
      if (text === 'limit') return out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded' } } } });
      out({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', delta: 'Due ' } });
      if (text === 'slow') return;
      out({ method: 'item/started', params: { threadId: 'thr-1', item: { type: 'commandExecution' } } });
      out({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', delta: 'Friday.' } });
      out({ method: 'item/agentMessage/delta', params: { threadId: 'another-thread', delta: 'NOT MINE' } });
      out({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr-1', tokenUsage: { last: { totalTokens: 1200 }, modelContextWindow: 258400 } } });
      return out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } });
    }
  }
});
`;

function codex(ws: string, bin: string, account = 'chatgpt', mode = ''): CodexChatAdapter {
  return new CodexChatAdapter(() => bin, () => codexEnv({ PATH: process.env.PATH, HOME: ws, OPENAI_API_KEY: 'should-be-removed', FAKE_ACCOUNT: account, FAKE_MODE: mode }));
}
const markers = async (dir: string) => (await fsp.readdir(dir)).filter((f) => f.startsWith('mcp-started-'));

test('Codex: only a ChatGPT sign-in counts; models and plan usage come from Codex itself', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'codex', FAKE_CODEX);
  assert.deepEqual((await codex(ws, bin, 'none').status(ws)).problems.map((p) => p.code), ['not_signed_in']);
  assert.deepEqual((await codex(ws, bin, 'apiKey').status(ws)).problems.map((p) => p.code), ['not_subscription']);
  const ok = await codex(ws, bin).status(ws);
  assert.equal(ok.ready, true);
  assert.equal(ok.plan, 'plus');
  assert.deepEqual(ok.models.map((m) => [m.id, m.efforts]), [['gpt-fictional', ['low']]], 'hidden models are not offered');
  assert.equal(ok.limits?.[0]?.used_percent, 5);
  assert.ok(!JSON.stringify(ok).includes('someone@example.com'));
  // Checked once a minute at most: the same adapter answers from its last check, and `fresh` checks again.
  const cached = codex(ws, bin);
  await cached.status(ws);
  await fsp.rename(bin, `${bin}.gone`);
  assert.equal((await cached.status(ws)).ready, true, 'a cached answer is reused for a minute');
  assert.equal((await cached.status(ws, { fresh: true })).ready, false, 'a fresh check sees the change');
  await fsp.rename(`${bin}.gone`, bin);
  assert.deepEqual((await new CodexChatAdapter(() => null).status(ws)).problems.map((p) => p.code), ['not_installed']);
});

test('Codex threads are read-only without network or approvals, new or resumed, and approvals are declined', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'codex', FAKE_CODEX);
  const adapter = codex(ws, bin);
  const session = track(await adapter.open(open(ws, { model: 'gpt-fictional', effort: 'low' })));
  assert.equal(session.sessionId, 'thr-1');
  const r = await ask(session, 'hello');
  assert.equal(r.text, 'Due Friday.', 'text from another thread is never shown');
  assert.deepEqual(r.outcome, { status: 'done' });
  assert.ok(r.events.some((e) => e.type === 'usage' && e.context_used === 1200 && e.context_window === 258400));
  assert.deepEqual((await ask(session, 'approve')).outcome, { status: 'done' });
  assert.equal((await ask(session, 'limit')).outcome.error?.code, 'plan_limit');
  const slow = new Promise<TurnOutcome>((resolve) => session.send('slow', (e) => { if (e.type === 'end') resolve(e.outcome); }));
  await new Promise((r) => setTimeout(r, 100));
  await session.interrupt();
  assert.deepEqual(await slow, { status: 'stopped' });
  await session.close();
  const resumed = track(await adapter.open(open(ws, { resume: 'thr-1' })));
  await resumed.close();
  await assert.rejects(adapter.open(open(ws, { resume: 'missing' })), (err: Error & { turnError?: { code: string } }) => err.turnError?.code === 'resume_failed');

  const seen = await seenOf(ws, 'codex');
  assert.ok(seen.every((s) => !('apiKey' in s) || s['apiKey'] === null), 'no API key reaches Codex');
  const start = seen.find((s) => s['start'])!['start'] as Record<string, unknown>;
  const resume = seen.find((s) => s['resume'])!['resume'] as Record<string, unknown>;
  for (const settings of [start, resume]) {
    assert.equal(settings['sandbox'], 'read-only');
    assert.equal(settings['approvalPolicy'], 'never');
    assert.deepEqual(settings['config'], { web_search: 'disabled', mcp_servers: { 'fictional-crm': { enabled: false }, 'project-notes': { enabled: false }, 'fictional/search': { enabled: false }, 'notes.v2': { enabled: false } } });
    assert.equal(settings['developerInstructions'], CHAT_INSTRUCTIONS);
  }
  assert.equal(start['model'], 'gpt-fictional');
  assert.equal((seen.find((s) => s['turn'])!['turn'] as Record<string, unknown>)['effort'], 'low');
  assert.deepEqual(seen.find((s) => s['approval'])!['approval'], { decision: 'decline' });
});

test('Codex starts with hooks, apps, plugins and extra tools off, and every configured MCP server off from launch, new or resumed', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'codex', FAKE_CODEX);
  const adapter = codex(ws, bin);
  assert.equal((await adapter.status(ws)).ready, true);
  await (track(await adapter.open(open(ws, { model: 'gpt-fictional' })))).close();
  await (track(await adapter.open(open(ws, { resume: 'thr-1' })))).close();
  const seen = await seenOf(ws, 'codex');
  const names = ['fictional-crm', 'project-notes', 'fictional/search', 'notes.v2'];
  const launches = seen.filter((s) => s['args']).map((s) => s['args']);
  // The status check; then for each open, a process that only reads the configuration, and the chat's own process
  // started with every configured server off.
  assert.deepEqual(launches, [codexLaunchArgs(), codexLaunchArgs(), codexLaunchArgs(names), codexLaunchArgs(), codexLaunchArgs(names)]);
  assert.deepEqual(codexLaunchArgs(names).slice(-2), ['-c', 'mcp_servers={fictional-crm={enabled=false},project-notes={enabled=false},"fictional/search"={enabled=false},"notes.v2"={enabled=false}}'], 'one inline table: a dotted -c path cannot name a server with a dot or slash');
  const launch = codexLaunchArgs();
  for (const feature of ['hooks', 'apps', 'plugins', 'memories', 'multi_agent']) assert.ok(launch.includes(`features.${feature}=false`), feature);
  assert.ok(!codexLaunchArgs(['plain_name', 'other-name']).some((a) => a.includes('"')), 'plain names need no quotes, which a Windows .cmd launch refuses');
  assert.deepEqual(seen.filter((s) => s['configRead']).map((s) => s['configRead']), Array(4).fill({ cwd: ws, includeLayers: false }), 'the servers Codex would load for this workspace, read before and checked after the launch');
  const start = seen.find((s) => s['start'])!['start'] as Record<string, unknown>;
  const resume = seen.find((s) => s['resume'])!['resume'] as Record<string, unknown>;
  const settings = codexThreadSettings(open(ws, { model: 'gpt-fictional' }), names);
  assert.deepEqual(start, { ...settings, ephemeral: false });
  const { model: _model, ...resumeSettings } = settings;
  assert.deepEqual(resume, { threadId: 'thr-1', ...resumeSettings });
  // Checked as Codex reports the thread, and never without one (Codex would then start the servers to list them).
  const status = seen.filter((s) => s['mcpStatus']).map((s) => s['mcpStatus'] as Record<string, unknown>);
  assert.equal(status.length, 2);
  assert.ok(status.every((p) => p['threadId'] === 'thr-1'));
  assert.deepEqual(seen.filter((s) => s['hooksList']).map((s) => s['hooksList']), [{ cwds: [ws] }, { threadId: 'thr-1' }, { threadId: 'thr-1' }]);
  assert.deepEqual(await markers(ws), [], 'no MCP server was started');
});

test('Codex is not used when it keeps an MCP server or a hook on, or cannot say', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'codex', FAKE_CODEX);
  const refused = (fragment: RegExp) => (err: Error & { turnError?: { code: string; detail: string | null } }) => err.turnError?.code === 'provider' && fragment.test(err.turnError.detail ?? '');
  await assert.rejects(codex(ws, bin, 'chatgpt', 'keep-server').open(open(ws)), refused(/kept MCP servers on .*fictional-crm/));
  await assert.rejects(codex(ws, bin, 'chatgpt', 'keep-server').open(open(ws, { resume: 'thr-1' })), refused(/kept MCP servers on/), 'a resumed thread too');
  await assert.rejects(codex(ws, bin, 'chatgpt', 'hooks-stay').open(open(ws)), refused(/would run hooks/));
  assert.deepEqual(await markers(ws), [], 'refused after the thread started, but no server had started');
  // Checked before any thread starts: an override Codex did not take, or a server added since it was read.
  for (const mode of ['ignore-launch', 'late']) {
    const before = (await seenOf(ws, 'codex')).filter((s) => s['start'] || s['resume']).length;
    await assert.rejects(codex(ws, bin, 'chatgpt', mode).open(open(ws)), refused(/would start MCP servers in the chat/), mode);
    await assert.rejects(codex(ws, bin, 'chatgpt', mode).open(open(ws, { resume: 'thr-1' })), refused(/would start MCP servers/), `${mode}, resumed`);
    assert.equal((await seenOf(ws, 'codex')).filter((s) => s['start'] || s['resume']).length, before, `${mode}: no thread was started`);
    assert.deepEqual(await markers(ws), [], `${mode}: no server was started`);
  }
  await assert.rejects(codex(ws, bin, 'chatgpt', 'old').open(open(ws)), refused(/cannot be limited to reading files/));
  const hooks = await codex(ws, bin, 'chatgpt', 'hooks-stay').status(ws);
  assert.equal(hooks.ready, false);
  assert.deepEqual(hooks.problems.map((p) => p.code), ['not_read_only']);
  assert.deepEqual(hooks.models.map((m) => m.id), ['gpt-fictional'], 'signed in all the same: the models still show');
  assert.deepEqual((await codex(ws, bin, 'chatgpt', 'old').status(ws)).problems.map((p) => p.code), ['not_read_only'], 'a version that cannot list hooks');
  assert.ok((await seenOf(ws, 'codex')).filter((s) => s['mcpStatus']).every((s) => (s['mcpStatus'] as Record<string, unknown>)['threadId']));
  assert.ok(codexHooksProblem({ data: [{ hooks: [{ enabled: false }] }] }) === null, 'a hook Codex reports as off is fine');
  assert.deepEqual(codexServersOn({ data: [{ name: 'a', runtimeStatus: 'disabled' }, { name: 'b', runtimeStatus: 'starting' }] }), ['b']);
  assert.equal(codexServersOn({ data: [] }), null);
});

// ---------------------------------------------------------------- Copilot, with a fake `copilot --acp`

const FAKE_COPILOT = String.raw`
if (process.argv[2] === '--help') {
  seen({ help: true });
  process.stdout.write('Usage: copilot [OPTIONS]\n' + (process.env.FAKE_OLD === 'yes' ? '' : '  --available-tools [<tools>...]\n') + '  --deny-tool\n  --disable-builtin-mcps\n  --disable-mcp-server\n  --no-experimental\n  --no-ask-user\n');
  process.exit(0);
}
seen({ args: process.argv.slice(2), cwd: process.cwd(), byok: process.env.COPILOT_PROVIDER_BASE_URL ?? null, pluginDirOnly: process.env.COPILOT_PLUGIN_DIR_ONLY ?? null });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let pending = null;
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 77) { seen({ permission: m.result }); out({ id: pending, result: { stopReason: 'end_turn' } }); return; }
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [] });
    case 'session/new': seen({ newSession: m.params.cwd }); return process.env.FAKE_AUTH === 'no' ? out({ id: m.id, error: { code: -32000, message: 'Authentication required' } }) : reply({ sessionId: 'cp-1', models: { availableModels: [{ modelId: 'gpt-x', name: 'GPT X' }], currentModelId: 'gpt-x' } });
    case 'session/close': return reply({});
    case 'session/load': seen({ load: m.params.sessionId }); out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED HISTORY' } } } }); return reply({});
    case 'session/cancel': return out({ id: pending, result: { stopReason: 'cancelled' } });
    case 'session/prompt': {
      const text = m.params.prompt[0].text;
      seen({ prompt: text });
      pending = m.id;
      const say = (t) => out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: t } } } });
      // What Copilot says when the allow-list hid tools: before the answer, without a message id.
      out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Info: Disabled tools: bash, create, edit, task' } } } });
      if (text.endsWith('permission')) return out({ id: 77, method: 'session/request_permission', params: { sessionId: 'cp-1', options: [{ optionId: 'ok', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }] } });
      if (text.endsWith('quote')) {
        say('The notice reads: ');
        // An unnumbered chunk after the answer began, quoting the notice: part of the answer.
        out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Info: Disabled tools: bash\nThat is what Copilot prints.' } } } });
        return reply({ stopReason: 'end_turn' });
      }
      say('Due ');
      if (text.endsWith('slow')) return;
      out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'tool_call', kind: 'read', title: 'Read task' } } });
      say('Friday.');
      return reply({ stopReason: 'end_turn' });
    }
  }
});
`;

function copilot(ws: string, bin: string, auth = 'yes', old = 'no'): CopilotChatAdapter {
  return new CopilotChatAdapter(() => bin, () => copilotEnv({ PATH: process.env.PATH, HOME: ws, COPILOT_HOME: path.join(ws, 'copilot-home'), COPILOT_PROVIDER_BASE_URL: 'http://byok.example', FAKE_AUTH: auth, FAKE_OLD: old }));
}

test('Copilot: signed out is told apart, models come from the session, and usage is said to be unreported', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'copilot', FAKE_COPILOT);
  assert.deepEqual((await copilot(ws, bin, 'no').status(ws)).problems.map((p) => p.code), ['not_signed_in']);
  const ok = await copilot(ws, bin).status(ws);
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.models.map((m) => m.id), ['gpt-x']);
  assert.deepEqual(ok.notes, ['premium_requests', 'no_usage_report']);
});

test('Copilot gets the instructions once, refuses permissions, and continues a saved session without replaying it', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'copilot', FAKE_COPILOT);
  const adapter = copilot(ws, bin);
  const session = track(await adapter.open(open(ws, { model: 'gpt-x' })));
  const r = await ask(session, 'hello');
  assert.equal(r.text, 'Due Friday.');
  assert.deepEqual((await ask(session, 'permission')).outcome, { status: 'done' });
  assert.equal((await ask(session, 'quote')).text, 'The notice reads: Info: Disabled tools: bash\nThat is what Copilot prints.', 'only the notice before any answer text is dropped');
  const slow = new Promise<TurnOutcome>((resolve) => session.send('slow', (e) => { if (e.type === 'end') resolve(e.outcome); }));
  await new Promise((r) => setTimeout(r, 100));
  await session.interrupt();
  assert.deepEqual(await slow, { status: 'stopped' });
  await session.close();
  const resumed = track(await adapter.open(open(ws, { resume: 'cp-1' })));
  const again = await ask(resumed, 'hello');
  assert.equal(again.text, 'Due Friday.', 'the history replayed while loading is not shown as a new answer');
  await resumed.close();

  const seen = await seenOf(ws, 'copilot');
  const prompts = seen.filter((s) => s['prompt']).map((s) => s['prompt'] as string);
  assert.ok(prompts[0]!.startsWith(CHAT_INSTRUCTIONS), 'a new session gets the instructions with its first message');
  assert.equal(prompts[1], 'permission', 'and only with the first');
  assert.equal(prompts[4], 'hello', 'a resumed session already has them');
  assert.deepEqual(seen.find((s) => s['permission'])!['permission'], { outcome: { outcome: 'selected', optionId: 'no' } });
  assert.ok(seen.filter((s) => s['args']).every((s) => s['byok'] === null), 'a custom provider (BYOK) never reaches Copilot');
  assert.equal(seen.find((s) => s['load'])!['load'], 'cp-1');
  const launches = seen.filter((s) => s['args']);
  assert.deepEqual(launches.map((s) => s['args']), [copilotArgs({ COPILOT_HOME: path.join(ws, 'copilot-home') }, ws, 'gpt-x', null), copilotArgs({ COPILOT_HOME: path.join(ws, 'copilot-home') }, ws, null, null)], 'a new and a resumed session start locked down the same way');
  assert.ok(launches.every((s) => s['pluginDirOnly'] === 'true' && s['cwd'] === ws));
});

test('Copilot\'s sign-in check opens its session in an empty folder of its own, never in the workspace', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'copilot', FAKE_COPILOT);
  assert.equal((await copilot(ws, bin).status(ws)).ready, true);
  const seen = await seenOf(ws, 'copilot');
  const launch = seen.find((s) => s['args'])!;
  const cwd = seen.find((s) => s['newSession'])!['newSession'] as string;
  assert.notEqual(cwd, ws);
  assert.equal(path.basename(launch['cwd'] as string), path.basename(cwd), 'the process starts there too, so no workspace hook or MCP file is read');
  assert.deepEqual(launch['args'], copilotArgs({ COPILOT_HOME: path.join(ws, 'copilot-home') }, null, null, null));
  assert.equal(existsSync(cwd), false, 'and the folder is removed afterwards');
});

test('Copilot is not used while a hook is set up, or when its version lacks the lock-down options; nothing is started', posix, async (t) => {
  const ws = await workspace(t);
  const bin = await script(ws, 'copilot', FAKE_COPILOT);
  const old = await copilot(ws, bin, 'yes', 'yes').status(ws);
  assert.deepEqual([old.ready, old.problems.map((p) => p.code)], [false, ['not_read_only']]);
  await assert.rejects(copilot(ws, bin, 'yes', 'yes').open(open(ws)), (err: Error & { turnError?: { code: string } }) => err.turnError?.code === 'provider');
  await fsp.mkdir(path.join(ws, '.github', 'hooks'), { recursive: true });
  await fsp.writeFile(path.join(ws, '.github', 'hooks', 'notify.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'true' }] } }));
  const adapter = copilot(ws, bin);
  const hooked = await adapter.status(ws);
  assert.equal(hooked.ready, false);
  assert.match(hooked.problems[0]!.message, /hooks set up in \.github[\\/]hooks[\\/]notify\.json/);
  await assert.rejects(adapter.open(open(ws)), (err: Error & { turnError?: { code: string; detail: string | null } }) => err.turnError?.code === 'provider' && /hooks/.test(err.turnError.detail ?? ''));
  assert.deepEqual((await seenOf(ws, 'copilot')).filter((s) => s['args']), [], 'no ACP process was started for an old version or a hook (only --help ran)');
  // Hook-free settings saved with a byte order mark, or with a comment and CR line endings, are read, not refused.
  await fsp.rm(path.join(ws, '.github', 'hooks', 'notify.json'));
  await fsp.mkdir(path.join(ws, 'copilot-home'), { recursive: true });
  for (const text of ['\ufeff{"disableAllHooks": true}\n', '{\r  // personal\r  "disableAllHooks": true,\r}\r']) {
    await fsp.writeFile(path.join(ws, 'copilot-home', 'settings.json'), text);
    assert.equal((await copilot(ws, bin).status(ws)).ready, true, JSON.stringify(text));
    await (track(await copilot(ws, bin).open(open(ws)))).close();
  }
  await fsp.writeFile(path.join(ws, 'copilot-home', 'settings.json'), '{}');
  const before = (await seenOf(ws, 'copilot')).filter((s) => s['args']).length;
  // Settings that cannot be read are refused the same way, at the check and when a chat opens.
  await fsp.writeFile(path.join(ws, 'copilot-home', 'settings.json'), '{ "hooks": { // unfinished');
  const unreadable = await copilot(ws, bin).status(ws);
  assert.deepEqual([unreadable.ready, unreadable.problems.map((p) => p.code)], [false, ['not_read_only']]);
  assert.match(unreadable.problems[0]!.message, /could not be read/);
  await assert.rejects(copilot(ws, bin).open(open(ws)), (err: Error & { turnError?: { detail: string | null } }) => /could not be read/.test(err.turnError?.detail ?? ''));
  assert.equal((await seenOf(ws, 'copilot')).filter((s) => s['args']).length, before, 'no ACP process was started for it');
});

// ---------------------------------------------------------------- the conversation service, with fake tools

class FakeSession implements ChatSession {
  alive = true;
  closed = false;
  interrupted = false;
  prompts: string[] = [];
  on: ((e: ChatEvent) => void) | null = null;
  constructor(public sessionId: string | null, private readonly autoStop = true) {}
  send(text: string, onEvent: (e: ChatEvent) => void): void { this.prompts.push(text); this.on = onEvent; }
  // As the real tools do: a session id the tool announces becomes the session's id.
  emit(e: ChatEvent): void { if (e.type === 'session') this.sessionId = e.id; this.on?.(e); }
  async interrupt(): Promise<void> { this.interrupted = true; if (this.autoStop) this.on?.({ type: 'end', outcome: { status: 'stopped' } }); }
  async close(): Promise<void> { this.alive = false; this.closed = true; }
}

/** A barrier a test opens when it chooses: `reached` resolves once something waits at it. */
function barrier() {
  let open!: () => void;
  let arrive!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { arrive = r; });
  return { open, reached, wait: () => { arrive(); return gate; } };
}

function fakeTool(id: ChatProviderId, options: { problems?: ProviderStatus['problems']; autoStop?: boolean; failOpen?: (o: ChatOpenOptions) => Error | null; holdStatus?: () => Promise<void>; holdOpen?: () => Promise<void> } = {}) {
  const sessions: FakeSession[] = [];
  const opened: ChatOpenOptions[] = [];
  const adapter: ChatAdapter = {
    id, label: `Fake ${id}`,
    status: async () => {
      await options.holdStatus?.();
      return { id, label: `Fake ${id}`, installed: true, ready: !(options.problems?.length), problems: options.problems ?? [], plan: 'pro', models: [], limits: null, notes: [] };
    },
    open: async (o) => {
      opened.push(o);
      await options.holdOpen?.();
      const err = options.failOpen?.(o);
      if (err) throw err;
      const s = new FakeSession(o.resume ?? `${id}-session-${sessions.length + 1}`, options.autoStop ?? true);
      sessions.push(s);
      return s;
    },
  };
  return { adapter, sessions, opened, last: () => sessions[sessions.length - 1]! };
}

function service(tools: Partial<Record<ChatProviderId, ChatAdapter>>, limits: ConstructorParameters<typeof ChatService>[1] = {}) {
  const none = (id: ChatProviderId) => fakeTool(id, { problems: [{ code: 'not_installed', message: 'Not installed.' }] }).adapter;
  return new ChatService({ 'claude-code': tools['claude-code'] ?? none('claude-code'), codex: tools.codex ?? none('codex'), copilot: tools.copilot ?? none('copilot') }, { stopGraceMs: 200, ...limits });
}

const answerOf = (c: Conversation) => c.messages[c.messages.length - 1]!;

test('a message streams into the conversation, is saved, and the next one goes to the same process', async (t) => {
  const ws = await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const created = await chat.create({ provider: 'claude-code', model: 'haiku', effort: 'low' });
  const heard: string[] = [];
  const unsubscribe = chat.subscribe(created.id, (e) => heard.push(e.type));
  const sent = await chat.send(created.id, { text: '  What is due this week?  ', page: '/board/task/TASK-2026-0001' });
  assert.equal(sent.busy, true);
  assert.equal(sent.title, 'What is due this week?');
  await assert.rejects(chat.send(created.id, { text: 'again' }), (e: Error & { statusCode?: number; details?: { code: string } }) => e.statusCode === 409 && e.details?.code === 'busy');
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  const s = tool.last();
  assert.equal(tool.opened[0]!.model, 'haiku');
  assert.equal(tool.opened[0]!.instructions, CHAT_INSTRUCTIONS);
  assert.equal(s.prompts[0], '(I am on this dashboard page: /board/task/TASK-2026-0001)\n\nWhat is due this week?');
  s.emit({ type: 'text', text: 'TASK-2026-0001 ' });
  s.emit({ type: 'step', step: { kind: 'read', path: 'tasks/TASK-2026-0001/task.md' } });
  s.emit({ type: 'usage', context_used: 1000, context_window: 200000 });
  s.emit({ type: 'text', text: 'is due Friday.' });
  s.emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(created.id)).busy));
  const saved = JSON.parse(await fsp.readFile(path.join(ws, '.situation-board', 'chat', `${created.id}.json`), 'utf-8')) as Conversation;
  assert.equal(answerOf(saved).text, 'TASK-2026-0001 is due Friday.');
  assert.equal(answerOf(saved).status, 'done');
  assert.equal(answerOf(saved).steps, 1);
  assert.deepEqual(saved.usage, { context_used: 1000, context_window: 200000 });
  assert.deepEqual(saved.provider_session, { provider: 'claude-code', id: 'claude-code-session-1' });
  assert.ok(!('busy' in saved), 'in-memory state is never saved');
  assert.equal(await fsp.readFile(path.join(ws, '.situation-board', 'chat', '.gitignore'), 'utf-8'), '*\n', 'chats are never committed');
  assert.ok(['text', 'step', 'usage', 'conversation'].every((type) => heard.includes(type)));
  unsubscribe();

  await chat.send(created.id, { text: 'And next week?' });
  assert.ok(await eventually(() => s.prompts.length === 2));
  assert.equal(tool.sessions.length, 1, 'the same process answers the next message');
  assert.equal(s.prompts[1], 'And next week?', 'no page given, none said');
  s.emit({ type: 'end', outcome: { status: 'done' } });
  assert.deepEqual((await chat.list()).map((c) => [c.id, c.messages]), [[created.id, 4]]);
});

test('a tool that is not ready refuses the message with its problem, and nothing is added', async (t) => {
  await workspace(t);
  const chat = service({ codex: fakeTool('codex', { problems: [{ code: 'not_signed_in', message: 'Codex is not signed in.' }] }).adapter });
  const c = await chat.create({ provider: 'codex' });
  await assert.rejects(chat.send(c.id, { text: 'hello' }), (e: Error & { statusCode?: number; details?: { code: string } }) => e.statusCode === 409 && e.details?.code === 'not_signed_in' && e.message === 'Codex is not signed in.');
  assert.equal((await chat.get(c.id)).messages.length, 0);
});

test('requests are checked: ids, tools, models, empty and very long messages, page paths', async (t) => {
  const ws = await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  for (const bad of ['../../etc/passwd', 'chat-', 'chat-ABCDEFGHIJ', 'chat-abcdefgh/../x']) await assert.rejects(chat.get(bad), /Invalid conversation id/);
  await assert.rejects(chat.create({ provider: 'gemini' }), /provider must be one of/);
  await assert.rejects(chat.create({ provider: 'codex', model: '--dangerously-skip-permissions' }), /Invalid model/);
  await assert.rejects(chat.create({ provider: 'codex', model: 'gpt; rm -rf /' }), /Invalid model/);
  const c = await chat.create({ provider: 'claude-code' });
  await assert.rejects(chat.send(c.id, { text: '   ' }), /Write a message first/);
  await assert.rejects(chat.send(c.id, { text: 'x'.repeat(20_001) }), (e: Error & { statusCode?: number }) => e.statusCode === 413);
  await chat.send(c.id, { text: 'hello', page: '/../../secret' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().prompts.length === 1));
  assert.equal(tool.last().prompts[0], 'hello', 'a page path that is not a plain dashboard path is dropped');
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.equal(existsSync(path.join(ws, '.situation-board', 'chat', '..', '..', 'secret')), false);
});

test('Stop keeps what was written, marked as stopped; a tool that ignores Stop is ended', async (t) => {
  await workspace(t);
  const polite = fakeTool('claude-code');
  const stubborn = fakeTool('codex', { autoStop: false });
  const chat = service({ 'claude-code': polite.adapter, codex: stubborn.adapter });
  const a = await chat.create({ provider: 'claude-code' });
  await chat.send(a.id, { text: 'long answer please' });
  assert.ok(await eventually(() => polite.sessions[0]?.on !== null && polite.sessions.length === 1));
  polite.last().emit({ type: 'text', text: 'Half an ans' });
  const stopped = await chat.stop(a.id);
  assert.equal(answerOf(stopped).status, 'stopped');
  assert.equal(answerOf(stopped).text, 'Half an ans');
  assert.equal(stopped.busy, false);
  await assert.rejects(chat.stop(a.id), /not answering/);

  const b = await chat.create({ provider: 'codex' });
  await chat.send(b.id, { text: 'long answer please' });
  assert.ok(await eventually(() => stubborn.sessions.length === 1 && stubborn.last().on !== null));
  const ended = await chat.stop(b.id);
  assert.equal(answerOf(ended).status, 'stopped');
  assert.equal(stubborn.last().closed, true, 'ended after the grace period');
});

test('an answer that takes too long is ended as a timeout, never left running', async (t) => {
  await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter }, { turnTimeoutMs: 150 });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  const answer = answerOf(await chat.get(c.id));
  assert.equal(answer.status, 'error');
  assert.equal(answer.error?.code, 'timeout');
  assert.equal(tool.last().closed, true);
});

test('an expired sign-in ends the answer and the process; the next message starts again and resumes the session', async (t) => {
  await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'first' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  tool.last().emit({ type: 'session', id: 'sess-A' });
  tool.last().emit({ type: 'text', text: 'ok' });
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  await chat.send(c.id, { text: 'second' });
  assert.ok(await eventually(() => tool.last().prompts.length === 2));
  tool.last().emit({ type: 'end', outcome: { status: 'error', error: { code: 'sign_in', detail: 'OAuth token has expired' } } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  assert.equal(answerOf(await chat.get(c.id)).error?.code, 'sign_in');
  assert.equal(tool.last().closed, true, 'a process that failed is not reused');
  await chat.send(c.id, { text: 'third, after signing in again' });
  assert.ok(await eventually(() => tool.sessions.length === 2));
  assert.equal(tool.opened[1]!.resume, 'sess-A', 'the conversation goes on in the same session');
  assert.ok(await eventually(() => tool.last().prompts.length === 1));
  assert.equal(tool.last().prompts[0], 'third, after signing in again', 'a resumed session needs no earlier messages');
});

test('a session the tool lost is restarted once with the conversation as text, and the chat says so', async (t) => {
  await workspace(t);
  const tool = fakeTool('codex', { failOpen: (o) => (o.resume === 'gone' ? Object.assign(new Error('no rollout found'), { turnError: { code: 'resume_failed', detail: null } }) : null) });
  const chat = service({ codex: tool.adapter });
  const c = await chat.create({ provider: 'codex' });
  await chat.send(c.id, { text: 'Who owns TASK-2026-0001?' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  tool.last().emit({ type: 'text', text: 'Alex Rivera.' });
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  // The tool's saved session disappears (deleted, another computer): simulated by a session id it does not know.
  const file = path.join(process.env.ESB_WORKSPACE_PATH!, '.situation-board', 'chat', `${c.id}.json`);
  const saved = JSON.parse(await fsp.readFile(file, 'utf-8')) as Conversation;
  await fsp.writeFile(file, JSON.stringify({ ...saved, provider_session: { provider: 'codex', id: 'gone' } }));
  await ChatService.stopAll();
  await chat.send(c.id, { text: 'And when is it due?' });
  assert.ok(await eventually(() => tool.sessions.length === 2 && tool.last().prompts.length === 1));
  const prompt = tool.last().prompts[0]!;
  assert.match(prompt, /<earlier-conversation>\nUser: Who owns TASK-2026-0001\?\nAssistant: Alex Rivera\.\n<\/earlier-conversation>\n\nAnd when is it due\?$/);
  assert.equal(prompt.split('And when is it due?').length, 2, 'the new question is not also in the earlier part');
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  const after = await chat.get(c.id);
  assert.ok(after.messages.some((m) => m.role === 'notice' && m.notice === 'restarted'));
  assert.equal(after.carry_over, false);
  assert.equal(after.provider_session?.id, 'codex-session-2');
});

test('switching tool brings the conversation along once; switching model resumes the same session', async (t) => {
  await workspace(t);
  const claudeTool = fakeTool('claude-code');
  const codexTool = fakeTool('codex');
  const chat = service({ 'claude-code': claudeTool.adapter, codex: codexTool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'Summarize my week' });
  assert.ok(await eventually(() => claudeTool.last()?.on !== null && claudeTool.sessions.length === 1));
  claudeTool.last().emit({ type: 'session', id: 'sess-C' });
  claudeTool.last().emit({ type: 'text', text: 'Three tasks are due.' });
  claudeTool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));

  const sameTool = await chat.update(c.id, { model: 'opus' });
  assert.equal(sameTool.carry_over, false);
  assert.equal(claudeTool.last().closed, true, 'another model starts a new process');
  await chat.send(c.id, { text: 'Which is first?' });
  assert.ok(await eventually(() => claudeTool.sessions.length === 2 && claudeTool.last().prompts.length === 1));
  assert.deepEqual([claudeTool.opened[1]!.resume, claudeTool.opened[1]!.model], ['sess-C', 'opus']);
  claudeTool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));

  const switched = await chat.update(c.id, { provider: 'codex', model: null });
  assert.equal(switched.carry_over, true);
  assert.ok(switched.messages.some((m) => m.notice === 'provider_changed'));
  await chat.send(c.id, { text: 'Now in Codex: anything late?' });
  assert.ok(await eventually(() => codexTool.sessions.length === 1 && codexTool.last().prompts.length === 1));
  assert.equal(codexTool.opened[0]!.resume, null, 'a session of the other tool is never passed on');
  assert.match(codexTool.last().prompts[0]!, /User: Summarize my week\nAssistant: Three tasks are due\.\nUser: Which is first\?/);
  codexTool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  await assert.rejects(chat.update(c.id, { provider: 'gemini' }), /provider must be one of/);
});

test('at most three tool processes: the one idle longest makes room, and three answering at once refuse a fourth', async (t) => {
  await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await chat.create({ provider: 'claude-code' });
    ids.push(c.id);
    await chat.send(c.id, { text: `question ${i}` });
    assert.ok(await eventually(() => tool.sessions.length === i + 1 && tool.last().on !== null));
  }
  const fourth = await chat.create({ provider: 'claude-code' });
  await assert.rejects(chat.send(fourth.id, { text: 'hello' }), (e: Error & { details?: { code: string } }) => e.details?.code === 'too_many');
  for (const s of tool.sessions) s.emit({ type: 'end', outcome: { status: 'done' } });
  for (const id of ids) assert.ok(await eventually(async () => !(await chat.get(id)).busy));
  await chat.send(fourth.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.sessions.length === 4));
  assert.equal(tool.sessions[0]!.closed, true, 'the first, idle longest, made room');
  assert.equal(ChatService.liveCount(), 3);
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
});

test('an idle process is ended after a while; the conversation resumes in a new one', async (t) => {
  await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter }, { idleMs: 100 });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.last()?.on !== null && tool.sessions.length === 1));
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(() => tool.last().closed));
  assert.equal(ChatService.liveCount(), 0);
});

test('conversations belong to their workspace; deleting one stops it and removes its file', async (t) => {
  const ws = await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  const other = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-chat-other-')));
  t.after(() => fsp.rm(other, { recursive: true, force: true }));
  process.env.ESB_WORKSPACE_PATH = other;
  assert.deepEqual(await chat.list(), []);
  await assert.rejects(chat.get(c.id), /Conversation not found/);
  process.env.ESB_WORKSPACE_PATH = ws;
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.last()?.on !== null && tool.sessions.length === 1));
  const heard: string[] = [];
  chat.subscribe(c.id, (e) => heard.push(e.type));
  await chat.remove(c.id);
  assert.equal(tool.last().closed, true);
  assert.ok(heard.includes('deleted'));
  assert.equal(existsSync(path.join(ws, '.situation-board', 'chat', `${c.id}.json`)), false);
  await assert.rejects(chat.get(c.id), /Conversation not found/);
});

test('when the dashboard stops, every answer is stopped and saved, and no process is left', async (t) => {
  await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.last()?.on !== null && tool.sessions.length === 1));
  tool.last().emit({ type: 'text', text: 'Partial' });
  await ChatService.stopAll();
  assert.equal(ChatService.liveCount(), 0);
  assert.equal(tool.last().closed, true);
  const answer = answerOf(await chat.get(c.id));
  assert.deepEqual([answer.status, answer.text], ['stopped', 'Partial']);
});

test('a conversation file that cannot be read is reported, not crashed on, and left out of the list', async (t) => {
  const ws = await workspace(t);
  const chat = service({});
  await fsp.mkdir(path.join(ws, '.situation-board', 'chat'), { recursive: true });
  await fsp.writeFile(path.join(ws, '.situation-board', 'chat', 'chat-brokenfile01.json'), '{ not json');
  await assert.rejects(chat.get('chat-brokenfile01'), /cannot be read/);
  assert.deepEqual(await chat.list(), []);
});

test('a chat folder that is a symlink is refused: nothing is written, read or deleted through it', posix, async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-chat-outside-')));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'chat-outsidefile1.json'), JSON.stringify({ provider: 'codex', messages: [] }));
  await fsp.mkdir(path.join(ws, '.situation-board'), { recursive: true });
  await fsp.symlink(outside, path.join(ws, '.situation-board', 'chat'));
  const chat = service({});
  await assert.rejects(chat.create({ provider: 'codex' }), /Invalid path traversal/);
  await assert.rejects(chat.get('chat-outsidefile1'), /Invalid path traversal/);
  await assert.rejects(chat.remove('chat-outsidefile1'), /Invalid path traversal/);
  assert.deepEqual(await chat.list(), [], 'files behind the link are never listed');
  assert.deepEqual((await fsp.readdir(outside)).sort(), ['chat-outsidefile1.json'], 'nothing written or deleted outside the workspace');
});

test('deleting a chat while it answers: the answer\'s last save never brings the chat back', async (t) => {
  const ws = await workspace(t);
  // A tool that takes a moment to stop, so the answer ends (and would save) after the file is gone.
  const tool = fakeTool('claude-code', { autoStop: false });
  const chat = service({ 'claude-code': tool.adapter }, { stopGraceMs: 2000 });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  tool.last().emit({ type: 'text', text: 'Half an answer' });
  const s = tool.last();
  s.interrupt = async () => { s.interrupted = true; setTimeout(() => s.on?.({ type: 'end', outcome: { status: 'stopped' } }), 150); };
  await chat.remove(c.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(existsSync(path.join(ws, '.situation-board', 'chat', `${c.id}.json`)), false, 'still deleted after the answer ended');
  await assert.rejects(chat.get(c.id), /Conversation not found/);
  assert.deepEqual(await chat.list(), []);
});

// ---------------------------------------------------------------- races: delete, stop, starting processes, other dashboards

const chatFile = (ws: string, id: string) => path.join(ws, '.situation-board', 'chat', `${id}.json`);
const statusOf = (e: Error & { statusCode?: number; details?: { code: string } }) => e.statusCode;

test('deleting a chat while a message to it is being set up: it stays deleted and no tool starts', async (t) => {
  const ws = await workspace(t);
  const checking = barrier();
  const tool = fakeTool('claude-code', { holdStatus: checking.wait });
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  const sending = chat.send(c.id, { text: 'hello' });
  await checking.reached;
  const removed = chat.remove(c.id);
  checking.open();
  await assert.rejects(sending, (e: Error & { statusCode?: number }) => statusOf(e) === 404);
  await removed;
  assert.equal(existsSync(chatFile(ws, c.id)), false, 'the send did not bring the file back');
  await assert.rejects(chat.get(c.id), /Conversation not found/);
  assert.deepEqual(await chat.list(), []);
  assert.equal(tool.opened.length, 0, 'no tool was started for a deleted chat');
});

test('Stop, then a new message at once: the first answer\'s fallback never ends the next answer', async (t) => {
  await workspace(t);
  // Stops at once: the end arrives while Stop is still asking.
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter }, { stopGraceMs: 5000 });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'first' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  const s = tool.last();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.equal(answerOf(await chat.stop(c.id)).status, 'stopped');
    await chat.send(c.id, { text: 'second' });
    for (let i = 0; i < 20 && s.prompts.length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.equal(s.prompts.length, 2, 'the same process answers the next message');
    t.mock.timers.tick(5000);
    assert.equal(s.closed, false, 'the next answer\'s process is not ended');
    assert.equal((await chat.get(c.id)).busy, true, 'and it is still answering');
  } finally {
    t.mock.timers.reset();
  }
  s.emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  assert.equal(answerOf(await chat.get(c.id)).status, 'done');
});

test('processes still starting count against the limit of three', async (t) => {
  await workspace(t);
  const starting = [barrier(), barrier(), barrier()];
  let n = 0;
  const tool = fakeTool('claude-code', { holdOpen: () => starting[n++]!.wait() });
  const chat = service({ 'claude-code': tool.adapter });
  for (let i = 0; i < 3; i++) {
    const c = await chat.create({ provider: 'claude-code' });
    await chat.send(c.id, { text: `question ${i}` });
    await starting[i]!.reached;
  }
  assert.equal(ChatService.liveCount(), 0, 'none has started yet');
  const fourth = await chat.create({ provider: 'claude-code' });
  await assert.rejects(chat.send(fourth.id, { text: 'hello' }), (e: Error & { details?: { code: string } }) => e.details?.code === 'too_many');
  for (const b of starting) b.open();
  assert.ok(await eventually(() => tool.sessions.length === 3 && tool.sessions.every((s) => s.on !== null)));
  for (const s of tool.sessions) s.emit({ type: 'end', outcome: { status: 'done' } });
});

test('a process that starts after its answer timed out is ended, not left running', async (t) => {
  await workspace(t);
  const starting = barrier();
  const tool = fakeTool('claude-code', { holdOpen: starting.wait });
  const chat = service({ 'claude-code': tool.adapter }, { turnTimeoutMs: 50 });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'hello' });
  await starting.reached;
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy), 'the answer timed out while the tool was starting');
  assert.equal(answerOf(await chat.get(c.id)).error?.code, 'timeout');
  starting.open();
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().closed));
  assert.equal(ChatService.liveCount(), 0);
  assert.deepEqual(tool.last().prompts, [], 'nothing was asked of it');
});

test('when the dashboard stops while a tool is starting, that process is ended too', async (t) => {
  await workspace(t);
  const starting = barrier();
  const tool = fakeTool('claude-code', { holdOpen: starting.wait });
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'hello' });
  await starting.reached;
  const stopping = ChatService.stopAll();
  // The tool finishes starting only after the shutdown has ended every process it knew of.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  starting.open();
  await stopping;
  assert.equal(tool.sessions.length, 1);
  assert.equal(tool.last().closed, true);
  assert.equal(ChatService.liveCount(), 0);
  assert.equal(answerOf(await chat.get(c.id)).status, 'stopped');
});

test('a chat another dashboard is answering in is not sent to, changed or deleted here; its own answer holds it until saved', async (t) => {
  const ws = await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  const lockFile = `${chatFile(ws, c.id)}.lock`;
  // Another dashboard (a live process that is not this one) holds the conversation.
  await fsp.writeFile(lockFile, JSON.stringify({ pid: process.ppid, token: 'other-dashboard', at: new Date().toISOString() }));
  const busy = (e: Error & { statusCode?: number; details?: { code: string } }) => e.statusCode === 409 && e.details?.code === 'busy';
  await assert.rejects(chat.send(c.id, { text: 'hello' }), busy);
  await assert.rejects(chat.update(c.id, { title: 'Renamed' }), busy);
  await assert.rejects(chat.remove(c.id), busy);
  assert.equal(tool.opened.length, 0);
  assert.equal((await chat.get(c.id)).title, 'New chat');
  assert.ok(existsSync(chatFile(ws, c.id)));
  await fsp.rm(lockFile);

  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  const holder = JSON.parse(await fsp.readFile(lockFile, 'utf-8')) as { pid: number };
  assert.equal(holder.pid, process.pid, 'while this dashboard answers, another one would be refused');
  tool.last().emit({ type: 'text', text: 'Nothing is due.' });
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
  assert.equal(existsSync(lockFile), false, 'released once the answer is saved');
  const saved = JSON.parse(await fsp.readFile(chatFile(ws, c.id), 'utf-8')) as Conversation;
  assert.equal(answerOf(saved).text, 'Nothing is due.');
  await chat.update(c.id, { title: 'Renamed' });
  await chat.remove(c.id);
  assert.deepEqual((await fsp.readdir(path.join(ws, '.situation-board', 'chat'))).filter((n) => n !== '.gitignore'), [], 'no lock is left behind');
});

test('a chat answering again after its timeout counts both of its starting processes against the limit', async (t) => {
  await workspace(t);
  const starts: ReturnType<typeof barrier>[] = [];
  const tool = fakeTool('claude-code', { holdOpen: () => { const b = barrier(); starts.push(b); return b.wait(); } });
  // The same processes and limits for both: one service whose answers time out at once, one whose do not.
  const quick = service({ 'claude-code': tool.adapter }, { turnTimeoutMs: 50 });
  const chat = service({ 'claude-code': tool.adapter });
  const a = await quick.create({ provider: 'claude-code' });
  await quick.send(a.id, { text: 'first try' });
  assert.ok(await eventually(async () => !(await chat.get(a.id)).busy), 'timed out while its tool was starting');
  await chat.send(a.id, { text: 'second try' });
  assert.ok(await eventually(() => starts.length === 2));
  const b = await chat.create({ provider: 'claude-code' });
  await chat.send(b.id, { text: 'hello' });
  assert.ok(await eventually(() => starts.length === 3));
  const c = await chat.create({ provider: 'claude-code' });
  await assert.rejects(chat.send(c.id, { text: 'hello' }), (e: Error & { details?: { code: string } }) => e.details?.code === 'too_many', 'three processes are starting already');
  for (const s of starts) s.open();
  assert.ok(await eventually(() => tool.sessions.length === 3 && tool.sessions[0]!.closed));
  for (const s of tool.sessions.slice(1)) s.emit({ type: 'end', outcome: { status: 'done' } });
});

test('a message being set up when the dashboard stops never starts its tool, and the shutdown waits for it', async (t) => {
  await workspace(t);
  const checking = barrier();
  const tool = fakeTool('claude-code', { holdStatus: checking.wait });
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  const sending = chat.send(c.id, { text: 'hello' });
  await checking.reached;
  let stopped = false;
  const stopping = ChatService.stopAll().then(() => { stopped = true; });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false, 'the shutdown waits for the send being set up');
  const isStopping = (e: Error & { statusCode?: number; details?: { code: string } }) => e.statusCode === 409 && e.details?.code === 'stopping';
  let refused: Error | null = null;
  await assert.rejects(chat.send(c.id, { text: 'another' }).catch((e: Error) => { refused = e; throw e; }), isStopping, 'no new message while it stops');
  checking.open();
  await assert.rejects(sending, isStopping);
  await stopping;
  assert.equal(tool.opened.length, 0, 'no tool started after the shutdown');
  // The page gets the words, not the generic text of a server error.
  let sent: { status?: number; body?: { message?: string; details?: { code?: string } } } = {};
  const res = { status(code: number) { sent.status = code; return res; }, json(body: typeof sent.body) { sent.body = body; return res; } };
  errorHandler(refused!, { method: 'POST', path: '/api/chat/conversations/x/messages', socket: {} } as never, res as never, () => {});
  assert.equal(sent.status, 409);
  assert.match(sent.body?.message ?? '', /^The dashboard is stopping\./);
  assert.equal(sent.body?.details?.code, 'stopping');
  sent = {};
  assert.equal(ChatService.liveCount(), 0);
  // The next start of the dashboard sends again.
  await chat.send(c.id, { text: 'hello again' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
});

test('Stop while the tool is still starting ends the answer at once; the process is closed when it arrives', async (t) => {
  const ws = await workspace(t);
  const starts: ReturnType<typeof barrier>[] = [];
  const tool = fakeTool('claude-code', { holdOpen: () => { const b = barrier(); starts.push(b); return b.wait(); } });
  const chat = service({ 'claude-code': tool.adapter }, { stopGraceMs: 60_000 });
  const c = await chat.create({ provider: 'claude-code' });
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => starts.length === 1));
  const stopped = await chat.stop(c.id);
  assert.equal(stopped.busy, false, 'not left answering until the tool has started');
  assert.equal(answerOf(stopped).status, 'stopped');
  assert.equal(existsSync(`${chatFile(ws, c.id)}.lock`), false, 'and the chat is free for another dashboard');
  await chat.send(c.id, { text: 'again' });
  assert.ok(await eventually(() => starts.length === 2));
  starts[0]!.open();
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.sessions[0]!.closed), 'the late process is closed');
  starts[1]!.open();
  assert.ok(await eventually(() => tool.sessions.length === 2 && tool.last().on !== null));
  assert.equal(tool.last().closed, false, 'the next answer\'s process is not');
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy));
});

test('deleting a chat while it answers keeps its lock until the file is gone', async (t) => {
  const ws = await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  const lockFile = `${chatFile(ws, c.id)}.lock`;
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  const s = tool.last();
  const closing = barrier();
  s.close = async () => { await closing.wait(); s.alive = false; s.closed = true; };
  const removed = chat.remove(c.id);
  // The answer has ended and the delete is ending its process: another dashboard must still be kept out.
  await closing.reached;
  assert.ok(existsSync(chatFile(ws, c.id)), 'not unlinked yet');
  const holder = JSON.parse(await fsp.readFile(lockFile, 'utf-8')) as { pid: number };
  assert.equal(holder.pid, process.pid, 'the lock is still this dashboard\'s');
  closing.open();
  await removed;
  assert.equal(existsSync(chatFile(ws, c.id)), false);
  assert.equal(existsSync(lockFile), false, 'released after the unlink');
});

test('a delete that comes just as the answer ends still deletes, and leaves the chat free', async (t) => {
  const ws = await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  const c = await chat.create({ provider: 'claude-code' });
  const lockFile = `${chatFile(ws, c.id)}.lock`;
  await chat.send(c.id, { text: 'hello' });
  assert.ok(await eventually(() => tool.sessions.length === 1 && tool.last().on !== null));
  // The delete is held while it finds the file; meanwhile the answer ends and lets its lock go.
  const finding = barrier();
  const internals = chat as unknown as { file: (ws: string, id: string) => Promise<string> };
  const file = internals.file.bind(chat);
  let held = false;
  internals.file = async (w, i) => { if (!held) { held = true; await finding.wait(); } return file(w, i); };
  const removed = chat.remove(c.id);
  await finding.reached;
  tool.last().emit({ type: 'end', outcome: { status: 'done' } });
  assert.ok(await eventually(async () => !(await chat.get(c.id)).busy), 'the answer ended first');
  finding.open();
  await removed;
  assert.equal(existsSync(chatFile(ws, c.id)), false, 'deleted');
  assert.equal(existsSync(lockFile), false, 'and no lock is left to block the chat');
  // A new chat in its place works as usual.
  const next = await chat.create({ provider: 'claude-code' });
  await chat.update(next.id, { title: 'Renamed' });
  await chat.remove(next.id);
});

test('reading a chat while it answers gives the answer so far, still going: the panel never loses words or shows it stopped', async (t) => {
  const ws = await workspace(t);
  const tool = fakeTool('claude-code');
  const chat = service({ 'claude-code': tool.adapter });
  type Shown = Parameters<typeof newerOf>[0];
  for (const saved of [false, true]) {
    for (const order of ['202 first', 'read first'] as const) {
      const created = await chat.create({ provider: 'claude-code' });
      const sent = await chat.send(created.id, { text: 'hello' });
      assert.ok(await eventually(() => tool.last()?.on !== null && tool.last()?.prompts.length === 1 && tool.opened.length === tool.sessions.length));
      const s = tool.last();
      const answerId = answerOf(sent).id;
      // The first words come before the page has the answer: it reads the whole conversation again.
      s.emit({ type: 'text', text: 'first ' });
      if (saved) {
        assert.ok(await eventually(async () => answerOf(JSON.parse(await fsp.readFile(chatFile(ws, created.id), 'utf-8')) as Conversation).text === 'first ', 3000));
      }
      const read = await chat.get(created.id);
      const label = `${order}, ${saved ? 'after' : 'before'} the first save`;
      assert.deepEqual([answerOf(read).text, answerOf(read).status, read.busy], ['first ', 'streaming', true], label);
      const ui = (c: unknown) => c as Shown & object;
      let shown: Shown = ui(created);
      if (order === '202 first') {
        shown = newerOf(shown, ui(sent));
        shown = applyStreamEvent(shown, { type: 'text', message_id: answerId, text: 'second' });
        shown = newerOf(shown, ui(read));
      } else {
        shown = newerOf(shown, ui(read));
        shown = newerOf(shown, ui(sent));
        shown = applyStreamEvent(shown, { type: 'text', message_id: answerId, text: 'second' });
      }
      const answer = shown!.messages.find((m) => m.id === answerId)!;
      assert.deepEqual([answer.text, answer.status, shown!.busy], ['first second', 'streaming', true], label);
      s.emit({ type: 'end', outcome: { status: 'done' } });
      assert.ok(await eventually(async () => !(await chat.get(created.id)).busy));
    }
  }
  // An answer no dashboard is giving any more (one that stopped) still reads back as stopped.
  const c = await chat.create({ provider: 'claude-code' });
  const file = chatFile(ws, c.id);
  const saved = JSON.parse(await fsp.readFile(file, 'utf-8')) as Conversation;
  await fsp.writeFile(file, JSON.stringify({ ...saved, messages: [{ id: 'msg-a', role: 'assistant', text: 'half', created_at: '', status: 'streaming' }] }));
  assert.equal(answerOf(await chat.get(c.id)).status, 'stopped');
});
