/**
 * Unit tests for the workspace chat helpers. Run with `npm run test:chat --workspace=ui`.
 */
import {
  newerOf, applyStreamEvent, chatError, checkEnded, composerKey, contextPercent, defaultProvider, effortOptions, errorActions, modelOptions, pageContext,
  safeMarkdown, tightestWindow, untilText, type Conversation, type ProviderStatus,
} from './chat';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const conversation: Conversation = {
  id: 'chat-abcdefgh01', title: 'Fictional', provider: 'claude-code', model: null, effort: null, carry_over: false,
  created_at: '', updated_at: '', usage: null,
  messages: [
    { id: 'm1', role: 'user', text: 'What is due?', created_at: '' },
    { id: 'm2', role: 'assistant', text: 'TASK-2026-', created_at: '', status: 'streaming', steps: 0 },
  ],
};

const streamed = applyStreamEvent(conversation, { type: 'text', message_id: 'm2', text: '0001 is due.' });
check('streamed words are added to their answer', streamed?.messages[1]?.text === 'TASK-2026-0001 is due.');
check('the conversation shown is not changed in place', conversation.messages[1]!.text === 'TASK-2026-');
const stepped = applyStreamEvent(streamed, { type: 'step', message_id: 'm2', step: { kind: 'read', path: 'tasks/x.md' }, steps: 3 });
check('a step updates the count and the last step', stepped?.messages[1]?.steps === 3 && stepped.messages[1]!.last_step?.path === 'tasks/x.md');
check('an event for a message not shown changes nothing', applyStreamEvent(conversation, { type: 'text', message_id: 'other', text: 'x' }) === conversation);
const whole = { ...conversation, title: 'From the server' };
check('the whole conversation always wins', applyStreamEvent(stepped, { type: 'conversation', conversation: whole }) === whole);
check('a deleted conversation is gone', applyStreamEvent(conversation, { type: 'deleted' }) === null);
check('usage is replaced', applyStreamEvent(conversation, { type: 'usage', usage: { context_used: 1, context_window: 2 } })?.usage?.context_window === 2);

// A send answered (HTTP 202) after the stream already finished the answer: the finished answer stays.
const question = { id: 'm3', role: 'user' as const, text: 'And next week?', created_at: '' };
const accepted: Conversation = { ...conversation, busy: true, messages: [...conversation.messages, question, { id: 'm4', role: 'assistant', text: '', created_at: '', status: 'streaming', steps: 0 }] };
const finished: Conversation = { ...accepted, busy: false, messages: [...conversation.messages, question, { id: 'm4', role: 'assistant', text: 'Nothing is due.', created_at: '', status: 'done', steps: 1 }] };
check('a late send answer never undoes an answer the stream finished', newerOf(finished, accepted) === finished);
const streaming = applyStreamEvent(accepted, { type: 'text', message_id: 'm4', text: 'Nothing' })!;
check('nor the words streamed so far', newerOf(streaming, accepted) === streaming);
check('a page that has not seen the new message yet takes the answer', newerOf(conversation, accepted) === accepted);
check('the answer for another chat is not merged into this one', newerOf({ ...finished, id: 'chat-other00001' }, accepted) === accepted);
check('nothing shown yet: the answer', newerOf(null, accepted) === accepted);

// Refused because the server has another workspace open: the chat says it in its own words, not the update's.
const refused = Object.assign(new Error('This update is in another workspace. Switch to it, then open the update.'), { status: 409, code: 'other_workspace' });
const said = chatError(refused, () => 'This chat belongs to another workspace.') as Error & { status?: number; code?: string };
check('another workspace: the chat\'s own text, status and code kept', said.message === 'This chat belongs to another workspace.' && said.status === 409 && said.code === 'other_workspace');
const busy = Object.assign(new Error('The assistant is still answering.'), { status: 409, code: 'busy' });
check('other refusals pass as they came', chatError(busy, () => 'x') === busy && chatError('oops', () => 'x') === 'oops');

// The whole conversation read again (words for an answer not shown yet) arrives after the stream's final snapshot.
const resynced = { ...accepted, messages: accepted.messages.map((m) => (m.id === 'm4' ? { ...m, text: 'Nothing' } : m)) };
check('a late read-again never rolls back the final answer', newerOf(finished, resynced) === finished);

// Words the page missed while it did not have the answer yet, read again while the answer goes on, in either order.
const live: Conversation = { ...accepted, messages: accepted.messages.map((m) => (m.id === 'm4' ? { ...m, text: 'second' } : m)) };
const prefix: Conversation = { ...accepted, messages: accepted.messages.map((m) => (m.id === 'm4' ? { ...m, text: 'first ' } : m)) };
const answerText = (c: Conversation | null) => c?.messages.find((m) => m.id === 'm4')?.text;
check('read after the 202 and newer words: the missed beginning goes in front', answerText(newerOf(live, prefix)) === 'first second', answerText(newerOf(live, prefix)));
const readFirst = newerOf(null, prefix);
const thenSent = newerOf(readFirst, accepted);
check('read before the 202: the 202\'s empty answer does not wipe the words', answerText(thenSent) === 'first ');
check('and the next words follow them', answerText(applyStreamEvent(thenSent, { type: 'text', message_id: 'm4', text: 'second' })) === 'first second');
const overlapping: Conversation = { ...accepted, messages: accepted.messages.map((m) => (m.id === 'm4' ? { ...m, text: 'first second' } : m)) };
check('a read that already has the newer words is not doubled', answerText(newerOf(live, overlapping)) === 'first second');
check('longer streamed text stays', newerOf(overlapping, prefix) === overlapping);
const ready = (status: 'streaming' | 'done'): Conversation => ({ ...accepted, busy: status === 'streaming', messages: accepted.messages.map((m) => (m.id === 'm4' ? { ...m, text: 'Ready', status } : m)) });
const tie = newerOf(ready('streaming'), ready('done'));
check('the same words read again as ended take the ended status, and the chat is no longer busy', tie.messages.find((m) => m.id === 'm4')?.status === 'done' && tie.busy === false);
check('an ended answer read again wins over words still streaming', answerText(newerOf(live, finished)) === 'Nothing is due.');

