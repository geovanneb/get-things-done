import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Button from '@/components/common/Button';
import Modal from '@/components/common/Modal';
import { useAppDispatch } from '@/store';
import { apiGet } from '@/utils/api';
import { meetingActionDraft } from '@/utils/meetingAction';
import { canTaskFromAction, deliverableDraft, hasConfirmedRecord, recordProblem, withMeetingMention, type RecordProblem } from '@/utils/meetingDeliverable';
import { useNotify } from '@/hooks/useNotify';
import type { MeetingRow } from '@/utils/meetingHistory';
import type { MeetingDetail, NewTaskDraft, OutputTemplate, Stakeholder } from '@/types';

interface Loaded { row: MeetingRow; detail: MeetingDetail; stakeholders: Stakeholder[]; templates: OutputTemplate[] }

/**
 * "Create deliverable" for the meetings picked in the list. Several meetings, or one without a confirmed record, open
 * the New task form with the plain draft at once. One meeting with a confirmed record is read first, so the draft
 * holds its decisions, its people as stakeholders to tick, and a template its action item asks for. When the record
 * has action items, the user first says which one (or the meeting as a whole); one action item can instead become a
 * task of its own through the same shortcut as on the meeting's Tasks tab, with the meeting mentioned so its sources
 * are pinned. The record is read again when the choice is accepted: if it is no longer confirmed, changed, or its
 * versions do not agree, nothing from it is copied and the plain draft opens, with a notice saying why.
 */
export function CreateDeliverableButton({ rows, onDone }: { rows: MeetingRow[]; onDone: () => void }) {
  const { t } = useLanguage();
  const dispatch = useAppDispatch();
  const [busy, setBusy] = React.useState(false);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [item, setItem] = React.useState<number | null>(null);
  const notify = useNotify();
  const why: Record<RecordProblem, string> = {
    versions: t('meetingDeliverable.versionsDisagree'),
    not_confirmed: t('meetingDeliverable.recordNotConfirmed'),
    changed: t('meetingDeliverable.recordChanged'),
  };
  const plain = (problem: RecordProblem | 'unread') => {
    notify.warning(problem === 'unread' ? t('meetingDeliverable.couldNotReadAgain') : why[problem]);
    open(deliverableDraft(rows));
  };

  const open = (draft: NewTaskDraft) => {
    dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: draft });
    setLoaded(null);
    onDone();
  };

  const start = async () => {
    const row = rows.length === 1 ? rows[0]! : null;
    if (!row || !hasConfirmedRecord(row)) { open(deliverableDraft(rows)); return; }
    setBusy(true);
    try {
      const [detail, stakeholders, templates] = await Promise.all([
        apiGet<MeetingDetail>(`/api/meetings/${encodeURIComponent(row.id)}`),
        // Without them the draft only suggests less; it still opens.
        apiGet<Stakeholder[]>('/api/stakeholders').catch(() => [] as Stakeholder[]),
        apiGet<OutputTemplate[]>('/api/outputs/templates').catch(() => [] as OutputTemplate[]),
      ]);
      const record = detail.record;
      const problem = recordProblem(detail);
      if (problem || !record) plain(problem ?? 'not_confirmed');
      else if (!record.action_items.length) open(deliverableDraft(rows, { record, item: null, stakeholders, templates }));
      else { setItem(null); setLoaded({ row, detail, stakeholders, templates }); }
    } catch {
      // The meeting could not be read: the plain draft, as before.
      open(deliverableDraft(rows));
    } finally {
      setBusy(false);
    }
  };

  const record = loaded?.detail.record ?? null;
  const action = record && item !== null ? record.action_items[item] : undefined;
  const asTask = Boolean(loaded && record && action && canTaskFromAction(loaded.detail.meeting, record));

  /** The meeting read again when the choice is accepted: its record as it is now, or null after a notice and the plain draft. */
  const fresh = async (): Promise<MeetingDetail | null> => {
    if (!loaded || !record) return null;
    setBusy(true);
    try {
      const now = await apiGet<MeetingDetail>(`/api/meetings/${encodeURIComponent(loaded.row.id)}`);
      const problem = recordProblem(now, record.revision);
      if (problem) { plain(problem); return null; }
      return now;
    } catch {
      plain('unread');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const deliverable = async () => {
    const now = await fresh();
    if (!loaded || !now?.record) return;
    open(deliverableDraft([loaded.row], { record: now.record, item, stakeholders: loaded.stakeholders, templates: loaded.templates }));
  };

  const task = async () => {
    if (item === null) return;
    const now = await fresh();
    const a = now?.record?.action_items[item];
    if (!loaded || !now?.record || !a) return;
    const h = now.meeting;
    // The owner is filled in the same way as on the meeting's Tasks tab: only a linked stakeholder that exists.
    const ref = a.owner?.ref;
    const owner = ref && ref !== 'me' ? loaded.stakeholders.find((s) => s.id === ref) : undefined;
    open(withMeetingMention(meetingActionDraft({ id: h.record_owner?.update_id ?? h.update_id }, now.record, item, owner), loaded.row));
  };

  return (
    <>
      <Button size="sm" variant="primary" loading={busy} onClick={() => void start()}>{t('meetingsList.createDeliverable')}</Button>
      {loaded && record && (
        <Modal isOpen onClose={() => setLoaded(null)} size="md" title={t('meetingDeliverable.whatIsItFor', { title: loaded.row.title })}
          description={t('meetingDeliverable.pickAnActionItem')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setLoaded(null)}>{t('cancel')}</Button>
              {asTask && <Button variant="secondary" disabled={busy} onClick={() => void task()}>{t('meetingDeliverable.createATaskInstead')}</Button>}
              <Button variant="primary" loading={busy} onClick={() => void deliverable()}>{t('meetingsList.createDeliverable')}</Button>
            </>
          )}>
          <div role="radiogroup" aria-label={t('meetingDeliverable.whatTheDeliverableIsFor')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {[null, ...record.action_items.map((_, i) => i)].map((i) => {
              const a = i === null ? null : record.action_items[i]!;
              const chosen = item === i;
              const owner = a?.owner ? (a.owner.ref === 'me' ? t('meetingDeliverable.you') : a.owner.name || a.owner.ref || '') : '';
              const facts = a ? [owner, a.due_date, a.task_ref ? t('meetingDeliverable.hasTask', { task: a.task_ref }) : ''].filter(Boolean).join(' · ') : t('meetingDeliverable.decisionsAndPeople');
              return (
                <label key={i ?? 'all'} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', cursor: 'pointer',
                  border: `1px solid ${chosen ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)',
                  background: chosen ? 'var(--color-accent-subtle)' : 'transparent' }}>
                  <input type="radio" name="deliverable-action" checked={chosen} onChange={() => setItem(i)} style={{ marginTop: 3 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600, overflowWrap: 'anywhere' }}>{a ? a.description : t('meetingDeliverable.theWholeMeeting')}</span>
                    {facts && <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.4 }}>{facts}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          {action && (
            <p style={{ margin: 'var(--space-3) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              {asTask ? t('meetingDeliverable.oneActionOneTask') : t('meetingDeliverable.noTaskYet')}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
