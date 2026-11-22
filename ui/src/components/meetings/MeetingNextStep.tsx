import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import { Link } from 'react-router-dom';
import Button from '@/components/common/Button';
import { CreateDeliverableButton } from '@/components/meetings/CreateDeliverableButton';
import { TranscriptionBar } from '@/components/meetings/TranscriptionBar';
import { useNotify } from '@/hooks/useNotify';
import { apiPost } from '@/utils/api';
import type { MeetingRow } from '@/utils/meetingHistory';
import type { MeetingTask, NextStep, NextStepAction } from '@/utils/meetingNextStep';

const TONE: Record<NextStep['tone'], string> = {
  info: 'var(--color-info)', warning: 'var(--color-warning)', success: 'var(--color-success)', muted: 'var(--color-border)',
};

/**
 * The Next step line at the top of a meeting (#483): one action for where it stands now, worked out by meetingNextStep.
 * Nothing runs until the user clicks; opening the meeting only reads. Create deliverable is offered next to it whenever
 * the list would let the meeting be picked. Under it: the tasks made from its action items, and the active tasks that
 * mention it (a mention is not proof a task was made from the meeting, so they are listed apart).
 */
export function MeetingNextStep({ step, row, meetingId, tasks, onFiles, onChanged }: {
  step: NextStep; row: MeetingRow; meetingId: string; tasks: MeetingTask[]; onFiles: () => void; onChanged: () => void;
}) {
  const { t } = useLanguage();
  const notify = useNotify();
  const [busy, setBusy] = React.useState(false);

  const post = async (url: string, digest = false) => {
    setBusy(true);
    try {
      const result = await apiPost<unknown>(url);
      // Make digest now answers 201 even when it could not make one, with what happened.
      const run = digest ? result as { status: 'ok' | 'error'; message: string } : null;
      if (run?.status === 'error') notify.error(null, run.message || t('meetingNextStep.failed'));
      else notify.success(run?.message || t('meetingNextStep.done'));
    } catch (err) {
      notify.error(err, t('meetingNextStep.failed'));
    } finally {
      setBusy(false);
      // Refused or not, show the meeting as it is now.
      onChanged();
    }
  };
  const recording = (file: string, action: string) => `/api/meeting-queue/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(file)}/${action}`;

  const button = (a: NextStepAction, primary: boolean) => {
    const variant = primary ? 'primary' : 'secondary';
    switch (a.kind) {
      case 'link': return <Link key={a.label} to={a.to} className={`gtd-btn gtd-btn--${variant} gtd-btn--sm`}>{a.label}</Link>;
      case 'files': return <Button key={a.label} size="sm" variant={variant} onClick={onFiles}>{a.label}</Button>;
      case 'retry': return <Button key={a.label} size="sm" variant={variant} disabled={busy} onClick={() => void post(recording(a.file, 'retry'))}>{a.label}</Button>;
      case 'accept': return <Button key={a.label} size="sm" variant={variant} disabled={busy} onClick={() => void post(recording(a.file, 'accept'))}>{a.label}</Button>;
      case 'queue_again': return <Button key={a.label} size="sm" variant={variant} disabled={busy} onClick={() => void post(`/api/meeting-queue/${encodeURIComponent(meetingId)}/queue`)}>{a.label}</Button>;
      case 'make_digest': return <Button key={a.label} size="sm" variant={variant} loading={busy} onClick={() => void post('/api/routines/meeting-digest/run', true)}>{a.label}</Button>;
      case 'deliverable': return <CreateDeliverableButton key={a.label} rows={[row]} onDone={() => undefined} variant={variant} />;
      default: return null;
    }
  };

  return (
    <section aria-label={t('meetingNextStep.title')} data-next-step={step.code}
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2) var(--space-3)', padding: 'var(--space-2) var(--space-3)',
        borderLeft: `3px solid ${TONE[step.tone]}`, background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)' }}>
      <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('meetingNextStep.title')}</span>
        <span role="status" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)' }}>{step.text}</span>
        {step.detail && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>{step.detail}</span>}
        {step.progress && <TranscriptionBar percent={step.progress.percent} spoken={step.progress.spoken} width={200} />}
      </div>
      {(step.actions.length > 0 || step.deliverable) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          {step.actions.map((a, i) => button(a, i === 0))}
          {step.deliverable && <CreateDeliverableButton rows={[row]} onDone={() => undefined} variant={step.actions.length ? 'secondary' : 'primary'} />}
        </div>
      )}
      {(['action', 'mention'] as const).map((via) => {
        const group = tasks.filter((task) => task.via === via);
        if (!group.length) return null;
        return (
          <div key={via} style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1) var(--space-2)' }}>
            <span>{via === 'action' ? t('meetingNextStep.madeTasks') : t('meetingNextStep.mentionTasks')}</span>
            {group.map((task) => task.gone
              ? <span key={task.id} className="mono" style={{ color: 'var(--color-text-muted)' }}>{t('meetingNextStep.taskGone', { id: task.id })}</span>
              : <Link key={task.id} to={`/board/task/${task.id}`} className="gtd-link">{task.title ? `${task.title} (${task.id})` : task.id}</Link>)}
          </div>
        );
      })}
    </section>
  );
}
