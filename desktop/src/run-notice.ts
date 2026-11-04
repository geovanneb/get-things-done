// Kept apart from the bridge (no Electron here), so the checks can be tested on its own.

/**
 * A finished run, said by the system while the app is not in front. The page only names the run; the app reads the
 * run and its update from its own server, checks the run really ended in that workspace, and writes the words itself.
 * So a page can never make the system say something under the app's name that did not happen.
 */
export interface RunNoticeRequest { update_id: string; workspace: string; started_at: string }

export interface RunNotice extends RunNoticeRequest {
  outcome: 'review' | 'applied' | 'analyze-failed' | 'apply-failed';
  /** The update's title, cleaned; empty when unknown. */
  title: string;
  /** Proposals of a finished analysis; null when not known (never taken as none). */
  proposals: number | null;
}

export function parseRunNoticeRequest(value: unknown): RunNoticeRequest | null {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const id = typeof o['update_id'] === 'string' && /^CU-\d{4}-\d{4}$/.test(o['update_id']) ? o['update_id'] : null;
  const workspace = typeof o['workspace'] === 'string' && o['workspace'].length > 0 && o['workspace'].length <= 1024 ? o['workspace'] : null;
  const started = typeof o['started_at'] === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(o['started_at']) ? o['started_at'] : null;
  return id && workspace && started ? { update_id: id, workspace, started_at: started } : null;
}

/**
 * The notice from the server's `run-notice` answer, which reads the workspace, the run and the update in one request:
 * null unless it confirms that very run ended in that workspace. The words are still written here, from fixed outcomes.
 */
export function noticeFromServer(req: RunNoticeRequest, answer: unknown): RunNotice | null {
  const data = (answer && typeof answer === 'object' ? (answer as { notice?: unknown }).notice : null) as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') return null;
  const outcome = typeof data['outcome'] === 'string' && OUTCOMES.has(data['outcome']) ? data['outcome'] as RunNotice['outcome'] : null;
  if (!outcome) return null;
  const proposals = typeof data['proposals'] === 'number' && Number.isInteger(data['proposals']) && data['proposals'] >= 0 ? data['proposals'] : null;
  return { ...req, outcome, title: cleanTitle(data['title']), proposals };
}

const OUTCOMES = new Set(['review', 'applied', 'analyze-failed', 'apply-failed']);

/**
 * Text from a workspace file, made safe to show in a system notice: no control or direction-changing characters, one
 * line, at most 80 characters.
 */
export function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

/** The words of the notice, fixed here. */
export function runNoticeWords(n: RunNotice): { title: string; body: string } {
  const what = n.title ? `${n.title}: ` : '';
  switch (n.outcome) {
    case 'review': {
      const proposed = n.proposals === null ? 'the analysis finished. Open it to review.'
        : `the analysis proposed ${n.proposals === 0 ? 'no changes' : n.proposals === 1 ? '1 change' : `${n.proposals} changes`}.`;
      return { title: `${n.update_id} is ready for your review`, body: `${what}${proposed}` };
    }
    case 'applied': return { title: `${n.update_id} is applied`, body: `${what}your accepted changes are written.` };
    case 'analyze-failed': return { title: `The analysis of ${n.update_id} did not finish`, body: `${what}open it to see why.` };
    case 'apply-failed': return { title: `The apply of ${n.update_id} did not finish`, body: `${what}open it to see why.` };
  }
}

/**
 * The runs already said, so a run reported twice is said once. A run counts as said only once its notice showed, so
 * a notice the system refused can still be said later.
 */
export function noticeMemory(limit = 200): { said(n: RunNoticeRequest): boolean; remember(n: RunNoticeRequest): void } {
  const keys: string[] = [];
  const key = (n: RunNoticeRequest) => `${n.workspace}\0${n.update_id}\0${n.started_at}`;
  return {
    said: (n) => keys.includes(key(n)),
    remember: (n) => {
      if (keys.includes(key(n))) return;
      keys.push(key(n));
      if (keys.length > limit) keys.shift();
    },
  };
}
