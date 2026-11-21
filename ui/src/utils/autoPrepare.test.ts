/**
 * Unit tests for the "Prepare meetings for review automatically" switch (#484): what it says in each state.
 * Run with `npm run test:auto-prepare --workspace=ui`.
 */
import { accountText, autoPrepareMode, autoPrepareView, confirmation, confirmedAccount, editedSettings, runnerIssue } from './autoPrepare';
import type { RunnerStatus } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const settings = (after_each_meeting: boolean, auto_analyze: boolean, enabled = true) => ({ enabled, after_each_meeting, auto_analyze });
const ready: RunnerStatus = {
  id: 'claude', label: 'Claude Code', installed: true, logged_in: true, trusted: true, problems: [],
  account: { email: 'someone@example.com', organization: 'Example Team', plan: 'max' },
};
const problem = (code: string, message = 'Sign in to the runner, then try again.'): RunnerStatus => ({ ...ready, problems: [{ code, message }], account: null });
const codes = (v: ReturnType<typeof autoPrepareView>) => v.issues.map((i) => i.code).join(',');

check('the mode: both on, both off, or one of them', autoPrepareMode(settings(true, true)) === 'on' && autoPrepareMode(settings(false, false)) === 'off'
  && autoPrepareMode(settings(true, false)) === 'mixed' && autoPrepareMode(settings(false, true)) === 'mixed');

const on = autoPrepareView(settings(true, true), ready);
check('on, runner ready: no issues, and it says what happens', on.mode === 'on' && on.issues.length === 0 && /without a click/.test(on.summary), on.summary);

const off = autoPrepareView(settings(false, false, false), ready);
check('off and runner ready: no issues even paused, and it can be turned on', off.mode === 'off' && off.issues.length === 0 && off.canTurnOn && /start each analysis yourself/.test(off.summary));

// The runner not ready: the switch cannot be turned on, and says why with what to fix (#484, the executive's call).
const blocked = autoPrepareView(settings(false, false), problem('not_logged_in'));
check('off, runner not ready: blocked, with the reason and the runner\'s own fix', !blocked.canTurnOn && codes(blocked) === 'runner_not_ready'
  && blocked.issues[0]!.text === 'The background runner (Claude Code) is not ready, so no analysis can start.' && blocked.issues[0]!.fix === 'Sign in to the runner, then try again.');
check('readiness comes from the runner status, whatever the runner: any problem blocks, none lets it on',
  !autoPrepareView(settings(false, false), { ...problem('some_new_check'), id: 'other', label: 'Other assistant' }).canTurnOn
  && autoPrepareView(settings(false, false), { ...ready, id: 'other', label: 'Other assistant', account: null }).canTurnOn);
check('off, runner still being checked: blocked, nothing said yet', !autoPrepareView(settings(false, false), undefined).canTurnOn && autoPrepareView(settings(false, false), undefined).issues.length === 0);
check('off, runner could not be checked: blocked, said so', !autoPrepareView(settings(false, false), null).canTurnOn && codes(autoPrepareView(settings(false, false), null)) === 'runner_unknown');
check('only right after each meeting, runner not ready: blocked from turning fully on', (() => {
  const v = autoPrepareView(settings(true, false), problem('not_trusted'));
  return !v.canTurnOn && codes(v) === 'only_digest,runner_not_ready';
})());
check('on, runner not ready: the problem shows (turning off stays possible in the component)', codes(autoPrepareView(settings(true, true), problem('not_installed'))) === 'runner_not_ready');

const onlyDigest = autoPrepareView(settings(true, false), ready);
check('only right after each meeting: says analysis is by hand',
  codes(onlyDigest) === 'only_digest' && /you start each analysis yourself/.test(onlyDigest.issues[0]!.text) && /Turn the switch on/.test(onlyDigest.issues[0]!.fix), codes(onlyDigest));

const onlyAnalysis = autoPrepareView(settings(false, true), ready);
check('only automatic analysis: says digests follow the schedule', codes(onlyAnalysis) === 'only_analysis' && /only on the schedule/.test(onlyAnalysis.issues[0]!.text));

const paused = autoPrepareView(settings(true, true, false), ready);
check('paused: shown with where to resume', codes(paused) === 'paused' && /paused/.test(paused.issues[0]!.text) && /Resume/.test(paused.issues[0]!.fix));

check('the runner\'s own message is the fix', runnerIssue(problem('not_subscription', 'Use a Claude plan.'))?.fix === 'Use a Claude plan.');
check('runner still being checked: nothing said yet; could not check: said so', runnerIssue(undefined) === null && runnerIssue(null)?.code === 'runner_unknown');
check('paused, mixed and no runner together: all three, in that order',
  codes(autoPrepareView(settings(false, true, false), problem('not_trusted'))) === 'only_analysis,paused,runner_not_ready');

