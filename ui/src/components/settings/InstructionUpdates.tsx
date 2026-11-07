import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Card from '@/components/common/Card';
import Notice from '@/components/common/Notice';
import { useConfirm } from '@/components/common/ConfirmDialog';
import DiffView from '@/components/context-updates/DiffView';
import { useNotify } from '@/hooks/useNotify';
import { apiGet, apiPost } from '@/utils/api';

interface InstructionUpdate { path: string; state: 'ready' | 'edited' | 'no_copy'; mine_sha256: string; app_sha256: string }
interface Comparison extends InstructionUpdate { mine: string; app: string }

/**
 * App files you changed while the app ships a newer version of them. Compare yours with the app's, merge what you want
 * in your own file (outside the app), then say "I merged it": the app stops writing a .new for that version. Your file
 * is never changed here. Shown only when there is something to look at.
 */
export default function InstructionUpdates() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const notify = useNotify();
  const [updates, setUpdates] = React.useState<InstructionUpdate[] | null>(null);
  const [error, setError] = React.useState(false);
  const [open, setOpen] = React.useState<Comparison | null>(null);
  const [comparing, setComparing] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);

  const latest = React.useRef(0);
  const load = React.useCallback(() => {
    const request = ++latest.current;
    setError(false);
    setOpen(null);
    setComparing(null);
    apiGet<InstructionUpdate[]>('/api/app/instruction-updates').then(
      rows => { if (request === latest.current) setUpdates(rows); },
      () => { if (request === latest.current) setError(true); },
    );
  }, []);
  React.useEffect(() => {
    const requests = latest;
    load();
    return () => { requests.current++; };
  }, [load]);

  const compare = async (u: InstructionUpdate) => {
    const request = ++latest.current;
    if (open?.path === u.path) { setOpen(null); setComparing(null); return; }
    setComparing(u.path);
    try {
      const comparison = await apiGet<Comparison>(`/api/app/instruction-updates/compare?path=${encodeURIComponent(u.path)}`);
      if (request !== latest.current) return;
      setOpen(comparison);
      // What is compared is how the file stands now: the row follows (a .new deleted since, an edit since).
      setUpdates((rows) => rows?.map((r) => (r.path === comparison.path ? { path: r.path, state: comparison.state, mine_sha256: comparison.mine_sha256, app_sha256: comparison.app_sha256 } : r)) ?? rows);
    } catch (err) {
      if (request !== latest.current) return;
      notify.error(err, t('instructionUpdates.couldNotCompare'));
      load();
    } finally {
      if (request === latest.current) setComparing(null);
    }
  };

  const merged = async (u: InstructionUpdate) => {
    const request = ++latest.current;
    setComparing(null);
    if (!(await confirm({ title: t('instructionUpdates.confirmTitle', { path: u.path }), message: t('instructionUpdates.confirmMessage'), confirmLabel: t('instructionUpdates.iMergedIt') }))) return;
    if (request !== latest.current) return;
    setSaving(u.path);
    try {
      // The versions compared, so a file changed since is refused rather than acknowledged unseen.
      const shown = open?.path === u.path ? open : u;
      const rows = await apiPost<InstructionUpdate[]>('/api/app/instruction-updates/merged', { path: u.path, mine_sha256: shown.mine_sha256, app_sha256: shown.app_sha256 });
      if (request !== latest.current) return;
      setUpdates(rows);
      setOpen(null);
    } catch (err) {
      if (request !== latest.current) return;
      notify.error(err, t('instructionUpdates.couldNotSave'));
      // The comparison is stale now: it is closed, and the list is read again, so a retry uses what is there.
      setOpen(null);
      setSaving(null);
      load();
    } finally {
      if (request === latest.current) setSaving(null);
    }
  };

  if (!error && (!updates || updates.length === 0)) return null;

  return (
    <div id="instruction-updates">
      <Card title={t('instructionUpdates.title')}>
        {error ? (
          <Notice tone="critical" title={t('instructionUpdates.couldNotLoad')} action={<Button size="sm" variant="secondary" onClick={load}>{t('retry')}</Button>}>
            {t('checkConnectionRetry')}
          </Notice>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
              <p style={{ margin: 0, flex: '1 1 260px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{t('instructionUpdates.intro')}</p>
              <Button size="sm" variant="ghost" disabled={saving !== null} onClick={load}>{t('instructionUpdates.checkAgain')}</Button>
            </div>
            <ul className="gtd-list" aria-label={t('instructionUpdates.title')} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
              {updates!.map((u) => (
                <li key={u.path} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                  <span className="mono truncate" style={{ flex: '1 1 200px', minWidth: 0 }}>{u.path}</span>
                  {u.state === 'edited' && <Badge size="sm" variant="warning">{t('instructionUpdates.editedBadge')}</Badge>}
                  <Button size="sm" variant="ghost" disabled={saving !== null} loading={comparing === u.path} aria-expanded={open?.path === u.path} onClick={() => void compare(u)}>
                    {open?.path === u.path ? t('instructionUpdates.hide') : t('instructionUpdates.compare')}
                  </Button>
                  {u.state !== 'edited' && (
                    <Button size="sm" variant="secondary" disabled={saving !== null} loading={saving === u.path} onClick={() => void merged(u)}>{t('instructionUpdates.iMergedIt')}</Button>
                  )}
                  {u.state === 'edited' && (
                    <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('instructionUpdates.editedHint', { path: u.path })}</span>
                  )}
                  {open?.path === u.path && (
                    <div style={{ flexBasis: '100%' }}>
                      <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('instructionUpdates.diffLegend')}</p>
                      <DiffView before={open.mine} after={open.app} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
