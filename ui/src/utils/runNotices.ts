import { tr } from '@/i18n/current';
/**
 * Saying that a run started from the dashboard finished, when the user is elsewhere (#246): a native notification in
 * the desktop app (which writes the words itself), the browser's in a browser (only once the user allowed it). On by
 * default; Settings turns it off. Kept in this browser (or the desktop app), like the other display preferences.
 */

export const RUN_NOTICES_KEY = 'gtd:run-notices';

export function runNoticesOn(): boolean {
  try { return localStorage.getItem(RUN_NOTICES_KEY) !== '0'; } catch { return true; }
}

export function setRunNoticesOn(on: boolean): void {
  try { localStorage.setItem(RUN_NOTICES_KEY, on ? '1' : '0'); } catch { /* not kept: on by default next time */ }
}

/** The server's `run-finished` event: which update, and in which workspace. The run itself is read from the update. */
export function finishedRun(value: unknown): { update_id: string; workspace: string } | null {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (typeof o['update_id'] !== 'string' || !/^CU-\d{4}-\d{4}$/.test(o['update_id'])) return null;
  return { update_id: o['update_id'], workspace: typeof o['workspace'] === 'string' ? o['workspace'] : '' };
}

/** A run of an update as `GET /api/context-updates/:id/run` returns it (the parts used here). */
export interface RunRecord { command: 'analyze' | 'apply'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; started_at: string; ended_at: string | null }

/** What a notice says, as data: the desktop app writes the same words from it. */
export interface RunNotice {
  update_id: string;
  workspace: string;
  started_at: string;
  outcome: 'review' | 'applied' | 'analyze-failed' | 'apply-failed';
  title: string;
  /** Null when not known: never said as "no changes". */
  proposals: number | null;
}

/**
 * What became of a run this page saw waiting in line (#344), from the next answer about the update's run (`null`: none):
 * - `waiting`: still in line; `going`: it started; `known`: it ended in a way the server still knows (finished,
 *   removed from the line, also from another tab, or dropped with its reason);
 * - `lost`: the server no longer knows it (none, or an older run): the line is kept in memory only, so the dashboard
 *   restarted or another workspace is open now.
 */
export function waitingOutcome(waitingSince: string, latest: Pick<RunRecord, 'status' | 'started_at'> | null): 'waiting' | 'going' | 'known' | 'lost' {
  if (latest?.status === 'queued') return 'waiting';
  if (latest?.status === 'running') return 'going';
  return latest && latest.started_at >= waitingSince ? 'known' : 'lost';
}

/** A finished run as a notice, or null when nothing is said (waiting, still running, or stopped by the user, who knows). */
export function noticeFor(update_id: string, workspace: string, run: RunRecord, update: { title: string; proposals: number } | null): RunNotice | null {
  if (run.status === 'queued' || run.status === 'running' || run.status === 'cancelled') return null;
  const outcome = run.status === 'failed' ? (run.command === 'analyze' ? 'analyze-failed' : 'apply-failed') : run.command === 'analyze' ? 'review' : 'applied';
  return { update_id, workspace, started_at: run.started_at, outcome, title: cleanTitle(update?.title), proposals: update ? update.proposals : null };
}

/** Text from a workspace file, safe for a system notice: one line, no control or direction characters, at most 80. */
export function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

/** The words, the same as the desktop app's (desktop/src/run-notice.ts). */
export function noticeWords(n: RunNotice): { title: string; body: string } {
  const what = n.title ? `${n.title}: ` : '';
  switch (n.outcome) {
    case 'review': {
      const proposed = n.proposals === null ? tr('runNotices.theAnalysisFinishedOpenIt')
        : tr('runNotices.theAnalysisProposed', { value: n.proposals === 0 ? tr('runNotices.noChanges') : n.proposals === 1 ? tr('runNotices.1Change') : tr('runNotices.changes', { proposals: n.proposals }) });
      return { title: tr('runNotices.isReadyForYourReview', { update_id: n.update_id }), body: `${what}${proposed}` };
    }
    case 'applied': return { title: tr('runNotices.isApplied', { update_id: n.update_id }), body: tr('runNotices.yourAcceptedChangesAreWritten', { what }) };
    case 'analyze-failed': return { title: tr('runNotices.theAnalysisOfDidNot', { update_id: n.update_id }), body: tr('runNotices.openItToSeeWhy', { what }) };
    case 'apply-failed': return { title: tr('runNotices.theApplyOfDidNot', { update_id: n.update_id }), body: tr('runNotices.openItToSeeWhy', { what }) };
  }
}

