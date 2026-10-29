/**
 * Unit tests for the first-run setup logic. Run with `npm run test:setup --workspace=ui`.
 */
import { createRequest, defaultAiTools, initialAnswers, toggleTool, toolsToInstall, type AiToolInfo, type SetupStatus } from './setup';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const tool = (id: AiToolInfo['id'], installed: boolean): AiToolInfo => ({ id, label: id, description: '', installed, install_url: 'https://example.test' });
const none = [tool('claude-code', false), tool('copilot', false), tool('codex', false)];
const some = [tool('claude-code', false), tool('copilot', true), tool('codex', true)];

check('with nothing installed, Claude Code is preselected', JSON.stringify(defaultAiTools(none)) === '["claude-code"]');
check('installed assistants are preselected', JSON.stringify(defaultAiTools(some)) === '["copilot","codex"]');

const status: SetupStatus = {
  configured: false, workspace_path: null, suggested_path: '/Users/demo/Documents/Get Things Done',
  suggested_path_is_workspace: false, recent: [], ai_tools: some,
};
const answers = initialAnswers(status);
check('the suggested folder is the starting point', answers.path === status.suggested_path);

const body = createRequest({ ...answers, path: '  /Users/demo/Northwind  ', name: ' Alex Morgan ', role: 'COO', organization: 'Northwind Labs' });
check('the request trims and creates the folder', body.path === '/Users/demo/Northwind' && body.create === true);
check('the profile is sent trimmed', body.profile.name === 'Alex Morgan' && body.profile.organization === 'Northwind Labs');
check('the chosen assistants are sent', JSON.stringify(body.ai_tools) === '["copilot","codex"]');

check('turning a tool on adds it once', JSON.stringify(toggleTool(toggleTool(['codex'], 'claude-code', true), 'claude-code', true)) === '["codex","claude-code"]');
check('turning a tool off removes it', JSON.stringify(toggleTool(['codex', 'copilot'], 'codex', false)) === '["copilot"]');

const pending = toolsToInstall({ ...answers, aiTools: ['claude-code', 'codex'] }, some);
check('only chosen and missing assistants need installing', pending.map((t) => t.id).join() === 'claude-code');

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll setup checks passed');
