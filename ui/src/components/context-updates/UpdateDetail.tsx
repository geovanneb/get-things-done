import { useEffect, useMemo, useState } from 'react';
import Button from '@/components/common/Button';
import { Textarea } from '@/components/common/Input';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import { useApi } from '@/hooks/useApi';
import { useAppDispatch, useDataVersion } from '@/store';
import { apiDelete, apiPost, apiPut } from '@/utils/api';
import { diffLines, diffStats } from '@/utils/lineDiff';
import { formatRelativeDate } from '@/utils/format';
import type { ContextUpdate, ContextUpdateProposal } from '@/types';
import DiffView from './DiffView';
import { DropZone, uploadMaterial } from './ImportUpdateModal';
import { CommandBox, HelpBox, STATUS_META, StatusPill, StepIndicator, formatBytes, sectionLabel } from './shared';

const card: React.CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 16,
};

const CONFIDENCE: Record<string, { label: string; color: string; hint: string }> = {
  high: { label: 'High confidence', color: 'var(--color-success)', hint: 'Stated clearly by someone who owns the topic.' },
  medium: { label: 'Medium confidence', color: 'var(--color-warning)', hint: 'Likely right, but check the evidence.' },
  low: { label: 'Low confidence', color: 'var(--color-critical)', hint: 'Unconfirmed or contradicted. Check before accepting.' },
};

const OUTCOME: Record<string, string> = {
  applied: 'Applied as reviewed',
  merged: 'Applied, merged with newer edits',
  failed: 'Could not be applied',
  skipped: 'Not applied',
};

type Decisions = Record<string, { decision: ContextUpdateProposal['decision']; reviewer_note: string }>;

function ProposalCard({ proposal, reviewing, decision, onToggle, onNote }: {
  proposal: ContextUpdateProposal;
  reviewing: boolean;
  decision: Decisions[string];
  onToggle: (accepted: boolean) => void;
  onNote: (note: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(true);
  const [note, setNote] = useState(decision.reviewer_note);
  useEffect(() => setNote(decision.reviewer_note), [decision.reviewer_note]);

  const accepted = decision.decision === 'accepted';
  const stats = useMemo(() => (proposal.proposed != null ? diffStats(diffLines(proposal.current ?? null, proposal.proposed)) : null), [proposal.current, proposal.proposed]);
  const confidence = CONFIDENCE[proposal.confidence];
  const blocked = !!proposal.problem;
  const checkboxId = `accept-${proposal.id}`;

  return (
    <article style={{ ...card, padding: 0, borderLeft: `3px solid ${reviewing ? (accepted ? 'var(--color-success)' : 'var(--color-border-strong)') : decision.decision === 'accepted' ? 'var(--color-success)' : 'var(--color-border)'}` }}>
      <div style={{ display: 'flex', gap: 12, padding: '14px 16px', alignItems: 'flex-start' }}>
        {reviewing && (
          <input id={checkboxId} type="checkbox" checked={accepted} disabled={blocked}
            onChange={(e) => onToggle(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0, cursor: blocked ? 'not-allowed' : 'pointer', accentColor: 'var(--color-success)' }} />
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label htmlFor={reviewing ? checkboxId : undefined} style={{ fontWeight: 600, fontSize: 'var(--text-base)', cursor: reviewing ? 'pointer' : 'default' }}>
              {proposal.title || proposal.target}
            </label>
            <span style={{ padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', fontWeight: 600, background: proposal.action === 'create' ? 'var(--color-info-subtle)' : 'var(--color-accent-subtle)', color: proposal.action === 'create' ? 'var(--color-info)' : 'var(--color-accent)' }}>
              {proposal.action === 'create' ? 'New file' : 'Update'}
            </span>
            {proposal.category && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{proposal.category}</span>}
            {confidence && <span title={confidence.hint} style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: confidence.color }}>{confidence.label}</span>}
            {!reviewing && decision.decision && (
              <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', fontWeight: 600, color: decision.decision === 'accepted' ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                {decision.decision === 'accepted' ? 'Accepted' : 'Rejected'}{proposal.outcome ? ` · ${OUTCOME[proposal.outcome] ?? proposal.outcome}` : ''}
              </span>
            )}
          </div>
          <code style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{proposal.target}</code>

          {proposal.rationale && (
            <div>
              <div style={{ ...sectionLabel, marginBottom: 2 }}>Why</div>
              <MarkdownView content={proposal.rationale} compact />
            </div>
          )}
          {proposal.evidence && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              <span style={{ fontWeight: 600 }}>Evidence: </span>{proposal.evidence}
            </div>
          )}
          {proposal.outcome_note && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}><span style={{ fontWeight: 600 }}>Agent: </span>{proposal.outcome_note}</div>}

          {proposal.problem && <HelpBox tone="critical">{proposal.problem}</HelpBox>}
          {proposal.stale && (
            <HelpBox tone="warning" title="This file changed after the analysis">
              {proposal.action === 'create' && proposal.target_exists
                ? 'A file now exists at this path. The diff below is against it. If you accept, the agent merges instead of overwriting.'
                : 'Someone edited it since the agent looked. The diff below is against the current version, so it may show more than the proposal meant. If you accept, the agent keeps the newer edits and merges.'}
            </HelpBox>
          )}

          {proposal.proposed != null && (
            <div>
              <button type="button" onClick={() => setShowDiff((v) => !v)} aria-expanded={showDiff}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: 0, marginBottom: 6, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-accent)' }}>
                {showDiff ? 'Hide changes' : 'Show changes'}
                {stats && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    <span style={{ color: 'var(--color-success)' }}>+{stats.added}</span>{' '}
                    <span style={{ color: 'var(--color-critical)' }}>−{stats.removed}</span>
                  </span>
                )}
              </button>
              {showDiff && <DiffView before={proposal.current ?? null} after={proposal.proposed} />}
            </div>
          )}

          {reviewing && accepted && (
            <div>
              <div style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                Note for the agent (optional)
              </div>
              <p style={{ margin: '0 0 4px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                Almost right? Say what to adjust, for example "keep the old title" or "say this is still a draft". The agent applies the change with your adjustment.
              </p>
              <div onBlur={() => { if (note !== decision.reviewer_note) onNote(note); }}>
                <Textarea value={note} onChange={setNote} rows={2} aria-label={`Note for ${proposal.id}`} />
              </div>
            </div>
          )}
          {!reviewing && decision.reviewer_note && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}><span style={{ fontWeight: 600 }}>Your note: </span>{decision.reviewer_note}</div>
          )}
        </div>
      </div>
    </article>
  );
}

