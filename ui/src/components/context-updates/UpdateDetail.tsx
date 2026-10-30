import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '@/components/common/Button';
import { Textarea } from '@/components/common/Input';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import OfficeCheckBadge from '@/components/common/OfficeCheckBadge';
import { useApi } from '@/hooks/useApi';
import { useAppDispatch, useDataVersion } from '@/store';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';
import { diffLines, diffStats } from '@/utils/lineDiff';
import { formatRelativeDate } from '@/utils/format';
import { meetingActionDraft } from '@/utils/meetingAction';
import { mergeServerChoices, PendingChoices, shownChoice } from '@/utils/reviewChoices';
import type { ContextUpdate, ContextUpdateProposal, MeetingPerson, MeetingRecord, Stakeholder } from '@/types';
import AnalysisRun from './AnalysisRun';
import DiffView from './DiffView';
import { DropZone, uploadMaterial } from './ImportUpdateModal';
import { CommandBox, HelpBox, OriginBadge, STATUS_META, StatusPill, StepIndicator, copyText, formatBytes, sectionLabel } from './shared';

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
type Confirmations = Record<string, MeetingRecord['confirmation']>;

/** The name as the material writes it; the stakeholder id only says the agent linked it. */
function personLabel(p: MeetingPerson): string {
  if (p.ref === 'me') return p.name && p.name !== 'me' ? `${p.name} (you)` : 'You';
  return p.name || p.ref || '';
}

function RecordList({ label, items }: { label: string; items: React.ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div style={{ ...sectionLabel, marginBottom: 2 }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 2, overflowWrap: 'anywhere' }}>
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  );
}

/** How a person shows: the name, and whether the agent's link to a stakeholder holds. */
function PersonName({ person }: { person: MeetingPerson }) {
  const unknownLink = person.ref && person.ref !== 'me' && person.ref_found === false;
  return (
    <>
      <span title={person.ref && person.ref !== 'me' ? `The agent linked this to ${person.ref}` : person.ref ? undefined : 'Not linked to a stakeholder'}>{personLabel(person)}</span>
      {!person.ref && <span style={{ color: 'var(--color-text-muted)' }}> (not linked)</span>}
      {unknownLink && <span style={{ color: 'var(--color-warning)' }}> (no stakeholder {person.ref})</span>}
    </>
  );
}

