import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Modal from '@/components/common/Modal';
import { Textarea } from '@/components/common/Input';
import { sectionLabelStyle } from '@/components/task-form/styles';
import { useNotify } from '@/hooks/useNotify';
import { errorMessage } from '@/utils/api';
import type { ChangeRequest, Task } from '@/types';

const IN_REVIEW: Task['status'][] = ['in_review', 'review'];

function newRequestId(): string {
  // A fresh id per dialog: sending the same request twice (a double click, a retry) records it once.
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Request changes on a task in review (#79): dated feedback kept in the task, and the task back to rework in one
 * step. No agent is started from here. The feedback reaches the agent through task.md; it marks each one addressed.
 */
export default function ChangeRequests({ task, dirty, onRequested }: { task: Task; dirty: boolean; onRequested: () => void }) {
  const { t } = useLanguage();
  const notify = useNotify();
  const [open, setOpen] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [saving, setSaving] = React.useState(false);
  // The version the user reviewed: taken when the dialog opens, never moved by a refresh while they type.
  const [seen, setSeen] = React.useState<string | null>(null);
  const requests = (Array.isArray(task.change_requests) ? task.change_requests : [])
    .filter((r): r is ChangeRequest => Boolean(r) && typeof r === 'object' && typeof r.feedback === 'string');
  const inReview = IN_REVIEW.includes(task.status);
  if (!inReview && requests.length === 0) return null;

  // A draft kept from a refused attempt stays; a new review gets a new id and the version shown now.
  const start = () => { setRequestId(newRequestId()); setSeen(task.updated_at); setOpen(true); };
  const submit = async () => {
    if (!feedback.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/request-changes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ feedback, seen_updated_at: seen, request_id: requestId }),
      });
      if (!res.ok) {
        const message = errorMessage(await res.json().catch(() => null), t('changeRequests.couldNotSend'));
        throw Object.assign(new Error(message), { status: res.status });
      }
      setOpen(false);
      setFeedback('');
      notify.success(t('changeRequests.sent'));
      onRequested();
    } catch (err) {
      notify.error(err, t('changeRequests.couldNotSend'));
      // The task changed since it was reviewed: close, show the new version, and keep the draft for the next review.
      // Any other failure keeps the dialog and the same request id, so a retry never records it twice.
      if ((err as { status?: number }).status === 409) { setOpen(false); onRequested(); }
    } finally {
      setSaving(false);
    }
  };
  const day = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };

  return (
    <section aria-labelledby={`change-requests-${task.id}`} style={{ marginBottom: 'var(--space-6)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <h3 id={`change-requests-${task.id}`} style={sectionLabelStyle}>{t('changeRequests.title')}</h3>
        <span style={{ flex: 1 }} />
        {inReview && (
          <Button size="sm" variant="secondary" disabled={dirty} onClick={start}>{t('changeRequests.requestChanges')}</Button>
        )}
      </div>
      {inReview && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {dirty ? t('changeRequests.saveFirst') : t('changeRequests.hint')}
        </p>
      )}
      {requests.length > 0 && (
        <ul className="gtd-list" aria-label={t('changeRequests.title')}>
          {[...requests].reverse().map((r) => (
            <li key={r.id} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', paddingLeft: 0, paddingRight: 0, fontSize: 'var(--text-sm)' }}>
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{r.id}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{day(r.requested_at)}</span>
              <Badge size="sm" variant={r.status === 'addressed' ? 'success' : 'warning'}>
                {r.status === 'addressed' ? t('changeRequests.addressed') : t('changeRequests.open')}
              </Badge>
              <span style={{ flexBasis: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.feedback}</span>
            </li>
          ))}
        </ul>
      )}
      <Modal isOpen={open} onClose={() => { if (!saving) setOpen(false); }} title={t('changeRequests.requestChanges')}
        description={t('changeRequests.dialogDescription')} keepWhileTyping
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>{t('cancel')}</Button>
            <Button variant="primary" loading={saving} disabled={!feedback.trim()} onClick={() => void submit()}>{t('changeRequests.send')}</Button>
          </>
        )}>
        <Textarea label={t('changeRequests.feedbackLabel')} value={feedback} onChange={setFeedback} rows={6} />
      </Modal>
    </section>
  );
}
