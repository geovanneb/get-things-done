import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import { formatRelativeDate } from '@/utils/format';
import type { ContextUpdate, ContextUpdateStatus } from '@/types';
import { HelpBox, StatusPill, sectionLabel } from './shared';

const GROUPS: { title: string; hint: string; statuses: ContextUpdateStatus[] }[] = [
  { title: 'Waiting on you', hint: 'Run a command, or review proposals.', statuses: ['in_review', 'ready', 'approved'] },
  { title: 'Agent working', hint: 'These update by themselves.', statuses: ['analyzing', 'applying'] },
  { title: 'History', hint: 'What each update changed. Materials were deleted when it finished.', statuses: ['done'] },
];

function summaryLine(u: ContextUpdate): string {
  const files = `${u.materials.length} file${u.materials.length === 1 ? '' : 's'}`;
  if (u.status === 'ready' || u.status === 'analyzing') return files;
  const accepted = u.proposals.filter((p) => p.decision === 'accepted').length;
  if (u.status === 'done') return `${files} · ${accepted} of ${u.proposals.length} change${u.proposals.length === 1 ? '' : 's'} applied`;
  return `${files} · ${u.proposals.length} proposal${u.proposals.length === 1 ? '' : 's'}`;
}

export default function UpdatesList({ updates, onOpen, onImport }: { updates: ContextUpdate[]; onOpen: (id: string) => void; onImport: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 900 }}>
      <HelpBox title="Keep your context true, without the busywork">
        Meetings, decks and photos change what is true about your organization, stakeholders and plans. Import them
        here. An agent compares them with your current context and proposes only the changes that matter. You
        review each change as a before and after, accept what is right, and the agent applies only that.
        <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li><strong>Collect:</strong> upload files or paste a transcript.</li>
          <li><strong>Analyze:</strong> copy the command and run it in Claude Code.</li>
          <li><strong>Review:</strong> tick the proposals you accept.</li>
          <li><strong>Apply:</strong> run the second command. Done.</li>
        </ol>
      </HelpBox>

      {updates.length === 0 && (
        <EmptyState title="No context updates yet"
          description="Import a transcript, a deck or any other material that may change your context."
          action={{ label: 'Import update', onClick: onImport }} />
      )}

      {GROUPS.map((group) => {
        const items = updates.filter((u) => group.statuses.includes(u.status))
          .sort((a, b) => group.statuses.indexOf(a.status) - group.statuses.indexOf(b.status) || b.id.localeCompare(a.id));
        if (items.length === 0) return null;
        return (
          <section key={group.title} aria-label={group.title}>
            <h2 style={sectionLabel}>{group.title} · {items.length}</h2>
            <p style={{ margin: '-4px 0 8px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{group.hint}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.map((u) => (
                <button key={u.id} type="button" onClick={() => onOpen(u.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', cursor: 'pointer', textAlign: 'left', color: 'var(--color-text)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}>
                  <span style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 'var(--text-base)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.title}</span>
                    <span style={{ display: 'block', marginTop: 2, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{u.id}</span> · material from {u.source_date || 'unknown date'} · {summaryLine(u)} · updated {formatRelativeDate(u.updated_at || u.created_at)}
                    </span>
                  </span>
                  <StatusPill status={u.status} />
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {updates.length > 0 && (
        <div><Button variant="secondary" onClick={onImport}>+ Import another update</Button></div>
      )}
    </div>
  );
}
