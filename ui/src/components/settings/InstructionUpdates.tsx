import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Card from '@/components/common/Card';
import Notice from '@/components/common/Notice';
import { SegmentedControl } from '@/components/common/Tabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import DiffView from '@/components/context-updates/DiffView';
import { useNotify } from '@/hooks/useNotify';
import { apiGet, apiPost } from '@/utils/api';

interface InstructionUpdate { path: string; state: 'ready' | 'edited' | 'no_copy'; mine_sha256: string; app_sha256: string; permission_file: boolean; installed: boolean;
  /** The workspace the row was read from: every resolution is sent for it, and refused when another one is open. */
  workspace: string }
interface Comparison extends InstructionUpdate {
  mine: string;
  app: string;
  /** `changed`: `base` is the app version the file was based on; `unchanged`: the app did not change it; `unknown`: no base. */
  release: 'changed' | 'unchanged' | 'unknown';
  base: string | null;
}
type View = 'release' | 'yours';

/**
 * App files you changed while the app ships a newer version of them. Compare shows what the app itself changed (from
 * the app version your file was based on, when known) and your file against the app version. Keep my version settles
 * this release with your file as it is; Use the app's version replaces your file after a preview of what it loses,
 * with a copy in the trash. Permission files are compared and kept only. Shown only when there is something to look at.
 */