// Switching workspace while the tools of the first are checked: the new one gets its own check.
check('a check ending for the workspace checked clears it', checkEnded('/ws/a', '/ws/a') === null);
check('a check of the old workspace ending leaves the new one\'s going', checkEnded('/ws/b', '/ws/a') === '/ws/b');

check('context: a share of the window', contextPercent({ context_used: 50_000, context_window: 200_000 }) === 25);
check('context: unknown when the tool has not said', contextPercent({ context_used: 10, context_window: null }) === null && contextPercent(null) === null);
check('context: never over 100', contextPercent({ context_used: 300, context_window: 200 }) === 100);

check('plan: a window at its limit is shown first', tightestWindow([{ kind: 'five_hour', used_percent: 90, resets_at: null, limited: false }, { kind: 'weekly', used_percent: 100, resets_at: null, limited: true }])?.kind === 'weekly');
check('plan: otherwise the fullest', tightestWindow([{ kind: 'five_hour', used_percent: 20, resets_at: null, limited: false }, { kind: 'weekly', used_percent: 70, resets_at: null, limited: false }])?.kind === 'weekly');
check('plan: nothing reported, nothing shown', tightestWindow(null) === null && tightestWindow([]) === null);

check('an expired sign-in offers to check again, then to retry', same(errorActions('sign_in'), ['check_again', 'retry']));
check('a plan limit offers another tool, never a retry that would fail', same(errorActions('plan_limit'), ['switch_provider']));
check('a full context offers a new chat', same(errorActions('context_full'), ['new_chat']));
check('a crash offers a retry', errorActions('crashed')[0] === 'retry');

check('Enter sends', composerKey({ key: 'Enter', shiftKey: false }) === 'send');
check('Shift+Enter is a new line', composerKey({ key: 'Enter', shiftKey: true }) === null);
check('Enter while an input method composes never sends (Japanese input)', composerKey({ key: 'Enter', shiftKey: false, isComposing: true }) === null);
check('Safari composing Enter (keyCode 229) never sends', composerKey({ key: 'Enter', shiftKey: false, keyCode: 229 }) === null);
check('other keys do nothing', composerKey({ key: 'a', shiftKey: false }) === null);

const p = (id: ProviderStatus['id'], ready: boolean, installed = true): ProviderStatus => ({ id, label: id, installed, ready, problems: [], plan: null, models: [], limits: null, notes: [] });
check('default: the tool used before, when ready', defaultProvider([p('claude-code', true), p('codex', true)], ['claude-code'], 'codex') === 'codex');
check('default: the workspace\'s first ready tool', defaultProvider([p('claude-code', false), p('codex', true), p('copilot', true)], ['copilot', 'codex']) === 'copilot');
check('default: any ready tool', defaultProvider([p('claude-code', false), p('codex', true)], ['claude-code']) === 'codex');
check('default: none ready, the installed one set up, so the page can say what it needs', defaultProvider([p('claude-code', false), p('codex', false)], ['codex']) === 'codex');
check('default: nothing installed', defaultProvider([p('claude-code', false, false)], []) === null);

check('images become links, so nothing is fetched without a click', safeMarkdown('See ![chart](https://example.com/x?d=secret) and ![a][ref]') === 'See [chart](https://example.com/x?d=secret) and [a][ref]');
check('text without images is unchanged', safeMarkdown('**TASK-2026-0001** is [here](/board)') === '**TASK-2026-0001** is [here](/board)');

check('page context: the path of a page', pageContext('/board/task/TASK-2026-0001') === '/board/task/TASK-2026-0001');
check('page context: none on the home page or for odd paths', pageContext('/') === null && pageContext('/../x') === null && pageContext('/a b') === null);

const now = Date.parse('2026-11-18T10:00:00Z');
check('resets in minutes', untilText('2026-11-18T10:30:00Z', now, 'en') === 'in 30 minutes');
check('resets in hours', untilText('2026-11-18T13:00:00Z', now, 'en') === 'in 3 hours');
check('resets in days', untilText('2026-11-21T10:00:00Z', now, 'en') === 'in 3 days');
check('a time in the past says nothing', untilText('2026-11-18T09:00:00Z', now, 'en') === null && untilText(null, now, 'en') === null);

const claude: ProviderStatus = { ...p('claude-code', true), models: [
  { id: 'haiku', label: 'Haiku', description: null, efforts: ['low', 'high'], is_default: false },
  { id: 'default', label: 'Default', description: null, efforts: ['low', 'medium', 'high'], is_default: true },
] };
check('models: the tool\'s default first', modelOptions(claude)[0]?.id === 'default');
check('efforts: of the chosen model', same(effortOptions(claude, 'haiku'), ['low', 'high']));
check('efforts: of the default when none is chosen', same(effortOptions(claude, null), ['low', 'medium', 'high']));
check('efforts: none for a tool that lists no models', same(effortOptions(p('copilot', true), 'x'), []));

if (failures) {
  console.error(`${failures} chat check(s) failed`);
  process.exit(1);
}
console.log('All chat checks passed');
