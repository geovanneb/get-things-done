import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import { formatRelativeDate } from '@/utils/format';
import { filterUpdates, HISTORY_PAGE, READY_FOR_YOU, TO_ANALYZE, typeCounts, UPDATE_TYPES, type TypeFilter } from '@/utils/updateTypes';
import type { ContextUpdate, ContextUpdateStatus } from '@/types';
import { HelpBox, StatusPill, TypeBadge, sectionLabel } from './shared';

const GROUPS = (): { id: string; title: string; hint: string; statuses: ContextUpdateStatus[]; paged?: boolean }[] => ([
  // Your turn first, then the agent's: the counts by the title take the user to these two.
  { id: 'updates-ready-for-you', title: tr('updatesList.readyForYou'), hint: tr('updatesList.analyzedAndWaitingForYour'), statuses: READY_FOR_YOU },
  { id: 'updates-to-analyze', title: tr('updatesList.toAnalyze'), hint: tr('updatesList.materialWaitingForAnAnalysis'), statuses: TO_ANALYZE },
  { id: 'updates-agent-working', title: tr('updatesList.agentWorking'), hint: tr('updatesList.theseUpdateByThemselves'), statuses: ['analyzing', 'applying'] },
  { id: 'updates-history', title: tr('updatesList.history'), hint: tr('updatesList.whatEachUpdateChangedMaterials'), statuses: ['done'], paged: true },
]);

function summaryLine(u: ContextUpdate): string {
  if (u.kind === 'memory-review' && (u.status === 'ready' || u.status === 'analyzing')) return tr('updatesList.reviewOfYourExistingMemory');
  const files = tr('updatesList.files', { count: u.materials.length });
  if (u.status === 'ready' || u.status === 'analyzing') return files;
  const accepted = u.proposals.filter((p) => p.decision === 'accepted').length;
  if (u.status === 'done') return tr('updatesList.ofChangesApplied', { count: u.proposals.length, files, value: u.keep_materials ? ' (kept)' : '', accepted });
  return tr('updatesList.proposals', { count: u.proposals.length, files });
}

const STEPS = () => ((
  <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
    <li>{rich(tr, 'updatesList.uploadFilesOrPasteA', { strong: <strong>{tr('updatesList.collect')}</strong> })}</li>
    <li>{rich(tr, 'updatesList.copyTheCommandAndRun', { strong: <strong>{tr('updatesList.analyze')}</strong> })}</li>
    <li>{rich(tr, 'updatesList.tickTheProposalsYouAccept', { strong: <strong>{tr('updatesList.review')}</strong> })}</li>
    <li>{rich(tr, 'updatesList.runTheSecondCommandDone', { strong: <strong>{tr('updatesList.apply')}</strong> })}</li>
  </ol>
));

const INTRO = () => tr('updatesList.meetingsDecksAndPhotosChange');

/**
 * Same look as the Board's priority filter: small chips, the active one filled. The counts follow the search,
 * so a chip never promises updates the list will not show.
 */
