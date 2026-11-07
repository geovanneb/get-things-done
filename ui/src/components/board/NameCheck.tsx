import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Button from '@/components/common/Button';
import { sectionLabelStyle } from '@/components/task-form/styles';
import { useNotify } from '@/hooks/useNotify';
import { apiPost, apiPut } from '@/utils/api';
import { checkableDeliverables, visibleFindings, type NameCheckRun } from '@/utils/nameCheck';
import type { Task } from '@/types';

/**
 * Names and terms (#85): an advisory, on-demand check of a Markdown, HTML or text deliverable against the stakeholder
 * names and the glossary. It never changes the deliverable, the stakeholders or the glossary, and never blocks a status.
 */
export default function NameCheck({ task, dirty }: { task: Task; dirty: boolean }) {
  const { t } = useLanguage();
  const notify = useNotify();
  const [runs, setRuns] = React.useState<Record<string, NameCheckRun>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [showDismissed, setShowDismissed] = React.useState<Record<string, boolean>>({});
  const items = checkableDeliverables(task.deliverables ?? []);
  if (items.length === 0) return null;

  const base = (id: string) => `/api/tasks/${encodeURIComponent(task.id)}/deliverables/${encodeURIComponent(id)}/name-check`;

  const check = async (id: string) => {
    setBusy(id);
    try {
      const run = await apiPost<NameCheckRun>(base(id));
      setRuns((r) => ({ ...r, [id]: run }));
    } catch (err) {
      notify.error(err, t('nameCheck.couldNotCheck'));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (id: string, key: string, dismissed: boolean) => {
    try {
      await apiPut(`${base(id)}/dismissed`, { key, dismissed });
      setRuns((r) => r[id] ? { ...r, [id]: { ...r[id]!, findings: r[id]!.findings.map((f) => f.key === key ? { ...f, dismissed } : f) } } : r);
    } catch (err) {
      notify.error(err, t('nameCheck.couldNotSave'));
    }
  };

  return (
    <section aria-labelledby={`name-check-${task.id}`} style={{ marginBottom: 'var(--space-6)' }}>
      <h3 id={`name-check-${task.id}`} style={{ ...sectionLabelStyle, marginBottom: 'var(--space-1)' }}>{t('nameCheck.title')}</h3>
      <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
        {dirty ? t('nameCheck.saveFirst') : t('nameCheck.intro')}
      </p>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {items.map((d) => {
          const run = runs[d.id];
          const { shown, dismissed } = run ? visibleFindings(run.findings) : { shown: [], dismissed: [] };
          const list = showDismissed[d.id] ? [...shown, ...dismissed] : shown;
          return (
            <div key={d.id} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{d.id}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.file_path}>
                  {d.file_path.split('/').pop()}
                </span>
                <Button size="sm" variant="secondary" loading={busy === d.id} disabled={dirty || (busy !== null && busy !== d.id)} onClick={() => void check(d.id)}>
                  {run ? t('nameCheck.checkAgain') : t('nameCheck.check')}
                </Button>
              </div>
              {run && (
                <div style={{ marginTop: 'var(--space-2)' }} aria-live="polite">
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                      {shown.length === 0 ? t('nameCheck.nothingToLookAt') : t('nameCheck.toLookAt', { count: shown.length })}
                    </span>
                    {dismissed.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setShowDismissed((s) => ({ ...s, [d.id]: !s[d.id] }))}>
                        {showDismissed[d.id] ? t('nameCheck.hideDismissed') : t('nameCheck.showDismissed', { count: dismissed.length })}
                      </Button>
                    )}
                  </div>
                  {list.length > 0 && (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
                      {list.map((f) => (
                        <li key={f.key} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', opacity: f.dismissed ? 0.6 : 1 }}>
                          <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)' }}>
                            <div>
                              {f.kind === 'person'
                                ? t('nameCheck.didYouMean', { found: f.found, suggestion: f.suggestion ?? '' })
                                : t('nameCheck.unknownAbbreviation', { found: f.found })}
                              <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                                {f.count > 1 ? t('nameCheck.lineMore', { line: f.line, count: f.count - 1 }) : t('nameCheck.line', { line: f.line })}
                              </span>
                            </div>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{f.snippet}</div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => void dismiss(d.id, f.key, !f.dismissed)}>
                            {f.dismissed ? t('nameCheck.restore') : t('nameCheck.dismiss')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
