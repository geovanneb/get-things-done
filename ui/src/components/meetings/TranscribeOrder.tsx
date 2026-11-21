import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Button from '@/components/common/Button';
import IconButton from '@/components/common/IconButton';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useNotify } from '@/hooks/useNotify';
import { apiPut } from '@/utils/api';
import { transcribeChoices } from '@/utils/meetingHistory';
import type { MeetingDigest, QueuedMeeting } from '@/types';

const more = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
    <circle cx="3" cy="7" r="1.2" /><circle cx="7" cy="7" r="1.2" /><circle cx="11" cy="7" r="1.2" />
  </svg>
);

/**
 * A meeting's place in line for transcription, as a small menu: Transcribe next, Transcribe now (it asks first, saying
 * how far the running job got: that one starts again from the beginning after this meeting) and Move back. Nothing
 * shows when the meeting has no recording waiting.
 */
export function TranscribeOrderMenu({ meeting: m, job, onChanged }: { meeting: QueuedMeeting; job: MeetingDigest; onChanged: () => void }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const notify = useNotify();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const wrap = React.useRef<HTMLSpanElement>(null);
  const choices = transcribeChoices(m, job.queue, job.transcription ?? null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  if (!choices.next && !choices.now && !choices.moveBack) return null;

  const send = async (body: Record<string, unknown>, done: string) => {
    setOpen(false);
    setBusy(true);
    try {
      await apiPut(`/api/meeting-queue/${m.id}/priority`, body);
      notify.success(done);
    } catch (err) {
      notify.error(err, t('transcribeOrder.couldNotChange'));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const now = async () => {
    const r = choices.now!;
    const message = r.title
      ? r.percent !== null ? t('transcribeOrder.stopsPercent', { title: r.title, p: r.percent }) : t('transcribeOrder.stops', { title: r.title })
      : r.percent !== null ? t('transcribeOrder.stopsOtherPercent', { p: r.percent }) : t('transcribeOrder.stopsOther');
    setOpen(false);
    if (!(await confirm({ title: t('transcribeOrder.confirmTitle', { title: m.title }), message, confirmLabel: t('transcribeOrder.now') }))) return;
    // The job the page showed: if another one runs by now, the server refuses rather than stop it unseen.
    void send({ first: true, now: true, generation: r.generation }, t('transcribeOrder.startsNow', { title: m.title }));
  };
  const item = (label: string, onClick: () => void) => (
    <Button role="menuitem" size="sm" variant="ghost" block onClick={onClick} style={{ justifyContent: 'flex-start' }}>{label}</Button>
  );

  return (
    <span ref={wrap} style={{ position: 'relative', display: 'inline-flex' }}>
      <IconButton label={t('transcribeOrder.menu', { title: m.title })} icon={more} disabled={busy} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} />
      {open && (
        <div role="menu" aria-label={t('transcribeOrder.menu', { title: m.title })}
          style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 'var(--z-dropdown)', minWidth: 180, display: 'flex', flexDirection: 'column', padding: 4, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)' }}>
          {choices.next && item(t('transcribeOrder.next'), () => void send({ first: true }, t('transcribeOrder.isNext', { title: m.title })))}
          {choices.now && item(t('transcribeOrder.now'), () => void now())}
          {choices.moveBack && item(t('transcribeOrder.moveBack'), () => void send({ first: false }, t('transcribeOrder.movedBack', { title: m.title })))}
        </div>
      )}
    </span>
  );
}