export default function InstructionUpdates() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const notify = useNotify();
  const [updates, setUpdates] = React.useState<InstructionUpdate[] | null>(null);
  const [error, setError] = React.useState(false);
  const [open, setOpen] = React.useState<Comparison | null>(null);
  const [view, setView] = React.useState<View>('release');
  /** The file whose replacement is being previewed: the comparison of yours and the app's, with the confirm buttons. */
  const [preview, setPreview] = React.useState<string | null>(null);
  const [comparing, setComparing] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);
  const previewHeading = React.useRef<HTMLHeadingElement>(null);

  const latest = React.useRef(0);
  const load = React.useCallback(() => {
    const request = ++latest.current;
    setError(false);
    setOpen(null);
    setPreview(null);
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
  // Keyboard and screen reader users land on the preview's question, right above its buttons.
  React.useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);

  /** Reads the comparison of `u` and opens it; null when it could not be read (the list is read again). */
  const fetchComparison = async (u: InstructionUpdate, request: number): Promise<Comparison | null> => {
    setComparing(u.path);
    try {
      // Read for the row's workspace: when another one was opened meanwhile (another tab), the server refuses it.
      const comparison = await apiGet<Comparison>(`/api/app/instruction-updates/compare?path=${encodeURIComponent(u.path)}`, u.workspace);
      if (request !== latest.current) return null;
      // And never adopted from any other workspace, whatever answered: the list is read again instead.
      if (comparison.workspace !== u.workspace || comparison.path !== u.path) throw new Error(t('instructionUpdates.otherWorkspace'));
      setOpen(comparison);
      // What is compared is how the file stands now: the row follows (a .new deleted since, an edit since).
      setUpdates((rows) => rows?.map((r) => (r.path === comparison.path ? { path: r.path, state: comparison.state, mine_sha256: comparison.mine_sha256, app_sha256: comparison.app_sha256, permission_file: comparison.permission_file, installed: comparison.installed, workspace: comparison.workspace } : r)) ?? rows);
      return comparison;
    } catch (err) {
      if (request !== latest.current) return null;
      notify.error(err, t('instructionUpdates.couldNotCompare'));
      load();
      return null;
    } finally {
      if (request === latest.current) setComparing(null);
    }
  };

  const compare = async (u: InstructionUpdate) => {
    const request = ++latest.current;
    setPreview(null);
    if (open?.path === u.path) { setOpen(null); setComparing(null); return; }
    const comparison = await fetchComparison(u, request);
    if (comparison) setView(comparison.release === 'changed' ? 'release' : 'yours');
  };

  const keep = async (u: InstructionUpdate) => {
    const request = ++latest.current;
    setComparing(null);
    setPreview(null);
    if (!(await confirm({ title: t('instructionUpdates.confirmTitle', { path: u.path }), message: t('instructionUpdates.confirmMessage'), confirmLabel: t('instructionUpdates.keepMine') }))) return;
    if (request !== latest.current) return;
    setSaving(u.path);
    try {
      // The versions compared, so a file changed since is refused rather than settled unseen.
      const shown = open?.path === u.path ? open : u;
      const rows = await apiPost<InstructionUpdate[]>('/api/app/instruction-updates/merged', {
        path: u.path, mine_sha256: shown.mine_sha256, app_sha256: shown.app_sha256, workspace: shown.workspace,
      }, shown.workspace);
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

  /** Opens the preview: always read again, so what is confirmed is exactly what is shown. */
  const startUseApp = async (u: InstructionUpdate) => {
    const request = ++latest.current;
    setPreview(null);
    const comparison = await fetchComparison(u, request);
    if (!comparison || comparison.permission_file || !comparison.installed || comparison.state === 'edited') return;
    setView('yours');
    setPreview(u.path);
  };

  const replace = async (shown: Comparison) => {
    const request = ++latest.current;
    setSaving(shown.path);
    try {
      const result = await apiPost<{ updates: InstructionUpdate[]; backup: string }>('/api/app/instruction-updates/use-app', {
        path: shown.path, mine_sha256: shown.mine_sha256, app_sha256: shown.app_sha256, state: shown.state, workspace: shown.workspace,
      }, shown.workspace);
      if (request !== latest.current) return;
      setUpdates(result.updates);
      setOpen(null);
      setPreview(null);
      notify.success(t('instructionUpdates.replaced', { path: shown.path, backup: result.backup }));
    } catch (err) {
      if (request !== latest.current) return;
      notify.error(err, t('instructionUpdates.couldNotReplace'));
      setSaving(null);
      load();
    } finally {
      if (request === latest.current) setSaving(null);
    }
  };

  if (!error && (!updates || updates.length === 0)) return null;

  const hint = { margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' } as const;

  const comparisonOf = (c: Comparison) => {
    const showRelease = view === 'release' && c.release === 'changed' && c.base !== null;
    const previewing = preview === c.path;
    const headingId = `instruction-preview-${c.path.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    return (
      <div style={{ flexBasis: '100%' }}>
        {previewing ? (
          <div role="region" aria-labelledby={headingId} style={{ marginBottom: 'var(--space-2)' }}>
            <h4 id={headingId} ref={previewHeading} tabIndex={-1} style={{ margin: '0 0 var(--space-1)', fontSize: 'var(--text-sm)' }}>
              {t('instructionUpdates.previewTitle', { path: c.path })}
            </h4>
            <p style={hint}>{t('instructionUpdates.previewMessage')}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
              <Button size="sm" variant="danger" loading={saving === c.path} disabled={saving !== null} onClick={() => void replace(c)}>{t('instructionUpdates.replace')}</Button>
              <Button size="sm" variant="ghost" disabled={saving !== null} onClick={() => setPreview(null)}>{t('cancel')}</Button>
            </div>
          </div>
        ) : c.release === 'changed' ? (
          <SegmentedControl<View>
            label={t('instructionUpdates.views')}
            value={view}
            onChange={setView}
            options={[{ value: 'release', label: t('instructionUpdates.viewRelease') }, { value: 'yours', label: t('instructionUpdates.viewYours') }]}
            style={{ marginBottom: 'var(--space-2)' }}
          />
        ) : (
          <p style={hint}>{c.release === 'unchanged' ? t('instructionUpdates.releaseUnchanged') : t('instructionUpdates.releaseUnknown')}</p>
        )}
        <p style={hint}>{showRelease ? t('instructionUpdates.releaseLegend') : t('instructionUpdates.diffLegend')}</p>
        {showRelease ? <DiffView before={c.base} after={c.app} /> : <DiffView before={c.mine} after={c.app} />}
      </div>
    );
  };

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
                  {u.state !== 'edited' && u.installed && (
                    <Button size="sm" variant="secondary" disabled={saving !== null} loading={saving === u.path && preview === null} onClick={() => void keep(u)}>{t('instructionUpdates.keepMine')}</Button>
                  )}
                  {u.state !== 'edited' && !u.permission_file && u.installed && (
                    <Button size="sm" variant="secondary" disabled={saving !== null || preview === u.path} onClick={() => void startUseApp(u)}>{t('instructionUpdates.useApp')}</Button>
                  )}
                  {u.state === 'edited' && (
                    <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('instructionUpdates.editedHint', { path: u.path })}</span>
                  )}
                  {!u.installed && (
                    <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('instructionUpdates.notInstalledHint')}</span>
                  )}
                  {u.permission_file && u.installed && (
                    <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('instructionUpdates.permissionHint')}</span>
                  )}
                  {open?.path === u.path && comparisonOf(open)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
