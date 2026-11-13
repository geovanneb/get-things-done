import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Button from '@/components/common/Button';
import Input, { Select, Textarea } from '@/components/common/Input';
import Modal from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { sectionLabelStyle } from '@/components/task-form/styles';
import { useApi } from '@/hooks/useApi';
import { useNotify } from '@/hooks/useNotify';
import { errorMessage } from '@/utils/api';
import type { Stakeholder, Task, TaskWaiting as Waiting } from '@/types';

const OTHER = '__other__';

export function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/** Whole days from one calendar day to another, in local time. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86_400_000);
}

/**
 * What the task waits for (#82): one record, with whom and since when, and a follow-up date. Independent of the
 * status; resolving clears it and leaves the task as it is. Set and resolved here only, never by a task save.
 */
export default function TaskWaiting({ task, dirty, onChanged, readOnly = false }: { task: Task; dirty: boolean; onChanged: () => void; readOnly?: boolean }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const notify = useNotify();
  const { data: people } = useApi<Stakeholder[]>('/api/stakeholders');
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [what, setWhat] = React.useState('');
  const [party, setParty] = React.useState('');
  const [otherName, setOtherName] = React.useState('');
  const [since, setSince] = React.useState('');
  const [followUp, setFollowUp] = React.useState('');
  // The version the user looked at, taken when the dialog opens: a refresh while typing never moves it.
  const [seen, setSeen] = React.useState<string | null>(null);
  const waiting = task.waiting ?? null;

  const name = (w: Waiting) => {
    if (!w.party) return '';
    if ('name' in w.party) return w.party.name;
    const ref = w.party.ref;
    return people?.find((p) => p.id === ref)?.name ?? ref;
  };

  const start = () => {
    setWhat(waiting?.for ?? '');
    setParty(waiting?.party ? ('ref' in waiting.party ? waiting.party.ref : OTHER) : '');
    setOtherName(waiting?.party && 'name' in waiting.party ? waiting.party.name : '');
    setSince(waiting?.since ?? today());
    setFollowUp(waiting?.follow_up ?? '');
    setSeen(task.updated_at);
    setOpen(true);
  };

  const send = async (url: string, method: string, body: unknown) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw Object.assign(new Error(errorMessage(await res.json().catch(() => null), t('taskWaiting.couldNotSave'))), { status: res.status });
  };

  const save = async () => {
    if (!what.trim() || saving) return;
    setSaving(true);
    try {
      const chosen = party === OTHER ? (otherName.trim() ? { name: otherName.trim() } : null) : party ? { ref: party } : null;
      await send(`/api/tasks/${encodeURIComponent(task.id)}/waiting`, 'PUT', { waiting: { for: what, party: chosen, since, follow_up: followUp || null }, seen_updated_at: seen });
      setOpen(false);
      onChanged();
    } catch (err) {
      notify.error(err, t('taskWaiting.couldNotSave'));
      // The task changed since: close and show it as it is now; the user opens the dialog again on the new version.
      if ((err as { status?: number }).status === 409) { setOpen(false); onChanged(); }
    } finally {
      setSaving(false);
    }
  };

  const resolve = async () => {
    if (!(await confirm({ title: t('taskWaiting.resolveTitle'), message: t('taskWaiting.resolveMessage'), confirmLabel: t('taskWaiting.resolve') }))) return;
    try {
      await send(`/api/tasks/${encodeURIComponent(task.id)}/waiting/resolve`, 'POST', { seen_updated_at: task.updated_at });
      onChanged();
    } catch (err) {
      notify.error(err, t('taskWaiting.couldNotSave'));
      onChanged();
    }
  };

  const options = [
    { value: '', label: t('taskWaiting.nobodyInParticular') },
    ...(people ?? []).map((p) => ({ value: p.id, label: p.name })),
    { value: OTHER, label: t('taskWaiting.someoneElse') },
  ];
  const waited = waiting ? Math.max(0, daysBetween(waiting.since, today())) : 0;
  const followDue = waiting?.follow_up ? waiting.follow_up <= today() : false;

  // Read-only (an archived task): nothing to show when it waited for nothing.
  if (readOnly && !waiting) return null;

  return (
    <section aria-labelledby={`waiting-${task.id}`} style={{ marginBottom: 'var(--space-6)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <h3 id={`waiting-${task.id}`} style={sectionLabelStyle}>{t('taskWaiting.title')}</h3>
        <span style={{ flex: 1 }} />
        {waiting && !readOnly && <Button size="sm" variant="ghost" disabled={dirty} onClick={() => void resolve()}>{t('taskWaiting.resolve')}</Button>}
        {!readOnly && <Button size="sm" variant={waiting ? 'ghost' : 'secondary'} disabled={dirty} onClick={start}>{waiting ? t('taskWaiting.edit') : t('taskWaiting.set')}</Button>}
      </div>
      {dirty && <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('taskWaiting.saveFirst')}</p>}
      {waiting ? (
        <div style={{ fontSize: 'var(--text-sm)' }}>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{waiting.for}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: followDue ? 'var(--color-warning)' : 'var(--color-text-muted)', marginTop: 'var(--space-1)' }}>
            {[name(waiting) && t('taskWaiting.from', { name: name(waiting) }),
              t('taskWaiting.since', { since: waiting.since, count: waited }),
              waiting.follow_up && (followDue ? t('taskWaiting.followUpDue', { date: waiting.follow_up }) : t('taskWaiting.followUp', { date: waiting.follow_up }))]
              .filter(Boolean).join(' · ')}
          </div>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('taskWaiting.none')}</p>
      )}
      <Modal isOpen={open} onClose={() => { if (!saving) setOpen(false); }} title={waiting ? t('taskWaiting.edit') : t('taskWaiting.set')}
        description={t('taskWaiting.dialogDescription')} keepWhileTyping
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>{t('cancel')}</Button>
            <Button variant="primary" loading={saving} disabled={!what.trim()} onClick={() => void save()}>{t('taskWaiting.save')}</Button>
          </>
        )}>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <Textarea label={t('taskWaiting.whatLabel')} value={what} onChange={setWhat} rows={3} />
          <Select label={t('taskWaiting.fromLabel')} value={party} onChange={setParty} options={options} />
          {party === OTHER && <Input label={t('taskWaiting.otherLabel')} value={otherName} onChange={setOtherName} />}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
            <div style={{ flex: '1 1 160px' }}><Input label={t('taskWaiting.sinceLabel')} type="date" value={since} onChange={setSince} /></div>
            <div style={{ flex: '1 1 160px' }}><Input label={t('taskWaiting.followUpLabel')} type="date" value={followUp} onChange={setFollowUp} /></div>
          </div>
        </div>
      </Modal>
    </section>
  );
}
