import { tr } from '@/i18n/current';
import { serverText } from '@/i18n/serverText';
import type { RunnerStatus } from '@/types';

/**
 * "Prepare meetings for review automatically" (#484): one switch over the Meeting digest's two flags, Right after each
 * meeting and Analyze automatically. What it shows is worked out here, from the settings and the runner status, so the
 * wording for every state can be tested without a page.
 */

export interface AutoPrepareSettings { enabled: boolean; after_each_meeting: boolean; auto_analyze: boolean }

/** The runner status from GET /api/runner: undefined while it is being checked, null when it could not be checked. */
export type RunnerCheck = RunnerStatus | null | undefined;

export type AutoPrepareMode = 'off' | 'on' | 'mixed';

export interface AutoPrepareIssue {
  code: 'only_digest' | 'only_analysis' | 'paused' | 'runner_unknown' | 'runner_not_ready';
  tone: 'warning' | 'critical';
  /** What is wrong, in plain words. */
  text: string;
  /** What to do about it. */
  fix: string;
}

export interface AutoPrepareView {
  mode: AutoPrepareMode;
  summary: string;
  issues: AutoPrepareIssue[];
  /** Whether the switch may be turned on: only once the runner is checked and ready. Turning it off is always possible. */
  canTurnOn: boolean;
}

export function autoPrepareMode(s: AutoPrepareSettings): AutoPrepareMode {
  if (s.after_each_meeting && s.auto_analyze) return 'on';
  return s.after_each_meeting || s.auto_analyze ? 'mixed' : 'off';
}

/**
 * Why the background runner cannot start an analysis now, if it cannot. Read from the runner status only (any problem
 * it reports, with its own message saying what to fix), so it holds for every runner, not one assistant's checks.
 * Null while still checking, or when the runner is ready.
 */
export function runnerIssue(runner: RunnerCheck): AutoPrepareIssue | null {
  if (runner === undefined) return null;
  if (runner === null) return { code: 'runner_unknown', tone: 'warning', text: tr('autoPrepare.runnerUnknown'), fix: tr('autoPrepare.runnerUnknownFix') };
  const problem = runner.problems[0];
  if (!problem && runner.installed) return null;
  return { code: 'runner_not_ready', tone: 'critical', text: tr('autoPrepare.runnerNotReady', { label: runner.label }), fix: serverText(problem?.message) ?? '' };
}

/** The switch's state, a line on what it does now, and each thing that keeps it from working, with what to fix. */
export function autoPrepareView(s: AutoPrepareSettings, runner: RunnerCheck): AutoPrepareView {
  const mode = autoPrepareMode(s);
  const issues: AutoPrepareIssue[] = [];
  if (mode === 'mixed') {
    issues.push(s.after_each_meeting
      ? { code: 'only_digest', tone: 'warning', text: tr('autoPrepare.onlyDigest'), fix: tr('autoPrepare.onlyDigestFix') }
      : { code: 'only_analysis', tone: 'warning', text: tr('autoPrepare.onlyAnalysis'), fix: tr('autoPrepare.onlyAnalysisFix') });
  }
  if (mode !== 'off' && !s.enabled) issues.push(pausedIssue());
  // Shown while automatic analysis is on, and while the switch is off: then it is why it cannot be turned on.
  const problem = s.auto_analyze || mode !== 'on' ? runnerIssue(runner) : null;
  if (problem) issues.push(problem);
  const summary = mode === 'on' ? tr('autoPrepare.onSummary') : mode === 'mixed' ? tr('autoPrepare.mixedSummary') : tr('autoPrepare.offSummary');
  return { mode, summary, issues, canTurnOn: runner !== undefined && !problem };
}

function pausedIssue(): AutoPrepareIssue {
  return { code: 'paused', tone: 'warning', text: tr('autoPrepare.paused'), fix: tr('autoPrepare.pausedFix') };
}

/** The signed-in account as "email (organization, plan)", the way the analysis panel says it. Empty when unknown. */
export function accountText(account: RunnerStatus['account']): string {
  // A personal plan's organization is often named after the email: then it is left out.
  const organization = account?.organization && !(account.email && account.organization.includes(account.email)) ? account.organization : null;
  const who = account?.email ?? organization ?? '';
  const details = [who === organization ? null : organization, account?.plan].filter(Boolean).join(', ');
  return who ? (details ? `${who} (${details})` : who) : '';
}

/** Which account the dialog's check showed, as the server compares it when turning on: the email, else the organization. */
export function confirmedAccount(runner: RunnerCheck): string | null {
  return runner?.account?.email ?? runner?.account?.organization ?? null;
}

export interface DigestForConfirm { enabled: boolean; open_digest: string | null; analyze_open_digest: 'yes' | 'no' | 'maybe' }

/**
 * What the dialog says before the switch turns on: what happens, with which account, and what to fix first. `runner` is
 * the dialog's own check, made when it opened: Turn on waits for it, and is allowed only when it found the runner
 * ready, so the account shown is the one the analyses will use.
 */
export function confirmation(runner: RunnerCheck, job: DigestForConfirm): { lines: string[]; warnings: AutoPrepareIssue[]; checking: boolean; canConfirm: boolean } {
  const label = runner?.label ?? 'Claude Code';
  const account = runner ? accountText(runner.account) : '';
  const lines = [
    tr('autoPrepare.confirmWhat'),
    ...(runner === undefined ? [] : [account ? tr('autoPrepare.confirmAccount', { label, account }) : tr('autoPrepare.confirmAccountUnknown', { label })]),
    tr('autoPrepare.confirmUsage'),
    tr('autoPrepare.confirmApprove'),
  ];
  if (job.analyze_open_digest === 'maybe') {
    lines.push(job.enabled ? tr('autoPrepare.confirmMaybeNow') : tr('autoPrepare.confirmMaybeResumed'));
  } else if (job.open_digest) {
    lines.push(job.analyze_open_digest === 'no' ? tr('autoPrepare.confirmOpenUnchanged', { id: job.open_digest })
      : job.enabled ? tr('autoPrepare.confirmOpenNow', { id: job.open_digest })
        : tr('autoPrepare.confirmOpenResumed', { id: job.open_digest }));
  }
  const warnings: AutoPrepareIssue[] = [];
  if (!job.enabled) warnings.push(pausedIssue());
  const problem = runnerIssue(runner);
  if (problem) warnings.push(problem);
  return { lines, warnings, checking: runner === undefined, canConfirm: runner !== undefined && !problem };
}

/**
 * What the Meeting digest editor saves: only the settings changed since it opened (#484). Sending the whole draft would
 * put back values another tab changed meanwhile, such as turning automation off. Null when nothing changed.
 */
export function editedSettings<T extends Record<string, unknown>>(opened: T, draft: T): Partial<T> | null {
  const changed = Object.fromEntries(Object.entries(draft).filter(([key, value]) => key !== 'updated_at' && JSON.stringify(value) !== JSON.stringify(opened[key]))) as Partial<T>;
  return Object.keys(changed).length ? changed : null;
}