function MeetingRecordCard({ record, reviewing, confirmation, onChoose, onCreateTask }: {
  record: MeetingRecord;
  reviewing: boolean;
  confirmation: MeetingRecord['confirmation'];
  onChoose: (value: MeetingRecord['confirmation']) => void;
  /** Set when the record's action items can become tasks: it is confirmed and the update is done. */
  onCreateTask?: (item: number) => void;
}) {
  const confirmed = confirmation === 'confirmed';
  const rejected = confirmation === 'rejected';
  // A record without a unique id cannot be chosen at all; a flawed one can still be rejected.
  const unusableId = record.problems.some((p) => p.includes('valid id') || p.includes('same id'));
  const canConfirm = record.problems.length === 0;
  return (
    <article aria-label={`Meeting record ${record.id || 'without id'}`} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `3px solid ${confirmed ? 'var(--color-success)' : rejected ? 'var(--color-border)' : 'var(--color-border-strong)'}`, opacity: rejected && !reviewing ? 0.7 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>{record.title || 'Meeting'}</span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{record.meeting_date || 'date unknown'}</span>
        {!reviewing && confirmation && (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', fontWeight: 600, color: confirmed ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
            {confirmed ? 'Confirmed' : 'Rejected'}
          </span>
        )}
      </div>
      {record.attendees.length > 0 && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          <span style={{ fontWeight: 600 }}>Attendees: </span>
          {record.attendees.map((p, i) => <span key={i}>{i > 0 && ', '}<PersonName person={p} /></span>)}
        </div>
      )}
      <RecordList label="Decisions" items={record.decisions} />
      <RecordList label="Open questions" items={record.open_questions} />
      <RecordList label="Action items" items={record.action_items.map((a, i) => (
        <>
          {a.description}{a.owner && <span style={{ color: 'var(--color-text-secondary)' }}> · <PersonName person={a.owner} /></span>}{a.due_date && <span style={{ color: 'var(--color-text-secondary)' }}> · by {a.due_date}</span>}
          {a.task_ref && (a.task_found === false
            ? <span style={{ color: 'var(--color-text-muted)' }}> · task {a.task_ref} (no longer exists)</span>
            : <> · <Link to={`/board/task/${a.task_ref}`} style={{ color: 'var(--color-accent)' }}>{a.task_ref}</Link></>)}
          {!a.task_ref && onCreateTask && (
            <button type="button" onClick={() => onCreateTask(i)} aria-label={`Create a task from: ${a.description}`}
              style={{ marginLeft: 8, padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600 }}>
              Create task
            </button>
          )}
        </>
      ))} />
      {record.source && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Source: {record.source}</div>}
      {record.changed_since_confirmed && (
        <HelpBox tone="warning" title="Changed after you confirmed it">
          The record is no longer the one you confirmed. Read it again and confirm or reject it before you approve or close.
        </HelpBox>
      )}
      {record.problems.length > 0 && (
        <HelpBox tone="critical" title="Cannot be confirmed as it is">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{record.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          Ask the agent to fix the record (or analyze again).{!unusableId && ' You can still reject it.'}
        </HelpBox>
      )}
      {reviewing && !unusableId && (
        <div role="group" aria-label={`Review ${record.id}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant={confirmed ? 'primary' : 'secondary'} size="sm" aria-pressed={confirmed} disabled={!canConfirm && !confirmed} onClick={() => onChoose(confirmed ? null : 'confirmed')}>
            {confirmed ? 'Confirmed' : 'Confirm'}
          </Button>
          <Button variant="ghost" size="sm" aria-pressed={rejected} onClick={() => onChoose(rejected ? null : 'rejected')}>
            {rejected ? 'Rejected' : 'Reject'}
          </Button>
        </div>
      )}
    </article>
  );
}

function ProposalCard({ proposal, reviewing, decision, onToggle, onNote }: {
  proposal: ContextUpdateProposal;
  reviewing: boolean;
  decision: Decisions[string];
  onToggle: (accepted: boolean) => void;
  onNote: (note: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(proposal.action !== 'remove');
  const [note, setNote] = useState(decision.reviewer_note);
  useEffect(() => setNote(decision.reviewer_note), [decision.reviewer_note]);

  const accepted = decision.decision === 'accepted';
  const removal = proposal.action === 'remove';
  // A removal shows the current file going away: every line removed.
  const after = removal ? (proposal.current != null ? '' : null) : proposal.proposed ?? null;
  const stats = useMemo(() => (after != null ? diffStats(diffLines(proposal.current ?? null, after)) : null), [proposal.current, after]);
  const ACTION = { create: { label: 'New file', bg: 'var(--color-info-subtle)', fg: 'var(--color-info)' }, update: { label: 'Update', bg: 'var(--color-accent-subtle)', fg: 'var(--color-accent)' }, remove: { label: 'Remove', bg: 'var(--color-critical-subtle)', fg: 'var(--color-critical)' } }[proposal.action];
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
            <span style={{ padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', fontWeight: 600, background: ACTION.bg, color: ACTION.fg }}>
              {ACTION.label}
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
          {proposal.outcome_note && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}><span style={{ fontWeight: 600 }}>{removal ? 'Dashboard: ' : 'Agent: '}</span>{proposal.outcome_note}</div>}

          {proposal.problem && <HelpBox tone="critical">{proposal.problem}</HelpBox>}
          {removal && reviewing && !proposal.problem && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              If you accept, the dashboard moves this file{proposal.target.startsWith('context/') ? ' and its folder' : ''} to the trash
              (<code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>.situation-board/trash/</code>) once the
              update is done. Links to it stop working.
            </div>
          )}
          {proposal.stale && (
            <HelpBox tone="warning" title="This file changed after the analysis">
              {removal
                ? 'Someone edited it since the agent looked. Removing it now would also remove those edits.'
                : proposal.action === 'create' && proposal.target_exists
                ? 'A file now exists at this path. The diff below is against it. If you accept, the agent merges instead of overwriting.'
                : 'Someone edited it since the agent looked. The diff below is against the current version, so it may show more than the proposal meant. If you accept, the agent keeps the newer edits and merges.'}
            </HelpBox>
          )}

          {after != null && (
            <div>
              <button type="button" onClick={() => setShowDiff((v) => !v)} aria-expanded={showDiff}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: 0, marginBottom: 6, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-accent)' }}>
                {removal ? (showDiff ? 'Hide what goes' : 'Show what goes') : showDiff ? 'Hide changes' : 'Show changes'}
                {stats && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    <span style={{ color: 'var(--color-success)' }}>+{stats.added}</span>{' '}
                    <span style={{ color: 'var(--color-critical)' }}>−{stats.removed}</span>
                  </span>
                )}
              </button>
              {showDiff && <DiffView before={proposal.current ?? null} after={after} />}
            </div>
          )}

          {reviewing && accepted && !removal && (
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
  const [confirmations, setConfirmations] = useState<Confirmations>({});
  // Choices still being saved. Finishing the review waits for them, so it always uses the last click.
  const pendingDecisions = useRef(new PendingChoices());
  const pendingRecords = useRef(new PendingChoices());
  const [saving, setSaving] = useState(0);
  const updateSaving = () => setSaving(pendingDecisions.current.size + pendingRecords.current.size);
  const [busy, setBusy] = useState<string | null>(null);
  // The status the user last copied a command for, so the bar can confirm it and say what happens next.
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  // An analysis started from the dashboard is running: the page does not also ask the user to run the command.
  const [running, setRunning] = useState(false);
  const nextRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const prevStatus = useRef<string | null>(null);

  // Right after approving, the apply command is the one step left and it sits at the top of the page,
  // out of sight of the approve bar. Bring it into view and put focus on its Copy button.
  useEffect(() => {
    const status = data?.status ?? null;
    if (prevStatus.current === 'in_review' && status === 'approved') {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      nextRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      copyRef.current?.focus({ preventScroll: true });
    }
    if (prevStatus.current !== status) setCopiedFor(null);
    prevStatus.current = status;
  }, [data?.status]);

  const notify = (type: 'success' | 'error' | 'info', message: string) => dispatch({ type: 'ADD_NOTIFICATION', payload: { type, message } });

  useEffect(() => {
    if (!data) return;
    const serverDecisions: Decisions = Object.fromEntries(data.proposals.map((p) => [p.id, { decision: p.decision, reviewer_note: p.reviewer_note }]));
    const serverConfirmations: Confirmations = Object.fromEntries((data.meeting_records ?? []).map((r) => [r.id, r.confirmation]));
    // A refresh must not undo a click whose save is still on its way.
    setDecisions((local) => mergeServerChoices(local, serverDecisions, pendingDecisions.current.ids()));
    setConfirmations((local) => mergeServerChoices(local, serverConfirmations, pendingRecords.current.ids()));
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
  // Steps where nothing moves until the user runs a command in the agent.
  const command = running ? null : u.status === 'ready' ? `/gtd-context-analyze ${u.id}` : u.status === 'approved' ? `/gtd-context-apply ${u.id}` : null;
  const copied = copiedFor === u.status;
  const selectable = u.proposals.filter((p) => !p.problem);
  const acceptedCount = u.proposals.filter((p) => decisions[p.id]?.decision === 'accepted').length;
  const records = u.meeting_records ?? [];
  const recordChoice = (r: MeetingRecord) => shownChoice(confirmations, r.id, r.confirmation);
  const confirmedCount = records.filter((r) => recordChoice(r) === 'confirmed').length;
  const canApprove = acceptedCount > 0 || confirmedCount > 0;
  // Removals are done by the dashboard on approval and a meeting record needs no file; only creates and
  // updates need the apply command.
  const noFileToWrite = canApprove && u.proposals.every((p) => decisions[p.id]?.decision !== 'accepted' || p.action === 'remove');
  const approveHint = !noFileToWrite ? 'After approving, you copy one command to apply.'
    : acceptedCount > 0 ? 'Approving moves the selected files to the trash right away.'
    : 'Approving keeps the confirmed meeting records and finishes the update.';

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

  /**
   * Saves proposal choices. Only the latest save of each proposal may roll back on failure, and only its
   * own proposal, so an earlier failure never undoes a later click or another proposal.
   */
  const saveDecisions = async (changes: Record<string, Partial<Decisions[string]>>) => {
    const tickets = Object.keys(changes).map((pid) => [pid, pendingDecisions.current.start(pid), decisions[pid]] as const);
    updateSaving();
    setDecisions((d) => {
      const next = { ...d };
      for (const [pid, change] of Object.entries(changes)) next[pid] = { ...next[pid]!, ...change };
      return next;
    });
    try {
      await apiPut(`/api/context-updates/${u.id}/decisions`, { decisions: changes });
    } catch (err) {
      setDecisions((d) => {
        const next = { ...d };
        for (const [pid, ticket, previous] of tickets) if (previous && pendingDecisions.current.isLatest(pid, ticket)) next[pid] = previous;
        return next;
      });
      notify('error', err instanceof Error ? err.message : 'Could not save your choice.');
    } finally {
      for (const [pid, ticket] of tickets) pendingDecisions.current.finish(pid, ticket);
      updateSaving();
    }
  };

  const saveDecision = (pid: string, change: Partial<Decisions[string]>) => saveDecisions({ [pid]: change });

  /** Confirms or rejects one record, naming the revision the user saw, and takes the server's answer. */
  const chooseRecord = async (record: MeetingRecord, value: MeetingRecord['confirmation']) => {
    const rid = record.id;
    const previous = recordChoice(record);
    const ticket = pendingRecords.current.start(rid);
    updateSaving();
    setConfirmations((c) => ({ ...c, [rid]: value }));
    try {
      const saved = await apiPut<ContextUpdate>(`/api/context-updates/${u.id}/meeting-records`, { records: { [rid]: { confirmation: value, revision: record.revision } } });
      const answer = saved.meeting_records.find((r) => r.id === rid);
      if (answer && pendingRecords.current.isLatest(rid, ticket)) setConfirmations((c) => ({ ...c, [rid]: answer.confirmation }));
    } catch (err) {
      if (pendingRecords.current.isLatest(rid, ticket)) setConfirmations((c) => ({ ...c, [rid]: previous }));
      notify('error', err instanceof Error ? err.message : 'Could not save your choice.');
      refetch();
    } finally {
      pendingRecords.current.finish(rid, ticket);
      updateSaving();
    }
  };

  /** Opens the New task form filled in from an action item; the task is linked back to it once saved. */
  const createTask = async (record: MeetingRecord, item: number) => {
    const ownerRef = record.action_items[item]?.owner;
    let owner: Stakeholder | undefined;
    if (ownerRef?.ref && ownerRef.ref !== 'me' && ownerRef.ref_found) {
      owner = await apiGet<Stakeholder>(`/api/stakeholders/${ownerRef.ref}`).catch(() => undefined);
    }
    dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: meetingActionDraft(u, record, item, owner) });
  };

  const selectAll = (accept: boolean) =>
    saveDecisions(Object.fromEntries(selectable.map((p) => [p.id, { decision: accept ? 'accepted' as const : null }])));

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
      : `Add more material? The current proposals${records.length ? ' and meeting records (also confirmed ones)' : ''} are discarded, and the next analysis looks at all material together.`;
    if (window.confirm(msg)) void run('reopen', () => apiPost(`/api/context-updates/${u.id}/reopen`));
  };

  const close = () => {
    const files = u.keep_materials ? 'the materials are kept until you release them' : 'the materials are deleted';
    const kept = confirmedCount > 0 ? ' Confirmed meeting records are kept.' : '';
    if (!window.confirm(`Close this update without changing any context file? The record stays; ${files}.${kept}`)) return;
    void run('close', () => apiPost(`/api/context-updates/${u.id}/close`), 'Closed without changes.');
  };

  const remove = () => {
    const msg = u.status === 'done'
      ? `Delete this record? Context changes it made stay; only the record goes${records.some((r) => r.confirmation === 'confirmed') ? ', including its confirmed meeting records' : ''}.`
      : `Delete this update and its materials${confirmedCount > 0 ? ', including the meeting records you confirmed' : ''}? Nothing in your context has changed yet.`;
    if (!window.confirm(msg)) return;
    void (async () => {
      try { await apiDelete(`/api/context-updates/${u.id}`); notify('success', 'Update deleted.'); onBack(); } catch (err) {
        notify('error', err instanceof Error ? err.message : 'Could not delete.');
      }
    })();
  };

  const keepMaterials = (keep: boolean) => run('keep', () => apiPut(`/api/context-updates/${u.id}/keep-materials`, { keep }));

  const releaseMaterials = () => {
    if (!window.confirm('Delete the kept files of this update? The record stays. This cannot be undone.')) return;
    void run('keep', () => apiPut(`/api/context-updates/${u.id}/keep-materials`, { keep: false }), 'Files released.');
  };

  // A finished update still has its files only when the user kept them; otherwise just the record's list.
  const filesGone = u.status === 'done' && !u.keep_materials;
  const materials: NonNullable<ContextUpdate['material_files']> = filesGone ? u.materials.map((m) => ({ ...m, modified: '' })) : (u.material_files ?? []);
  const keptSize = materials.reduce((sum, f) => sum + f.size, 0);
  const canChooseKeep = ['ready', 'analyzing', 'in_review', 'approved'].includes(u.status);
  const doneNext = u.keep_materials
    ? 'Finished. The record below shows what was proposed and decided. You kept the uploaded materials; release them when you no longer need them.'
    : meta.next;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 980, paddingBottom: reviewing || command ? 80 : 0 }}>
      <div>
        <button type="button" onClick={onBack} style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
          ← All updates
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 700 }}>{u.title}</h2>
          <StatusPill status={u.status} />
          <OriginBadge origin={u.origin} />
          <span style={{ marginLeft: 'auto' }}>
            {u.status !== 'applying' && <Button variant="ghost" size="sm" onClick={remove}>Delete</Button>}
          </span>
        </div>
        <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{u.id}</span> · {u.kind === 'memory-review' ? 'review of your existing memory' : <>material from {u.source_date || 'unknown date'}</>} · {u.origin === 'system-cleanup' ? 'opened by System cleanup' : 'imported'} {formatRelativeDate(u.created_at)}
          {u.applied_at && <> · finished {formatRelativeDate(u.applied_at)}</>}
        </div>
      </div>

      <div style={card}><StepIndicator status={u.status} /></div>

      {/* What to do next: always one clear action. */}
      <section ref={nextRef} aria-label="Next step" style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12, borderColor: meta.color }}>
        <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}><strong>Next: </strong>{u.status === 'done' ? doneNext : meta.next}</div>
        {(u.status === 'ready' || u.status === 'analyzing') && !running && (
          <CommandBox ref={u.status === 'ready' ? copyRef : undefined} command={`/gtd-context-analyze ${u.id}`} emphasis={u.status === 'ready'}
            label={u.status === 'ready' ? 'Your turn: copy this and run it in Claude Code to analyze' : 'Run in Claude Code to analyze'}
            onCopied={() => setCopiedFor(u.status)} />
        )}

        {['ready', 'analyzing', 'in_review'].includes(u.status) && <AnalysisRun updateId={u.id} status={u.status} onChange={refetch} onRunning={setRunning} />}
        {(u.status === 'approved' || u.status === 'applying') && !running && (
          <CommandBox ref={u.status === 'approved' ? copyRef : undefined} command={`/gtd-context-apply ${u.id}`} emphasis={u.status === 'approved'}
            label={u.status === 'approved' ? 'Last step: copy this and run it in Claude Code to apply your accepted changes' : 'Run in Claude Code to apply your accepted changes'}
            onCopied={() => setCopiedFor(u.status)} />
        )}
        {['approved', 'applying', 'done'].includes(u.status) && <AnalysisRun updateId={u.id} status={u.status} onChange={refetch} onRunning={setRunning} />}
        {(u.status === 'analyzing' || u.status === 'applying') && !running && (
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
          {filesGone && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Deleted when the update finished. Only the list is kept.</p>}
          {u.status === 'done' && u.keep_materials && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>Kept at your request · {formatBytes(keptSize)} on disk. Nothing deletes them by age; agents do not read them as task input.</span>
              <Button variant="secondary" size="sm" loading={busy === 'keep'} onClick={releaseMaterials}>Release files</Button>
            </div>
          )}
          {materials.length === 0 && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No files yet.</p>}
          {materials.map((f) => (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)' }}>
              {filesGone
                ? <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-text-secondary)' }}>{f.name}</span>
                : <a href={`/api/context-updates/${u.id}/materials/${f.name.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-accent)' }}>{f.name}</a>}
              {(() => {
                const copy = (u.transcripts ?? []).find((x) => x.file === f.name);
                const problem = (u.transcript_problems ?? []).find((x) => x.source === f.name);
                if (copy) {
                  const outdated = copy.current === false;
                  return (
                    <span title={outdated ? 'The original or this copy was changed after the copy was made; the agent reads the original.' : undefined}
                      style={{ fontSize: 'var(--text-xs)', color: copy.complete && !outdated ? 'var(--color-text-muted)' : 'var(--color-warning)' }}>
                      readable copy of {copy.source}{copy.complete ? '' : ' · incomplete'}{outdated ? ' · outdated' : ''}
                    </span>
                  );
                }
                return problem ? <span title={problem.reason} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-warning)' }}>no readable copy</span> : null;
              })()}
              <OfficeCheckBadge check={f.officeCheck} />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
              {u.status === 'ready' && (
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.name)}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 'var(--text-base)', padding: '0 4px' }}>×</button>
              )}
            </div>
          ))}
          {u.status === 'ready' && <DropZone onFiles={(files) => void addFiles(files)} compact />}
          {canChooseKeep && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--text-sm)', cursor: busy === 'keep' ? 'wait' : 'pointer' }}>
              <input type="checkbox" checked={u.keep_materials} disabled={busy === 'keep'} onChange={(e) => void keepMaterials(e.target.checked)}
                style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0, accentColor: 'var(--color-accent)' }} />
              <span>
                Keep the original files after this update finishes
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  Useful for a recording or deck you may need again. They stay until you release them, and cost disk space, not agent context.
                </span>
              </span>
            </label>
          )}
          {busy === 'upload' && <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Uploading...</span>}
          {(u.status === 'in_review' || u.status === 'approved') && (
            <div><Button variant="ghost" size="sm" disabled={saving > 0} onClick={reopen}>+ Add more material</Button></div>
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

            {records.length > 0 && (
              <section aria-label="Meeting records" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h4 style={{ ...sectionLabel, margin: 0 }}>Meetings · {records.length}</h4>
                {reviewing && (
                  <HelpBox>
                    What each meeting was, as the agent read it. Confirm a record that is right, even when the meeting changes
                    nothing in your context; it stays with this update as the reviewed account. Records you do not confirm are
                    rejected when you approve or close. The transcript itself stays unreviewed material.
                  </HelpBox>
                )}
                {records.map((r, i) => (
                  <MeetingRecordCard key={`${i}-${r.id}`} record={r} reviewing={reviewing} confirmation={recordChoice(r)}
                    onChoose={(value) => void chooseRecord(r, value)}
                    onCreateTask={r.confirmation === 'confirmed' && u.status === 'done' ? (item) => void createTask(r, item) : undefined} />
                ))}
              </section>
            )}

            {u.proposals.length === 0 ? (
              <HelpBox title="Nothing worth changing">
                The agent found nothing in this material that should change your context. That is a normal result: not
                every meeting changes what is true. {reviewing && (records.length > 0 ? 'Confirm the meeting records you want to keep and approve, or close the update.' : 'Close the update to finish.')}
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
          {records.length > 0 && <span aria-live="polite" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{confirmedCount} of {records.length} meetings confirmed</span>}
          {canApprove && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{approveHint}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" loading={busy === 'close'} disabled={saving > 0} onClick={close}
              title="Finish without changing any context file">
              {u.proposals.length === 0 && records.length === 0 ? 'Close update' : 'Close without changes'}
            </Button>
            {(u.proposals.length > 0 || records.length > 0) && (
              <Button variant="primary" disabled={!canApprove || saving > 0} loading={busy === 'approve'}
                title={saving > 0 ? 'Saving your choices...' : !canApprove ? 'Tick at least one proposal or confirm a meeting record, or close without changes' : noFileToWrite ? 'Finish this update now: nothing needs the apply command' : 'Lock your selection and get the apply command'}
                onClick={() => run('approve', () => apiPost(`/api/context-updates/${u.id}/approve`),
                  !noFileToWrite ? 'Approved. Run the apply command to write the changes.' : acceptedCount > 0 ? 'Approved. The files are in the trash.' : 'Approved. The meeting records are kept.')}>
                {acceptedCount > 0 ? `Approve ${acceptedCount} selected` : 'Approve'}
              </Button>
            )}
          </span>
        </div>
      )}

      {/* Waiting on a command: keep the step in view wherever the user has scrolled. */}
      {command && (
        <div role="region" aria-label="Your next step" style={{ position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', background: 'var(--color-surface)', border: '1.5px solid var(--color-accent)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md, 0 -2px 12px rgba(0,0,0,0.08))' }}>
          <span aria-live="polite" style={{ flex: '1 1 260px', minWidth: 0, fontSize: 'var(--text-sm)', lineHeight: 1.45 }}>
            {copied ? (
              <><strong style={{ color: 'var(--color-success)' }}>Copied.</strong> Paste it into Claude Code and press Enter. This page updates by itself when the agent starts.</>
            ) : (
              <><strong>{u.status === 'ready' ? 'Your turn:' : 'Last step:'}</strong> run <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{command.split(' ')[0]}</code> in Claude Code
                {u.status === 'ready' ? ' so the agent can analyze the material.' : ' to write the accepted changes. Nothing changes in your context until you do.'}</>
            )}
          </span>
          <Button variant={copied ? 'secondary' : 'primary'} onClick={() => void copyText(command).then((ok) => { if (ok) setCopiedFor(u.status); })}>
            {copied ? 'Copy again' : 'Copy command'}
          </Button>
        </div>
      )}
    </div>
  );
}
