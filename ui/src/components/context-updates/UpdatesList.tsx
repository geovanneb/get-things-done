import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import { formatRelativeDate } from '@/utils/format';
import { filterUpdates, HISTORY_PAGE, typeCounts, UPDATE_TYPES, type TypeFilter } from '@/utils/updateTypes';
import type { ContextUpdate, ContextUpdateStatus } from '@/types';
import { HelpBox, StatusPill, TypeBadge, sectionLabel } from './shared';

const GROUPS: { title: string; hint: string; statuses: ContextUpdateStatus[]; paged?: boolean }[] = [
  { title: 'Waiting on you', hint: 'Run a command, or review proposals.', statuses: ['in_review', 'ready', 'approved'] },
  { title: 'Agent working', hint: 'These update by themselves.', statuses: ['analyzing', 'applying'] },
  { title: 'History', hint: 'What each update changed. Materials were deleted when it finished, unless you kept them.', statuses: ['done'], paged: true },
];

function summaryLine(u: ContextUpdate): string {
  if (u.kind === 'memory-review' && (u.status === 'ready' || u.status === 'analyzing')) return 'review of your existing memory';
  const files = `${u.materials.length} file${u.materials.length === 1 ? '' : 's'}`;
  if (u.status === 'ready' || u.status === 'analyzing') return files;
  const accepted = u.proposals.filter((p) => p.decision === 'accepted').length;
  if (u.status === 'done') return `${files}${u.keep_materials ? ' (kept)' : ''} · ${accepted} of ${u.proposals.length} change${u.proposals.length === 1 ? '' : 's'} applied`;
  return `${files} · ${u.proposals.length} proposal${u.proposals.length === 1 ? '' : 's'}`;
}

const STEPS = (
  <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
    <li><strong>Collect:</strong> upload files or paste a transcript.</li>
    <li><strong>Analyze:</strong> copy the command and run it in Claude Code.</li>
    <li><strong>Review:</strong> tick the proposals you accept.</li>
    <li><strong>Apply:</strong> run the second command. Done.</li>
  </ol>
);

const INTRO = 'Meetings, decks and photos change what is true about your organization, stakeholders and plans. Import them here. An agent compares them with your current context and proposes only the changes that matter. You review each change as a before and after, accept what is right, and the agent applies only that.';

/**
 * Same look as the Board's priority filter: small chips, the active one filled. The counts follow the search,
 * so a chip never promises updates the list will not show.
 */
function TypeChips({ updates, query, value, onChange }: { updates: ContextUpdate[]; query: string; value: TypeFilter; onChange: (value: TypeFilter) => void }) {
  const matching = filterUpdates(updates, 'all', query);
  const counts = typeCounts(matching);
  const present = typeCounts(updates);
  const options = [
    { id: 'all' as const, label: 'All', count: matching.length, hint: 'Every update' },
    // Chips stay put while typing: a type is listed when the workspace has it, not when the search finds it.
    ...UPDATE_TYPES.filter((t) => present[t.id] || t.id === value).map((t) => ({ id: t.id, label: t.label, count: counts[t.id] ?? 0, hint: t.hint })),
  ];
  return (
    <div role="group" aria-label="Filter by type" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
  return (
    <button type="button" onClick={() => onOpen(u.id)}
      style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', cursor: 'pointer', textAlign: 'left', color: 'var(--color-text)', fontFamily: 'inherit' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}>
      <span style={{ flex: '1 1 260px', minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--text-base)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{u.title}</span>
          <TypeBadge origin={u.origin} />
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{u.id}</span>{u.kaizen ? (u.kaizen.task_ref ? ` · from ${u.kaizen.task_ref}` : '') : u.kind === 'memory-review' ? '' : ` · material from ${u.source_date || 'unknown date'}`} · {summaryLine(u)} · updated {formatRelativeDate(u.updated_at || u.created_at)}
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
  if (updates.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 900 }}>
        <HelpBox title="Keep your context true, without the busywork">{INTRO}{STEPS}</HelpBox>
        <EmptyState title="No context updates yet"
          description="Import a transcript, a deck or any other material that may change your context."
          action={{ label: 'Import update', onClick: onImport }} />
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
        <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>How context updates work</summary>
        <div style={{ marginTop: 8 }}><HelpBox>{INTRO}{STEPS}</HelpBox></div>
      </details>

      {(showChips || (filtering && shown.length > 0)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {showChips && <TypeChips updates={updates} query={query} value={type} onChange={onType} />}
          {filtering && shown.length > 0 && <Button variant="ghost" size="sm" onClick={onClearFilters}>Clear filters</Button>}
        </div>
      )}

      {shown.length === 0 && (
        <EmptyState title="No updates match"
          description={query.trim() ? `Nothing with "${query.trim()}" in the title or ID for this filter.` : 'There are no updates of this type.'}
          action={{ label: 'Clear filters', onClick: onClearFilters }} />
      )}

      {GROUPS.map((group) => {
        const items = shown.filter((u) => group.statuses.includes(u.status))
          .sort((a, b) => group.statuses.indexOf(a.status) - group.statuses.indexOf(b.status) || b.id.localeCompare(a.id));
        if (items.length === 0) return null;
        const visible = group.paged ? items.slice(0, historyShown) : items;
        const rest = items.length - visible.length;
        return (
          <section key={group.title} aria-label={group.title}>
            <h2 style={sectionLabel}>{group.title} · {items.length}</h2>
            <p style={{ margin: '-4px 0 8px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{group.hint}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visible.map((u) => <UpdateRow key={u.id} u={u} onOpen={onOpen} />)}
            </div>
            {rest > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Showing {visible.length} of {items.length}</span>
                <Button variant="secondary" size="sm" onClick={onShowMore}>Show {Math.min(rest, HISTORY_PAGE)} more</Button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