function TypeChips({ updates, query, value, onChange }: { updates: ContextUpdate[]; query: string; value: TypeFilter; onChange: (value: TypeFilter) => void }) {
  const { t } = useLanguage();
  const matching = filterUpdates(updates, 'all', query);
  const counts = typeCounts(matching);
  const present = typeCounts(updates);
  const options = [
    { id: 'all' as const, label: t('all'), count: matching.length, hint: t('updatesList.everyUpdate') },
    // Chips stay put while typing: a type is listed when the workspace has it, not when the search finds it.
    ...UPDATE_TYPES().filter((t) => present[t.id] || t.id === value).map((t) => ({ id: t.id, label: t.label, count: counts[t.id] ?? 0, hint: t.hint })),
  ];
  return (
    <div role="group" aria-label={t('filterByType')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} type="button" aria-pressed={active} title={o.hint} onClick={() => onChange(o.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', fontSize: 'var(--text-xs)', fontWeight: 500, fontFamily: 'inherit',
              borderRadius: 'var(--radius-sm)', border: '1px solid', cursor: 'pointer', transition: 'background 0.1s, color 0.1s',
              ...(active
                ? { background: 'var(--color-accent)', color: 'var(--color-text-on-accent)', borderColor: 'var(--color-accent)' }
                : { background: 'transparent', color: 'var(--color-text-secondary)', borderColor: 'var(--color-border)' }),
            }}>
            {o.label}
            <span style={{ fontWeight: 600, opacity: active ? 0.9 : 0.7 }}>{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function UpdateRow({ u, onOpen }: { u: ContextUpdate; onOpen: (id: string) => void }) {
  const { t } = useLanguage();
  return (
    <button type="button" onClick={() => onOpen(u.id)}
      style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', cursor: 'pointer', textAlign: 'left', color: 'var(--color-text)', fontFamily: 'inherit' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}>
      <span style={{ flex: '1 1 260px', minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--text-base)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{u.title}</span>
          <TypeBadge origin={u.origin} kind={u.kind} />
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {rich(t, 'updatesList.updated', { part: <span style={{ fontFamily: 'var(--font-mono)' }}>{u.id}</span>, value: u.kaizen ? (u.kaizen.task_ref ? t('updatesList.from', { task_ref: u.kaizen.task_ref }) : '') : u.kind === 'memory-review' ? '' : t('updatesList.materialFrom', { source_date: u.source_date || t('updateDetail.unknownDate') }), summaryLine: summaryLine(u), updated_at: formatRelativeDate(u.updated_at || u.created_at) })}
        </span>
      </span>
      <StatusPill status={u.status} />
    </button>
  );
}

export default function UpdatesList({ updates, type, query, historyShown, onType, onShowMore, onClearFilters, onOpen, onImport }: {
  updates: ContextUpdate[];
  type: TypeFilter;
  query: string;
  /** How many finished updates History shows. */
  historyShown: number;
  onType: (type: TypeFilter) => void;
  onShowMore: () => void;
  onClearFilters: () => void;
  onOpen: (id: string) => void;
  onImport: () => void;
}) {
  const { t } = useLanguage();
  if (updates.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 900 }}>
        <HelpBox title={t('updatesList.keepYourContextTrueWithout')}>{INTRO()}{STEPS()}</HelpBox>
        <EmptyState title={t('updatesList.noContextUpdatesYet')}
          description={t('updatesList.importATranscriptADeck')}
          action={{ label: t('updatesList.importUpdate'), onClick: onImport }} />
      </div>
    );
  }

  const shown = filterUpdates(updates, type, query);
  const filtering = type !== 'all' || query.trim() !== '';
  // One type only: there is nothing to tell apart.
  const showChips = Object.keys(typeCounts(updates)).length > 1 || type !== 'all';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 900 }}>
      {/* Once there are updates, the explanation is reference: closed, so the work comes first. */}
      <details style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)', lineHeight: 1.5 }}>
        <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>{t('updatesList.howContextUpdatesWork')}</summary>
        <div style={{ marginTop: 8 }}><HelpBox>{INTRO()}{STEPS()}</HelpBox></div>
      </details>

      {(showChips || (filtering && shown.length > 0)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {showChips && <TypeChips updates={updates} query={query} value={type} onChange={onType} />}
          {filtering && shown.length > 0 && <Button variant="ghost" size="sm" onClick={onClearFilters}>{t('updatesList.clearFilters')}</Button>}
        </div>
      )}

      {shown.length === 0 && (
        <EmptyState title={t('updatesList.noUpdatesMatch')}
          description={query.trim() ? t('updatesList.nothingWithInTheTitle', { trim: query.trim() }) : t('updatesList.thereAreNoUpdatesOf')}
          action={{ label: t('updatesList.clearFilters'), onClick: onClearFilters }} />
      )}

      {GROUPS().map((group) => {
        const items = shown.filter((u) => group.statuses.includes(u.status))
          .sort((a, b) => group.statuses.indexOf(a.status) - group.statuses.indexOf(b.status) || b.id.localeCompare(a.id));
        if (items.length === 0) return null;
        const visible = group.paged ? items.slice(0, historyShown) : items;
        const rest = items.length - visible.length;
        return (
          <section key={group.title} id={group.id} aria-label={group.title} tabIndex={-1} style={{ scrollMarginTop: 'var(--space-4)', outlineOffset: 4 }}>
            <h2 style={sectionLabel}>{group.title} · {items.length}</h2>
            <p style={{ margin: '-4px 0 8px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{group.hint}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visible.map((u) => <UpdateRow key={u.id} u={u} onOpen={onOpen} />)}
            </div>
            {rest > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{rich(t, 'updatesList.showingOf', { length: visible.length, length2: items.length })}</span>
                <Button variant="secondary" size="sm" onClick={onShowMore}>{rich(t, 'updatesList.showMore', { min: Math.min(rest, HISTORY_PAGE) })}</Button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