check('the account as the analysis panel says it', accountText(ready.account) === 'someone@example.com (Example Team, max)'
  && accountText({ email: 'a@example.com', organization: "a@example.com's Organization", plan: 'pro' }) === 'a@example.com (pro)'
  && accountText(null) === '' && accountText({ email: null, organization: null, plan: 'pro' }) === '');

const ask = confirmation(ready, { enabled: true, open_digest: null, analyze_open_digest: 'no' });
check('the dialog: account and plan, plan usage, nothing changes until approved',
  ask.lines.some((l) => l.includes('Claude Code, signed in as someone@example.com (Example Team, max)'))
  && ask.lines.some((l) => /plan's usage/.test(l)) && ask.lines.some((l) => /Nothing changes in your context until you approve/.test(l))
  && ask.warnings.length === 0, JSON.stringify(ask.lines));
check('the dialog: account not known is said plainly', confirmation(null, { enabled: true, open_digest: null, analyze_open_digest: 'no' }).lines[1]!.includes('could not be read'));
check('the dialog: an open ready digest is analyzed at once',
  confirmation(ready, { enabled: true, open_digest: 'CU-2026-0007', analyze_open_digest: 'yes' }).lines.at(-1) === 'Digest CU-2026-0007 is open and ready: its analysis starts within a minute.');
check('the dialog: paused, it starts once resumed, and the pause is a warning', (() => {
  const c = confirmation(ready, { enabled: false, open_digest: 'CU-2026-0007', analyze_open_digest: 'yes' });
  return /as soon as the Meeting digest is resumed/.test(c.lines.at(-1)!) && c.warnings.map((w) => w.code).join() === 'paused';
})());
check('the dialog: an open digest that will not start is said too',
  /not started again by this switch/.test(confirmation(ready, { enabled: true, open_digest: 'CU-2026-0007', analyze_open_digest: 'no' }).lines.at(-1)!));
check('the dialog: a runner problem is a warning, and Turn on is not allowed', (() => {
  const c = confirmation(problem('not_logged_in'), { enabled: true, open_digest: null, analyze_open_digest: 'no' });
  return c.warnings.map((w) => w.code).join() === 'runner_not_ready' && !c.canConfirm;
})());
check('the dialog: while its own runner check runs, no account is shown and Turn on waits', (() => {
  const c = confirmation(undefined, { enabled: true, open_digest: null, analyze_open_digest: 'no' });
  return c.checking && !c.canConfirm && !c.lines.some((l) => /signed in|account/.test(l));
})());
check('the dialog: its check could not be made: Turn on is not allowed', !confirmation(null, { enabled: true, open_digest: null, analyze_open_digest: 'no' }).canConfirm);
check('the dialog: ready from its own check: allowed, with that check\'s account', (() => {
  const c = confirmation({ ...ready, account: { email: 'new@example.com', organization: null, plan: 'pro' } }, { enabled: true, open_digest: null, analyze_open_digest: 'no' });
  return c.canConfirm && !c.checking && c.lines.some((l) => l.includes('signed in as new@example.com (pro)'));
})());
check('the dialog: an interrupted digest still to be finished: its analysis may start', (() => {
  const now = confirmation(ready, { enabled: true, open_digest: 'CU-2026-0007', analyze_open_digest: 'maybe' }).lines.at(-1)!;
  const later = confirmation(ready, { enabled: false, open_digest: null, analyze_open_digest: 'maybe' }).lines.at(-1)!;
  return /may start within a minute/.test(now) && /may start as soon as the Meeting digest is resumed/.test(later);
})());

check('the account sent with Turn on is the one the dialog\'s check showed', confirmedAccount(ready) === 'someone@example.com'
  && confirmedAccount({ ...ready, account: { email: null, organization: 'Example Team', plan: 'team' } }) === 'Example Team'
  && confirmedAccount({ ...ready, account: null }) === null && confirmedAccount(undefined) === null);

// The settings editor saves only what it changed (#484): a turn-off made in another tab survives a later save there.
const openedWith = { enabled: true, max_meetings: 10, after_each_meeting: true, auto_analyze: true, schedule: { time: '18:00' }, updated_at: 'a' };
check('the editor sends only the edited fields, never the flags it did not touch',
  JSON.stringify(editedSettings(openedWith, { ...openedWith, max_meetings: 3, updated_at: 'b' })) === JSON.stringify({ max_meetings: 3 }));
check('the editor: a changed schedule is sent whole; nothing changed sends nothing',
  JSON.stringify(editedSettings(openedWith, { ...openedWith, schedule: { time: '17:00' } })) === JSON.stringify({ schedule: { time: '17:00' } })
  && editedSettings(openedWith, { ...openedWith }) === null);
check('the editor: a flag the user did change there is sent', JSON.stringify(editedSettings(openedWith, { ...openedWith, auto_analyze: false })) === JSON.stringify({ auto_analyze: false }));

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
