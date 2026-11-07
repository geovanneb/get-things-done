import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Page, { PageHeader, Section } from '@/components/common/Page';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import IconButton, { icons } from '@/components/common/IconButton';
import Notice from '@/components/common/Notice';
import { Select, Textarea } from '@/components/common/Input';
import { useApi } from '@/hooks/useApi';
import { useNotify } from '@/hooks/useNotify';
import { apiPost, errorMessage } from '@/utils/api';
import type { Task } from '@/types';

interface ShareItem { task: string; kind: 'deliverable' | 'attachment'; ref: string; label: string; taskTitle: string }
interface ShareRow {
  task: string; task_title: string; confidentiality: string | null; kind: string; ref: string; template: string | null;
  source_name: string; zip_name: string; size: number | null; problem: string | null;
}
interface Preview { rows: ShareRow[]; readme: string; total_bytes: number; token: string; ready: boolean }
interface TaskFile { name: string }

const arrow = (d: string) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const UP = arrow('M3 7.5L6 4.5L9 7.5');
const DOWN = arrow('M3 4.5L6 7.5L9 4.5');

const key = (i: { task: string; kind: string; ref: string }) => `${i.task}/${i.kind}/${i.ref}`;
const kb = (n: number | null) => (n === null ? '–' : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * A share pack (#81): chosen deliverables and attached files from several tasks, in reading order, with a README, as
 * one ZIP for a colleague. Only chosen files go in; confidentiality is shown, never treated as permission. The download
 * is the previewed list exactly: anything changed since needs a new preview.
 */
export default function SharePackView() {
  const { t } = useLanguage();
  const notify = useNotify();
  const { data: tasks } = useApi<Task[]>('/api/tasks');
  const [taskId, setTaskId] = React.useState('');
  const [items, setItems] = React.useState<ShareItem[]>([]);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [readme, setReadme] = React.useState('');
  const [readmeEdited, setReadmeEdited] = React.useState(false);
  const [busy, setBusy] = React.useState<'preview' | 'download' | null>(null);

  const task = tasks?.find((x) => x.id === taskId) ?? null;
  const chosen = new Set(items.map(key));
  // Any change to the list makes the preview stale: it must be seen again before a download.
  const change = (next: ShareItem[]) => { setItems(next); setPreview(null); };
  const add = (item: ShareItem) => { if (!chosen.has(key(item))) change([...items, item]); };
  const move = (i: number, by: number) => {
    const next = [...items];
    const [it] = next.splice(i, 1);
    next.splice(i + by, 0, it!);
    change(next);
  };

  const runPreview = async () => {
    setBusy('preview');
    try {
      const p = await apiPost<Preview>('/api/share-pack/preview', { items: items.map(({ task, kind, ref }) => ({ task, kind, ref })) });
      setPreview(p);
      if (!readmeEdited) setReadme(p.readme);
    } catch (err) {
      notify.error(err, t('sharePack.couldNotPreview'));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!preview) return;
    setBusy('download');
    try {
      const res = await fetch('/api/share-pack/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map(({ task, kind, ref }) => ({ task, kind, ref })), readme, token: preview.token }),
      });
      if (!res.ok) {
        const message = errorMessage(await res.json().catch(() => null), t('sharePack.couldNotDownload'));
        if (res.status === 409) setPreview(null);
        throw new Error(message);
      }
      const blob = await res.blob();
      const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'share-pack.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      notify.error(err, t('sharePack.couldNotDownload'));
    } finally {
      setBusy(null);
    }
  };


  return (
    <Page width="wide">
      <PageHeader description={t('sharePack.description')} />
      <Notice tone="info">{t('sharePack.confidentialityNote')}</Notice>

      <Section title={t('sharePack.chooseFiles')}>
        <Select label={t('task')} value={taskId} onChange={setTaskId}
          options={[{ value: '', label: t('sharePack.pickATask') }, ...(tasks ?? []).map((x) => ({ value: x.id, label: `${x.id} · ${x.title}` }))]} />
        {/* Keyed by task: a list loaded for the task before is never shown, or added, as this one's. */}
        {task && <TaskFiles key={task.id} task={task} chosen={chosen} onAdd={add} />}
      </Section>

      <Section title={t('sharePack.pack')} actions={<Button variant="secondary" size="sm" disabled={items.length === 0} loading={busy === 'preview'} onClick={() => void runPreview()}>{t('sharePack.preview')}</Button>}>
        {items.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('sharePack.empty')}</p>
        ) : (
          <ol className="gtd-list" aria-label={t('sharePack.pack')} style={{ paddingLeft: 0 }}>
            {items.map((it, i) => (
              <li key={key(it)} className="gtd-list__row" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                <span className="mono" style={{ color: 'var(--color-text-muted)' }}>{String(i + 1).padStart(2, '0')}</span>
                <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{it.label} <span style={{ color: 'var(--color-text-muted)' }}>· {it.taskTitle}</span></span>
                <IconButton label={t('sharePack.moveUp', { name: it.label })} icon={UP} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton label={t('sharePack.moveDown', { name: it.label })} icon={DOWN} disabled={i === items.length - 1} onClick={() => move(i, 1)} />
                <IconButton label={t('sharePack.remove', { name: it.label })} icon={icons.close} tone="danger" onClick={() => change(items.filter((_, j) => j !== i))} />
              </li>
            ))}
          </ol>
        )}
      </Section>

      {preview && (
        <Section title={t('sharePack.finalList')}>
          <div style={{ overflowX: 'auto' }}>
            <table className="gtd-table" style={{ width: '100%', fontSize: 'var(--text-sm)' }}>
              <thead><tr><th>{t('sharePack.nameInPack')}</th><th>{t('task')}</th><th>{t('sharePack.template')}</th><th>{t('sharePack.confidentiality')}</th><th>{t('sharePack.size')}</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={key(r)}>
                    <td className="mono">{r.zip_name}{r.problem && <div style={{ color: 'var(--color-critical)', fontFamily: 'inherit' }}>{r.problem}</div>}</td>
                    <td>{r.task_title || r.task}</td>
                    <td>{r.template ?? '–'}</td>
                    <td>{r.confidentiality ? <Badge size="sm" variant="warning">{r.confidentiality}</Badge> : '–'}</td>
                    <td>{kb(r.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Textarea label={t('sharePack.readme')} value={readme} onChange={(v) => { setReadme(v); setReadmeEdited(true); }} rows={10} mono />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            <Button variant="primary" disabled={!preview.ready} loading={busy === 'download'} onClick={() => void download()}>{t('sharePack.download')}</Button>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              {preview.ready ? t('sharePack.readyHint', { size: kb(preview.total_bytes) }) : t('sharePack.notReadyHint')}
            </span>
          </div>
        </Section>
      )}
    </Page>
  );
}

/** The files of one task that can go in a pack: its deliverables with a file, and files attached directly to it. */
function TaskFiles({ task, chosen, onAdd }: { task: Task; chosen: Set<string>; onAdd: (item: ShareItem) => void }) {
  const { t } = useLanguage();
  const { data: files, loading, error, refetch } = useApi<TaskFile[]>(`/api/tasks/${encodeURIComponent(task.id)}/files`, [task.id]);
  // Only a deliverable with its own id and a file can be shared: the pack names it by id.
  const deliverables = (task.deliverables ?? []).filter((d): d is typeof d & { id: string; file_path: string } => Boolean(d.file_path && d.id));
  // Only files attached directly to the task: never task.md or anything in a subfolder (logs, backups, notes).
  const attached = (files ?? []).filter((f) => !f.name.includes('/') && !f.name.startsWith('.') && f.name !== 'task.md');
  const row = (item: ShareItem, badge: React.ReactNode, mono: boolean) => (
    <li key={key(item)} className="gtd-list__row" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
      {badge}
      <span className={`truncate${mono ? ' mono' : ''}`} style={{ flex: 1, minWidth: 0 }}>{item.label}</span>
      <Button size="sm" variant="secondary" disabled={chosen.has(key(item))} onClick={() => onAdd(item)}>{chosen.has(key(item)) ? t('sharePack.added') : t('sharePack.add')}</Button>
    </li>
  );
  if (error) return <Notice tone="critical" title={t('attachedFilesLoadError')} action={<Button size="sm" variant="secondary" onClick={refetch}>{t('retry')}</Button>}>{t('checkConnectionRetry')}</Notice>;
  return (
    <ul className="gtd-list" aria-label={t('sharePack.filesOfTask', { id: task.id })} style={{ marginTop: 'var(--space-3)' }}>
      {deliverables.map((d) => row({ task: task.id, kind: 'deliverable', ref: d.id, label: `${d.id} · ${d.file_path.split('/').pop()}`, taskTitle: task.title }, <Badge size="sm" variant="info">{t('sharePack.deliverable')}</Badge>, false))}
      {attached.map((f) => row({ task: task.id, kind: 'attachment', ref: f.name, label: f.name, taskTitle: task.title }, <Badge size="sm">{t('sharePack.attachment')}</Badge>, true))}
      {!loading && deliverables.length === 0 && attached.length === 0 && (
        <li className="gtd-list__row" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('sharePack.nothingToShare')}</li>
      )}
    </ul>
  );
}