export default function UpdateDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const version = useDataVersion('context-updates');
  const { data, loading, error, refetch } = useApi<ContextUpdate>(`/api/context-updates/${id}`, [version]);
  const dispatch = useAppDispatch();
  const [decisions, setDecisions] = useState<Decisions>({});
  const [busy, setBusy] = useState<string | null>(null);

  const notify = (type: 'success' | 'error' | 'info', message: string) => dispatch({ type: 'ADD_NOTIFICATION', payload: { type, message } });

  useEffect(() => {
    if (!data) return;
    setDecisions(Object.fromEntries(data.proposals.map((p) => [p.id, { decision: p.decision, reviewer_note: p.reviewer_note }])));
  }, [data]);

  if (loading) return <LoadingSpinner text="Loading update..." />;
  if (error || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600 }}>
        <HelpBox tone="critical">This update could not be loaded. It may have been deleted.</HelpBox>
        <div><Button variant="secondary" onClick={onBack}>Back to updates</Button></div>
      </div>
    );
  }

  const u = data;
  const meta = STATUS_META[u.status];
  const reviewing = u.status === 'in_review';
  const selectable = u.proposals.filter((p) => !p.problem);
  const acceptedCount = u.proposals.filter((p) => decisions[p.id]?.decision === 'accepted').length;

  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      await action();
      if (success) notify('success', success);
      refetch();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const saveDecision = async (pid: string, change: Partial<Decisions[string]>) => {
    const previous = decisions;
    setDecisions((d) => ({ ...d, [pid]: { ...d[pid]!, ...change } }));
    try {
      await apiPut(`/api/context-updates/${u.id}/decisions`, { decisions: { [pid]: change } });
    } catch (err) {
      setDecisions(previous);
      notify('error', err instanceof Error ? err.message : 'Could not save your choice.');
    }
  };

  const selectAll = async (accept: boolean) => {
    const change = Object.fromEntries(selectable.map((p) => [p.id, { decision: accept ? 'accepted' : null }]));
    setDecisions((d) => {
      const next = { ...d };
      for (const p of selectable) next[p.id] = { ...next[p.id]!, decision: accept ? 'accepted' : null };
      return next;
    });
    try { await apiPut(`/api/context-updates/${u.id}/decisions`, { decisions: change }); } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Could not save your choice.');
      refetch();
    }
  };

  const addFiles = (files: File[]) => run('upload', async () => {
    const errors: string[] = [];
    for (const f of files) { const e = await uploadMaterial(u.id, f); if (e) errors.push(e); }
    if (errors.length) throw new Error(errors.join('; '));
  });

  const removeFile = (name: string) => {
    if (!window.confirm(`Remove "${name}" from this update?`)) return;
    void run('remove', () => apiDelete(`/api/context-updates/${u.id}/materials/${encodeURIComponent(name)}`));
  };

  const reopen = () => {
    const msg = u.status === 'analyzing'
      ? 'Stop waiting for the agent and go back to collecting? Run the analysis again afterwards.'
      : 'Add more material? The current proposals are discarded, and the next analysis looks at all material together.';
    if (window.confirm(msg)) void run('reopen', () => apiPost(`/api/context-updates/${u.id}/reopen`));
  };

  const close = () => {
    if (!window.confirm('Close this update without changing any context file? The record stays; the materials are deleted.')) return;
    void run('close', () => apiPost(`/api/context-updates/${u.id}/close`), 'Closed without changes.');
  };

  const remove = () => {
    const msg = u.status === 'done'
      ? 'Delete this record? Context changes it made stay; only the record goes.'
      : 'Delete this update and its materials? Nothing in your context has changed yet.';
    if (!window.confirm(msg)) return;
    void (async () => {
      try { await apiDelete(`/api/context-updates/${u.id}`); notify('success', 'Update deleted.'); onBack(); } catch (err) {
        notify('error', err instanceof Error ? err.message : 'Could not delete.');
      }
    })();
  };

  const materials = u.status === 'done' ? u.materials.map((m) => ({ ...m, modified: '' })) : (u.material_files ?? []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 980, paddingBottom: reviewing ? 80 : 0 }}>
      <div>
        <button type="button" onClick={onBack} style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
          ← All updates
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 700 }}>{u.title}</h2>
          <StatusPill status={u.status} />
          <span style={{ marginLeft: 'auto' }}>
            {u.status !== 'applying' && <Button variant="ghost" size="sm" onClick={remove}>Delete</Button>}
          </span>
        </div>
        <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{u.id}</span> · material from {u.source_date || 'unknown date'} · imported {formatRelativeDate(u.created_at)}
          {u.applied_at && <> · finished {formatRelativeDate(u.applied_at)}</>}
        </div>
      </div>

      <div style={card}><StepIndicator status={u.status} /></div>

      {/* What to do next: always one clear action. */}
      <section aria-label="Next step" style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12, borderColor: meta.color }}>
        <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}><strong>Next: </strong>{meta.next}</div>
        {(u.status === 'ready' || u.status === 'analyzing') && (
          <CommandBox command={`/gtd-context-analyze ${u.id}`} label="Run in Claude Code to analyze" />
        )}
        {(u.status === 'approved' || u.status === 'applying') && (
          <CommandBox command={`/gtd-context-apply ${u.id}`} label="Run in Claude Code to apply your accepted changes" />
        )}
        {(u.status === 'analyzing' || u.status === 'applying') && (
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            Taking too long, or the agent stopped? Run the same command again: it picks up where it left off.
            {u.status === 'analyzing' && <> Or <button type="button" onClick={reopen} style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'inherit' }}>go back to collecting</button>.</>}
          </p>
        )}
        {(u.status === 'ready' || u.status === 'analyzing') && (
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            Using Codex or Copilot? Ask it to "analyze context update {u.id}". The workspace instructions explain the steps.
          </p>
        )}
        {u.status === 'approved' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" size="sm" loading={busy === 'back'} onClick={() => run('back', () => apiPost(`/api/context-updates/${u.id}/back-to-review`))}>Change my selection</Button>
          </div>
        )}
      </section>

      {u.notes && (
        <section aria-label="Notes for the agent">
          <h3 style={sectionLabel}>Your notes for the agent</h3>
          <div style={card}><MarkdownView content={u.notes} compact /></div>
        </section>
      )}

      <section aria-label="Materials">
        <h3 style={sectionLabel}>Materials · {materials.length}</h3>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {u.status === 'done' && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Deleted when the update finished. Only the list is kept.</p>}
          {materials.length === 0 && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No files yet.</p>}
          {materials.map((f) => (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)' }}>
              {u.status === 'done'
                ? <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-text-secondary)' }}>{f.name}</span>
                : <a href={`/api/context-updates/${u.id}/materials/${f.name.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-accent)' }}>{f.name}</a>}
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
              {u.status === 'ready' && (
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.name)}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 'var(--text-base)', padding: '0 4px' }}>×</button>
              )}
            </div>
          ))}
          {u.status === 'ready' && <DropZone onFiles={(files) => void addFiles(files)} compact />}
          {busy === 'upload' && <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Uploading...</span>}
          {(u.status === 'in_review' || u.status === 'approved') && (
            <div><Button variant="ghost" size="sm" onClick={reopen}>+ Add more material</Button></div>
          )}
        </div>
      </section>

      {['in_review', 'approved', 'applying', 'done'].includes(u.status) && (
        <section aria-label="Analysis">
          <h3 style={sectionLabel}>What the agent found</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {u.summary && <div style={card}><MarkdownView content={u.summary} compact /></div>}
            {u.unread.length > 0 && (
              <HelpBox tone="warning" title="Some files could not be read">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {u.unread.map((r) => <li key={r.name}><strong>{r.name}</strong>: {r.reason}</li>)}
                </ul>
              </HelpBox>
            )}

            {u.proposals.length === 0 ? (
              <HelpBox title="Nothing worth changing">
                The agent found nothing in this material that should change your context. That is a normal result: not
                every meeting changes what is true. {reviewing && 'Close the update to finish.'}
              </HelpBox>
            ) : (
              <>
                {reviewing && (
                  <HelpBox>
                    Each proposal shows the file as it is now and as it would become: <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>+ green</span> lines
                    are added, <span style={{ color: 'var(--color-critical)', fontWeight: 600 }}>− red</span> lines are removed. Tick what you accept. Anything left
                    unticked is rejected when you approve. Your choices are saved as you go.
                  </HelpBox>
                )}
                {u.proposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} reviewing={reviewing}
                    decision={decisions[p.id] ?? { decision: p.decision, reviewer_note: p.reviewer_note }}
                    onToggle={(on) => void saveDecision(p.id, { decision: on ? 'accepted' : null })}
                    onNote={(note) => void saveDecision(p.id, { reviewer_note: note })} />
                ))}
              </>
            )}

            {u.skipped.length > 0 && (
              <details style={card}>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                  Considered but not proposed · {u.skipped.length}
                </summary>
                <p style={{ margin: '8px 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  What the agent looked at and left out, and why. If something here should be in your context, add it
                  to the notes and analyze again, or edit the note yourself.
                </p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {u.skipped.map((s, i) => <li key={i}><strong>{s.topic}</strong>: <span style={{ color: 'var(--color-text-secondary)' }}>{s.reason}</span></li>)}
                </ul>
              </details>
            )}
          </div>
        </section>
      )}

      {reviewing && (
        <div style={{ position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md, 0 -2px 12px rgba(0,0,0,0.08))' }}>
          {u.proposals.length > 0 && (
            <>
              <span aria-live="polite" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{acceptedCount} of {u.proposals.length} selected</span>
              <Button variant="ghost" size="sm" onClick={() => void selectAll(true)}>Select all</Button>
              <Button variant="ghost" size="sm" onClick={() => void selectAll(false)}>Clear</Button>
            </>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" loading={busy === 'close'} onClick={close}
              title="Finish without changing any context file">
              {u.proposals.length === 0 ? 'Close update' : 'Close without changes'}
            </Button>
            {u.proposals.length > 0 && (
              <Button variant="primary" disabled={acceptedCount === 0} loading={busy === 'approve'}
                title={acceptedCount === 0 ? 'Tick at least one proposal, or close without changes' : 'Lock your selection and get the apply command'}
                onClick={() => run('approve', () => apiPost(`/api/context-updates/${u.id}/approve`), 'Approved. Run the apply command to write the changes.')}>
                Approve {acceptedCount > 0 ? acceptedCount : ''} selected
              </Button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
