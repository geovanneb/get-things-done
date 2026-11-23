/**
 * Unit tests for Settings → Assistant accounts (#505): what each account shows and allows, in plain words.
 * Run with `npm run test:assistant-accounts --workspace=ui`.
 */
import { accountActions, accountLine, accountSubline, defaultMethod, offeredMethods, planText, showChoice, signInResult } from './assistantAccounts';
import type { AssistantAccount, AssistantAccountsView, AssistantSignIn } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const account = (over: Partial<AssistantAccount> = {}): AssistantAccount => ({
  folder: '/home/someone/.claude-work', path_label: '~/.claude-work', name: null, kind: 'found', chosen: false, problem: null,
  signed_in: true, plan_ok: true, account: { email: 'someone@example.com', organization: 'Example Team', plan: 'pro' },
  last_method: null, terminal_command: 'claude auth login', ...over,
});
const claude: AssistantAccountsView = { id: 'claude-code', label: 'Claude Code', installed: true, choosable: true, methods: ['claudeai', 'sso', 'console'], sso: 'option', can_sign_out: true, chosen: null, accounts: [account()] };

check('plans read as people say them', planText('pro') === 'Pro plan' && planText('max') === 'Max plan' && planText('enterprise_team') === 'Enterprise Team plan' && planText(null) === null, String(planText('enterprise_team')));
check('a plan that already names itself is kept', planText('Copilot Business') === 'Copilot Business');
check('signed in: named by the email, never the folder', accountLine(account()) === 'Signed in as someone@example.com', accountLine(account()));
check('the subline: the name given and the plan', accountSubline(account({ name: 'Work' })) === 'Work · Pro plan', accountSubline(account({ name: 'Work' })));
check('no email: the organization', accountLine(account({ account: { email: null, organization: 'Example Team', plan: null } })) === 'Signed in as Example Team');
check('signed in without details', accountLine(account({ account: null })) === 'Signed in');
check('not signed in', accountLine(account({ signed_in: false, account: null })) === 'Not signed in' && accountSubline(account({ signed_in: false, account: null })) === '');
check('not checked', accountLine(account({ signed_in: null, account: null })) === 'Could not check who is signed in');
check('a problem is said instead, in its own plain words', accountLine(account({ problem: 'That folder does not exist.' })) === 'That folder does not exist.');
check('no path or variable in any line', ![accountLine(account()), accountSubline(account({ name: 'Work' }))].some((t) => /[/\\]|CLAUDE_CONFIG_DIR|CODEX_HOME/.test(t)));

check('one account: no list', !showChoice(claude) && showChoice({ accounts: [account(), account()] }));
check('Console only under Details, or when last used', offeredMethods(claude, account(), false).join() === 'claudeai,sso'
  && offeredMethods(claude, account(), true).join() === 'claudeai,sso,console' && offeredMethods(claude, account({ last_method: 'console' }), false).includes('console'));
check('Sign in again uses the method last used', defaultMethod(claude, account({ last_method: 'sso' })) === 'sso' && defaultMethod(claude, account()) === 'claudeai' && defaultMethod({ methods: [] }, null) === null);

const ready = accountActions(claude, account(), false);
check('a signed-in account: use, sign in again, sign out; a found one is never removed', ready.use && ready.signIn && ready.signOut && !ready.remove);
const chosen = accountActions(claude, account({ chosen: true, kind: 'added' }), false);
check('the account in use: not offered again, not removed', !chosen.use && !chosen.remove && chosen.signOut);
check('an added account can be removed from the list', accountActions(claude, account({ kind: 'added' }), false).remove);
const going = accountActions(claude, account(), true);
check('while a sign-in goes: no other sign-in or sign-out', !going.signIn && !going.signOut && going.use);
const broken = accountActions(claude, account({ problem: 'gone', kind: 'added' }), false);
check('an account with a problem: only removal', !broken.use && !broken.signIn && !broken.signOut && broken.remove);
check('signed out: no sign-out', !accountActions(claude, account({ signed_in: false }), false).signOut);
const copilot = accountActions({ installed: true, methods: [], can_sign_out: false }, account({ kind: 'default', chosen: true }), false);
check('Copilot: neither sign-in nor sign-out from the app', !copilot.signIn && !copilot.signOut && !copilot.use);
check('not installed: nothing to start', !accountActions({ ...claude, installed: false }, account(), false).signIn);

const state = (over: Partial<AssistantSignIn>): AssistantSignIn => ({ assistant: 'claude-code', folder: null, method: 'claudeai', status: 'running', url: null, message: null, started_at: '', ended_at: null, ...over });
check('while running: no result line', signInResult(state({})) === null);
check('succeeded', signInResult(state({ status: 'succeeded' }))?.text === 'You are signed in.');
check('cancelled is a warning', signInResult(state({ status: 'cancelled' }))?.tone === 'warning');
check('failed: the plain reason', signInResult(state({ status: 'failed', message: 'The sign-in did not finish. Try again.' }))?.text === 'The sign-in did not finish. Try again.');

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('All assistant account checks passed');
