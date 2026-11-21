import { useLanguage } from '@/i18n/LanguageProvider';
import { useState } from 'react';
import Button from './Button';
import IconButton, { icons } from './IconButton';
import Modal from './Modal';
import Notice from './Notice';
import { useNotify } from '@/hooks/useNotify';
import { apiGet } from '@/utils/api';
import { canShowInFolder, showInFolder, workspaceFullPath } from '@/utils/desktop';
import type { WorkspaceConfig } from '@/types';

/** What to show: a path relative to the workspace (a folder, or a file to show selected in its folder), and a note. */
export interface ShowInFolderTarget { path: string; note?: string | null }

/**
 * Open folder for any file or folder of the workspace. In the desktop app it reveals it in Finder or Explorer (a file
 * selected in its folder, a folder shown from inside); nothing is ever opened or launched. In a browser, which cannot
 * open folders, it shows the full path to copy. `path` is workspace-relative, or a function that looks it up when
 * clicked (so a list does not ask for every row).
 */
export default function ShowInFolderButton({ path, label, iconOnly = false, size = 'sm', variant = 'secondary' }: {
  path: string | (() => Promise<ShowInFolderTarget>);
  label?: string;
  /** A square icon button (for a row or a dialog header) instead of a button with text. */
  iconOnly?: boolean;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const { t } = useLanguage();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ full: string; note: string | null } | null>(null);
  const text = label ?? t('showInFolder.open');

  const open = async () => {
    setBusy(true);
    try {
      const target = typeof path === 'string' ? { path } : await path();
      if (canShowInFolder()) {
        await showInFolder(target.path);
        if (target.note) notify.info(target.note);
      } else {
        const { path: workspace } = await apiGet<WorkspaceConfig>('/api/workspace');
        if (!workspace) throw new Error(t('showInFolder.noWorkspace'));
        setShown({ full: workspaceFullPath(workspace, target.path), note: target.note ?? null });
      }
    } catch (err) {
      notify.error(err, t('showInFolder.couldNotOpen'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.full);
      notify.success(t('showInFolder.copied'));
    } catch {
      notify.warning(t('showInFolder.couldNotCopy'));
    }
  };

  return (
    <>
      {iconOnly
        ? <IconButton label={text} icon={icons.folder} size={size} outline disabled={busy} onClick={() => void open()} />
        : <Button size={size} variant={variant} icon={icons.folder} loading={busy} onClick={() => void open()}>{text}</Button>}
      <Modal isOpen={shown !== null} onClose={() => setShown(null)} title={t('showInFolder.title')} size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => setShown(null)}>{t('showInFolder.close')}</Button>
          <Button variant="primary" icon={icons.copy} onClick={() => void copy()}>{t('showInFolder.copy')}</Button>
        </>}>
        <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{t('showInFolder.browserHint')}</p>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 'var(--space-1)' }}>{t('showInFolder.path')}</div>
            <code className="mono" aria-label={t('showInFolder.path')}
              style={{ display: 'block', userSelect: 'all', overflowWrap: 'anywhere', fontSize: 'var(--text-sm)', padding: 'var(--space-2) var(--space-3)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}>
              {shown?.full}
            </code>
          </div>
          {shown?.note && <Notice tone="info">{shown.note}</Notice>}
        </div>
      </Modal>
    </>
  );
}