/** One run, wherever it is reported from: its workspace, update and start. */
export const noticeKey = (n: Pick<RunNotice, 'workspace' | 'update_id' | 'started_at'>) => `${n.workspace}\u0000${n.update_id}\u0000${n.started_at}`;

// ---- Several dashboards (tabs) of one browser: none says it while one is in front, and only one says it. ----

const FRONT_KEY = 'gtd:dashboard-front';
const CLAIM_PREFIX = 'gtd:run-notice:';
/** A tab in front says so this often; older than three beats, it is taken as gone. */
export const FRONT_BEAT_MS = 10_000;
const FRONT_STALE_MS = 3 * FRONT_BEAT_MS;

/** This tab is in front now (or not): kept fresh while it is. */
export function markFront(tab: string, front: boolean, now = Date.now()): void {
  try {
    if (front) localStorage.setItem(FRONT_KEY, JSON.stringify({ tab, at: now }));
    else if ((JSON.parse(localStorage.getItem(FRONT_KEY) ?? 'null') as { tab?: string } | null)?.tab === tab) localStorage.removeItem(FRONT_KEY);
  } catch { /* no storage: each tab decides for itself */ }
}

/** Whether another dashboard tab is in front right now. */
export function anotherTabInFront(tab: string, now = Date.now()): boolean {
  try {
    const front = JSON.parse(localStorage.getItem(FRONT_KEY) ?? 'null') as { tab?: string; at?: number } | null;
    return Boolean(front && front.tab !== tab && typeof front.at === 'number' && now - front.at < FRONT_STALE_MS);
  } catch { return false; }
}

/**
 * Takes the right to say this run, once across tabs, and says it inside `deliver` while holding it: under the browser's
 * Web Lock (atomic across tabs) where there is one, else a written claim read back after a moment. `deliver` checks
 * again whether to say it, and returns false when it did not, so the run can still be said later. Claims older than
 * a day go.
 */
export async function claimNotice(key: string, tab: string, deliver: () => boolean | Promise<boolean> = () => true, now = Date.now()): Promise<boolean> {
  const locks = (globalThis as { navigator?: { locks?: { request: (name: string, cb: () => Promise<boolean>) => Promise<boolean> } } }).navigator?.locks;
  if (locks) {
    return locks.request(`gtd-run-notice-${key}`, async () => {
      if (taken(key)) return false;
      if (!(await deliver())) return false;
      mark(key, tab, now);
      return true;
    });
  }
  if (!(await claimByWriting(key, tab, now))) return false;
  if (await deliver()) return true;
  release(key);
  return false;
}

function taken(key: string): boolean {
  try { return Boolean(localStorage.getItem(CLAIM_PREFIX + key)); } catch { return false; }
}

function mark(key: string, tab: string, now: number): void {
  try { prune(now); localStorage.setItem(CLAIM_PREFIX + key, JSON.stringify({ tab, at: now })); } catch { /* no storage */ }
}

function release(key: string): void {
  try { localStorage.removeItem(CLAIM_PREFIX + key); } catch { /* no storage */ }
}

function prune(now: number): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const name = localStorage.key(i);
    if (!name?.startsWith(CLAIM_PREFIX)) continue;
    const at = (JSON.parse(localStorage.getItem(name) ?? 'null') as { at?: number } | null)?.at;
    if (typeof at !== 'number' || now - at > 24 * 60 * 60 * 1000) localStorage.removeItem(name);
  }
}

/** Without Web Locks: write a claim and read it back after a moment (the last writer wins). */
async function claimByWriting(key: string, tab: string, now: number): Promise<boolean> {
  try {
    prune(now);
    const name = CLAIM_PREFIX + key;
    if (localStorage.getItem(name)) return false;
    localStorage.setItem(name, JSON.stringify({ tab, at: now }));
    await new Promise((r) => setTimeout(r, 60));
    return (JSON.parse(localStorage.getItem(name) ?? 'null') as { tab?: string } | null)?.tab === tab;
  } catch { return true; }
}
