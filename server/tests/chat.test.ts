import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeChatAdapter, claudeLimits, claudeModels } from '../src/services/chat/claude';
import { CodexChatAdapter, codexEnv, codexLimits, codexTurnError, refuse } from '../src/services/chat/codex';
import { CopilotChatAdapter, copilotArgs, copilotEnv, copilotModels, refusePermission } from '../src/services/chat/copilot';
import { ChatService, CHAT_INSTRUCTIONS, carryOverText, composePrompt, normalize, titleFrom, type Conversation } from '../src/services/chat/chatService';
import { classifyError, type ChatAdapter, type ChatEvent, type ChatOpenOptions, type ChatProviderId, type ChatSession, type ProviderStatus, type TurnOutcome } from '../src/services/chat/types';
import { childEnv } from '../src/services/agentRunner';

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
});

test('Copilot is denied shell, writes, URLs and memory, and every MCP server the user set up', async (t) => {
  const ws = await workspace(t);
  const home = path.join(ws, 'copilot-home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { 'fictional-crm': {}, 'bad name; rm -rf': {} } }));
  const args = copilotArgs({ COPILOT_HOME: home }, 'gpt-x', 'low');
  for (const rule of ['shell', 'write', 'url', 'memory']) assert.ok(args.includes(`--deny-tool=${rule}`), rule);
  assert.ok(args.includes('--disable-builtin-mcps'));
  assert.deepEqual(args.slice(args.indexOf('--disable-mcp-server'), args.indexOf('--disable-mcp-server') + 3), ['--disable-mcp-server', 'fictional-crm', '--deny-tool=fictional-crm']);
  assert.ok(!args.some((a) => a.includes('rm -rf')), 'a server name that is not a plain name is never passed on');
  assert.deepEqual(args.slice(-4), ['--model', 'gpt-x', '--effort', 'low']);
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
seen({ args, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null });
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
  await session.close();
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
seen({ args: process.argv.slice(2), apiKey: process.env.OPENAI_API_KEY ?? null });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const account = process.env.FAKE_ACCOUNT || 'chatgpt';
let slow = null;
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 99) { seen({ approval: m.result }); out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } }); return; }
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({});
    case 'account/read': return reply(account === 'none' ? { account: null, requiresOpenaiAuth: true } : { account: { type: account, planType: 'plus', email: 'someone@example.com' }, requiresOpenaiAuth: true });
    case 'model/list': return reply({ data: [{ model: 'gpt-fictional', displayName: 'GPT Fictional', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }, { model: 'hidden-one', hidden: true }] });
    case 'account/rateLimits/read': return reply({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1795001148 } } });
    case 'thread/start': seen({ start: m.params }); return reply({ thread: { id: 'thr-1' } });
    case 'thread/resume': seen({ resume: m.params }); return m.params.threadId === 'missing' ? out({ id: m.id, error: { code: -32600, message: 'no rollout found for thread id missing' } }) : reply({ thread: { id: m.params.threadId } });
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

function codex(ws: string, bin: string, account = 'chatgpt'): CodexChatAdapter {
  return new CodexChatAdapter(() => bin, () => codexEnv({ PATH: process.env.PATH, HOME: ws, OPENAI_API_KEY: 'should-be-removed', FAKE_ACCOUNT: account }));
}

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
    assert.deepEqual(settings['config'], { web_search: 'disabled' });
    assert.equal(settings['developerInstructions'], CHAT_INSTRUCTIONS);
  }
  assert.equal(start['model'], 'gpt-fictional');
  assert.equal((seen.find((s) => s['turn'])!['turn'] as Record<string, unknown>)['effort'], 'low');
  assert.deepEqual(seen.find((s) => s['approval'])!['approval'], { decision: 'decline' });
});

// ---------------------------------------------------------------- Copilot, with a fake `copilot --acp`

const FAKE_COPILOT = String.raw`
seen({ args: process.argv.slice(2), byok: process.env.COPILOT_PROVIDER_BASE_URL ?? null });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let pending = null;
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 77) { seen({ permission: m.result }); out({ id: pending, result: { stopReason: 'end_turn' } }); return; }
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [] });
    case 'session/new': return process.env.FAKE_AUTH === 'no' ? out({ id: m.id, error: { code: -32000, message: 'Authentication required' } }) : reply({ sessionId: 'cp-1', models: { availableModels: [{ modelId: 'gpt-x', name: 'GPT X' }], currentModelId: 'gpt-x' } });
    case 'session/close': return reply({});
    case 'session/load': seen({ load: m.params.sessionId }); out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED HISTORY' } } } }); return reply({});
    case 'session/cancel': return out({ id: pending, result: { stopReason: 'cancelled' } });
    case 'session/prompt': {
      const text = m.params.prompt[0].text;
      seen({ prompt: text });
      pending = m.id;
      const say = (t) => out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
      if (text.endsWith('permission')) return out({ id: 77, method: 'session/request_permission', params: { sessionId: 'cp-1', options: [{ optionId: 'ok', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }] } });
      say('Due ');
      if (text.endsWith('slow')) return;
      out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'tool_call', kind: 'read', title: 'Read task' } } });
      say('Friday.');
      return reply({ stopReason: 'end_turn' });
    }
  }
});
`;

function copilot(ws: string, bin: string, auth = 'yes'): CopilotChatAdapter {
  return new CopilotChatAdapter(() => bin, () => copilotEnv({ PATH: process.env.PATH, HOME: ws, COPILOT_HOME: path.join(ws, 'copilot-home'), COPILOT_PROVIDER_BASE_URL: 'http://byok.example', FAKE_AUTH: auth }));
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
  assert.equal(prompts[3], 'hello', 'a resumed session already has them');
  assert.deepEqual(seen.find((s) => s['permission'])!['permission'], { outcome: { outcome: 'selected', optionId: 'no' } });
  assert.ok(seen.filter((s) => s['args']).every((s) => s['byok'] === null), 'a custom provider (BYOK) never reaches Copilot');
  assert.equal(seen.find((s) => s['load'])!['load'], 'cp-1');
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

function fakeTool(id: ChatProviderId, options: { problems?: ProviderStatus['problems']; autoStop?: boolean; failOpen?: (o: ChatOpenOptions) => Error | null } = {}) {
  const sessions: FakeSession[] = [];
  const opened: ChatOpenOptions[] = [];
  const adapter: ChatAdapter = {
    id, label: `Fake ${id}`,
    status: async () => ({ id, label: `Fake ${id}`, installed: true, ready: !(options.problems?.length), problems: options.problems ?? [], plan: 'pro', models: [], limits: null, notes: [] }),
    open: async (o) => {
      opened.push(o);
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
