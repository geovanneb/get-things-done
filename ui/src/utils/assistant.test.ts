/**
 * Unit tests for the workspace assistant helpers. Run with `npm run test:assistant --workspace=ui`.
 */
import { otherRequests, requestText, workspaceAssistants } from './assistant';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check('an older server that does not say: Claude Code', same(workspaceAssistants(undefined), ['claude-code']));
check('unknown names are ignored', same(workspaceAssistants(['gemini', 'codex']), ['codex']));
check('the server order is kept', same(workspaceAssistants(['codex', 'copilot']), ['codex', 'copilot']));

check('Claude Code gets its slash commands', requestText('claude-code', 'task', 'TASK-2026-0001') === '/gtd-task TASK-2026-0001'
  && requestText('claude-code', 'analyze', 'CU-2026-0001') === '/gtd-context-analyze CU-2026-0001'
  && requestText('claude-code', 'apply', 'CU-2026-0001') === '/gtd-context-apply CU-2026-0001');
check('Codex and Copilot get plain words', requestText('codex', 'task', 'TASK-2026-0001') === 'Execute task TASK-2026-0001'
  && requestText('copilot', 'analyze', 'CU-2026-0001') === 'Analyze context update CU-2026-0001'
  && requestText('codex', 'apply', 'CU-2026-0001') === 'Apply context update CU-2026-0001');

check('one assistant: nothing else to show', same(otherRequests(['codex'], 'task', 'TASK-2026-0001'), []));
check('the others are grouped by the text they share',
  same(otherRequests(['claude-code', 'codex', 'copilot'], 'analyze', 'CU-2026-0001'), [{ labels: 'Codex / Copilot', text: 'Analyze context update CU-2026-0001', tools: ['codex', 'copilot'] }]));
check('an other with the same text as the first is left out', same(otherRequests(['codex', 'copilot'], 'apply', 'CU-2026-0001'), []));
check('Claude Code as the other one', same(otherRequests(['codex', 'claude-code'], 'apply', 'CU-2026-0001'), [{ labels: 'Claude Code', text: '/gtd-context-apply CU-2026-0001', tools: ['claude-code'] }]));

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('ALL PASS');
