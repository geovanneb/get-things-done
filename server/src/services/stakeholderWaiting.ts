import { TaskService, isDay } from './taskService';
import { StakeholderService } from './stakeholderService';
import { isOpen } from './taskStatus';

/**
 * What we are waiting on a stakeholder for (#108, first slice): the open tasks whose waiting record (#82) names this
 * stakeholder or group by `ref`. Derived each time from the tasks, never stored. A free-text party is not matched to a
 * person, and a group's page lists only what names the group itself.
 */
export interface WaitingOnItem {
  task_id: string;
  title: string;
  status: string;
  for: string;
  /** The day the waiting started (YYYY-MM-DD). */
  since: string;
  follow_up: string | null;
  /** The follow-up date has come (today or earlier), the same rule as Situation's FOLLOW UP. */
  follow_up_due: boolean;
}

const REF = /^(STK|GRP)-\d{4}$/;

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export async function waitingOn(ref: string): Promise<WaitingOnItem[]> {
  if (!REF.test(ref)) throw Object.assign(new Error('Invalid stakeholder id'), { statusCode: 400 });
  await new StakeholderService().getStakeholder(ref).catch(() => { throw Object.assign(new Error(`Stakeholder not found: ${ref}`), { statusCode: 404 }); });
  const now = today();
  const items: WaitingOnItem[] = [];
  for (const task of await new TaskService().listTasks()) {
    if (!isOpen(task.status)) continue;
    // Read defensively: an agent or a hand edit may have written the record in another shape.
    const w = (task as unknown as { waiting?: { for?: unknown; party?: unknown; since?: unknown; follow_up?: unknown } | null }).waiting;
    if (!w || typeof w.for !== 'string' || !w.for.trim()) continue;
    const party = w.party as { ref?: unknown } | null | undefined;
    if (!party || typeof party !== 'object' || party.ref !== ref) continue;
    // A real calendar day, checked as when the record is set: a hand-written 2026-13-01 counts as not given.
    const followUp = isDay(w.follow_up) ? w.follow_up : null;
    items.push({
      task_id: task.id,
      title: task.title,
      status: task.status,
      for: w.for,
      since: isDay(w.since) ? w.since : '',
      follow_up: followUp,
      follow_up_due: followUp !== null && followUp <= now,
    });
  }
  // Due follow-ups first (the oldest first), then the rest by how long we have waited.
  return items.sort((a, b) => Number(b.follow_up_due) - Number(a.follow_up_due)
    || (a.follow_up_due ? (a.follow_up ?? '').localeCompare(b.follow_up ?? '') : 0)
    || (a.since || '9999').localeCompare(b.since || '9999')
    || a.task_id.localeCompare(b.task_id));
}
