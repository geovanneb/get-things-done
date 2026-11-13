import { serverText } from '@/i18n/serverText';
import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Link, useNavigate } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import { Textarea } from '@/components/common/Input';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import OfficeCheckBadge from '@/components/common/OfficeCheckBadge';
import { useApi } from '@/hooks/useApi';
import { useAppDispatch, useDataVersion } from '@/store';
import { PageWorkspace, usePageApi } from '@/hooks/usePageApi';
import { diffLines, diffStats } from '@/utils/lineDiff';
import { formatRelativeDate } from '@/utils/format';
import { meetingActionDraft } from '@/utils/meetingAction';
import { doubtLine, doubtsAbout } from '@/utils/recordDoubts';
import { mergeServerChoices, PendingChoices, shownChoice } from '@/utils/reviewChoices';
import type { ContextUpdate, ContextUpdateProposal, FieldChange, MeetingPerson, MeetingRecord, MeetingSpeaker, RecordChange, RecordDoubt, Stakeholder, TranscriptChangeView, TranscriptReview } from '@/types';
import AnalysisRun, { type AnalysisRunHandle, type NextAction } from './AnalysisRun';
import DiffView from './DiffView';
import { DropZone, uploadMaterial } from './ImportUpdateModal';
import { CommandBox, HelpBox, STATUS_META, StatusPill, StepIndicator, TypeBadge, copyText, formatBytes, sectionLabel } from './shared';

const card: React.CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 16,
};

const CONFIDENCE = (): Record<string, { label: string; color: string; hint: string }> => ({
  high: { label: tr('updateDetail.highConfidence'), color: 'var(--color-success)', hint: tr('updateDetail.statedClearlyBySomeoneWho') },
  medium: { label: tr('updateDetail.mediumConfidence'), color: 'var(--color-warning)', hint: tr('updateDetail.likelyRightButCheckThe') },
  low: { label: tr('updateDetail.lowConfidence'), color: 'var(--color-critical)', hint: tr('updateDetail.unconfirmedOrContradictedCheckBefore') },
});

const OUTCOME = (): Record<string, string> => ({
  applied: tr('updateDetail.appliedAsReviewed'),
  merged: tr('updateDetail.appliedMergedWithNewerEdits'),
  failed: tr('updateDetail.couldNotBeApplied'),
  skipped: tr('updateDetail.notApplied'),
});

type Decisions = Record<string, { decision: ContextUpdateProposal['decision']; reviewer_note: string }>;
type Confirmations = Record<string, MeetingRecord['confirmation']>;

/** The name as the material writes it; the stakeholder id only says the agent linked it. */
function personLabel(p: MeetingPerson): string {
  if (p.ref === 'me') return p.name && p.name !== 'me' ? tr('updateDetail.you', { name: p.name }) : tr('updateDetail.you2');
  return p.name || p.ref || '';
}

/** Marks a piece of a record the analysis is not sure of; the reason is in the record's "Not sure" list and the tooltip. */
function NotSure({ doubts }: { doubts: RecordDoubt[] }) {
  const { t } = useLanguage();
  if (doubts.length === 0) return null;
  return <> <span title={doubts.map(doubtLine).join(' ')}><Badge size="sm" variant="warning">{t('updateDetail.notSure')}</Badge></span></>;
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
  const { t } = useLanguage();
  const unknownLink = person.ref && person.ref !== 'me' && person.ref_found === false;
  return (
    <>
      <span title={person.ref && person.ref !== 'me' ? t('updateDetail.theAgentLinkedThisTo', { ref: person.ref }) : person.ref ? undefined : t('updateDetail.notLinkedToAStakeholder')}>{personLabel(person)}</span>
      {!person.ref && <span style={{ color: 'var(--color-text-muted)' }}> {t('updateDetail.notLinked')}</span>}
      {unknownLink && <span style={{ color: 'var(--color-warning)' }}> {rich(t, 'updateDetail.noStakeholder', { ref: person.ref })}</span>}
    </>
  );
}

/** What the box says for a stakeholder: the id tells two people of the same name apart. */
const personOption = (p: Stakeholder) => `${p.name} (${p.id})`;

/** One voice of a meeting: who the agent thinks it is and why. In review the user changes it, or leaves it unknown. */
function SpeakerRow({ speaker, reviewing, people, onSet }: {
  speaker: MeetingSpeaker;
  reviewing: boolean;
  people: Stakeholder[];
  onSet: (person: { ref?: string; name: string } | null) => void;
}) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const change = useRef<HTMLButtonElement>(null);
  const close = () => { setEditing(false); setTimeout(() => change.current?.focus(), 0); };
  const save = () => {
    // Only what was picked from the list is a link; a name typed by hand stays a name.
    const known = people.find((p) => personOption(p) === name.trim());
    if (name.trim()) onSet(known ? { ref: known.id, name: known.name } : { name: name.trim() });
    close();
  };
  const who = t('updateDetail.of', { label: speaker.label, source: speaker.source });
  const link = { padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'var(--text-xs)', marginLeft: 8 } as const;
  return (
    <li>
      {speaker.label}: {speaker.person ? <PersonName person={speaker.person} /> : <span style={{ color: 'var(--color-text-muted)' }}>{t('updateDetail.unknown')}</span>}
      {speaker.reason && <span style={{ color: 'var(--color-text-muted)' }}> · {speaker.reason}</span>}
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}> · {speaker.source}</span>
      {reviewing && !editing && <button ref={change} type="button" style={link} onClick={() => { setName(''); setEditing(true); }} aria-label={t('updateDetail.change', { who })}>{t('change')}</button>}
      {reviewing && !editing && speaker.person && <button type="button" style={link} onClick={() => onSet(null)} aria-label={t('updateDetail.leaveUnknown', { who })}>{t('updateDetail.leaveUnknown2')}</button>}
      {editing && (
        <span style={{ marginLeft: 8 }}>
          <input aria-label={t('updateDetail.whoIs', { who })} list="speaker-people" value={name} autoFocus onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); }}
            style={{ padding: '2px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }} />
          <button type="button" style={link} onClick={save}>{t('updateDetail.save')}</button>
          <button type="button" style={link} onClick={close}>{t('cancel')}</button>
        </span>
      )}
    </li>
  );
}

/** The voices of one meeting. The stakeholders to choose from load only where there are voices to name. */
function SpeakerList({ speakers, title, reviewing, onSet }: {
  speakers: MeetingSpeaker[];
  title: string;
  reviewing: boolean;
  onSet: (speaker: MeetingSpeaker, person: { ref?: string; name: string } | null) => void;
}) {
  const version = useDataVersion('stakeholders');
  const { data } = useApi<Stakeholder[]>('/api/stakeholders', [version], useContext(PageWorkspace));
  const people = data ?? [];
  return (
    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <datalist id="speaker-people">{people.map((p) => <option key={p.id} value={personOption(p)} />)}</datalist>
      <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
        {speakers.map((s) => <SpeakerRow key={`${s.source}/${s.label}`} speaker={s} reviewing={reviewing} people={people} onSet={(person) => onSet(s, person)} />)}
      </ul>
    </div>
  );
}

export function MeetingRecordCard({ record, reviewing, confirmation, onChoose, onCreateTask, onSpeaker }: {
  record: MeetingRecord;
  reviewing: boolean;
  confirmation: MeetingRecord['confirmation'];
  onChoose: (value: MeetingRecord['confirmation']) => void;
  /** Set when the record's action items can become tasks: it is confirmed and the update is done. */
  onCreateTask?: (item: number) => void;
  onSpeaker: (speaker: MeetingSpeaker, person: { ref?: string; name: string } | null) => void;
}) {
  const { t } = useLanguage();
  const confirmed = confirmation === 'confirmed';
  const rejected = confirmation === 'rejected';
  // A record without a unique id cannot be chosen at all; a flawed one can still be rejected.
  const unusableId = record.problems.some((p) => p.includes('valid id') || p.includes('same id'));
  const canConfirm = record.problems.length === 0;
  return (
    <article aria-label={t('updateDetail.meetingRecord', { id: record.id || t('updateDetail.withoutId') })} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `3px solid ${confirmed ? 'var(--color-success)' : rejected ? 'var(--color-border)' : 'var(--color-border-strong)'}`, opacity: rejected && !reviewing ? 0.7 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>{record.title || t('importUpdateModal.meeting')}</span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{record.meeting_date || t('updateDetail.dateUnknown')}</span>
        {!reviewing && confirmation && (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', fontWeight: 600, color: confirmed ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
            {confirmed ? t('updateDetail.confirmed') : t('updateDetail.rejected')}
          </span>
        )}
      </div>
      {record.attendees.length > 0 && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          <span style={{ fontWeight: 600 }}>{t('updateDetail.attendees')} </span>
          {record.attendees.map((p, i) => <span key={i}>{i > 0 && ', '}<PersonName person={p} /><NotSure doubts={doubtsAbout(record.unsure, 'attendees', p.name)} /></span>)}
        </div>
      )}
      {record.speakers.length > 0 && (
        <SpeakerList speakers={record.speakers} title={t('updateDetail.speakers', { value: confirmed ? '' : ' (proposed, until you confirm this record)' })} reviewing={reviewing} onSet={onSpeaker} />
      )}
      <RecordList label={t('updateDetail.decisions')} items={record.decisions.map((d) => <>{d}<NotSure doubts={doubtsAbout(record.unsure, 'decisions', d)} /></>)} />
      <RecordList label={t('updateDetail.openQuestions')} items={record.open_questions.map((q) => <>{q}<NotSure doubts={doubtsAbout(record.unsure, 'open_questions', q)} /></>)} />
      <RecordList label={t('updateDetail.actionItems')} items={record.action_items.map((a, i) => (
        <>
          {a.description}{a.owner && <span style={{ color: 'var(--color-text-secondary)' }}> · <PersonName person={a.owner} /></span>}{a.due_date && <span style={{ color: 'var(--color-text-secondary)' }}> {rich(t, 'updateDetail.by', { due_date: a.due_date })}</span>}
          <NotSure doubts={doubtsAbout(record.unsure, 'action_items', [a.description, a.owner?.name ?? '', a.due_date].join(' '))} />
          {a.task_ref && (a.task_found === false
            ? <span style={{ color: 'var(--color-text-muted)' }}> {rich(t, 'updateDetail.taskNoLongerExists', { task_ref: a.task_ref })}</span>
            : <> · <Link to={`/board/task/${a.task_ref}`} style={{ color: 'var(--color-accent)' }}>{a.task_ref}</Link></>)}
          {!a.task_ref && onCreateTask && (
            <button type="button" onClick={() => onCreateTask(i)} aria-label={t('updateDetail.createATaskFrom', { description: a.description })}
              style={{ marginLeft: 8, padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600 }}>
              {t('newTaskModal.createTask')}
            </button>
          )}
        </>
      ))} />
      {(record.unsure?.length ?? 0) > 0 && (
        <HelpBox tone="warning" title={t('updateDetail.notSureCheckTheseBefore')}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{record.unsure!.map((d, i) => <li key={i}>{doubtLine(d)}</li>)}</ul>
          {t('updateDetail.theRecordSaysWhatThe')}
        </HelpBox>
      )}
      {record.source && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{rich(t, 'updateDetail.source', { source: record.source })}</div>}
      {record.changed_since_confirmed && (
        <HelpBox tone="warning" title={t('updateDetail.changedAfterYouConfirmedIt')}>
          {t('updateDetail.theRecordIsNoLonger')}
        </HelpBox>
      )}
      {record.problems.length > 0 && (
        <HelpBox tone="critical" title={t('updateDetail.cannotBeConfirmedAsIt')}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{record.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          {t('updateDetail.askTheAgentToFix')}{!unusableId && t('updateDetail.youCanStillRejectIt')}
        </HelpBox>
      )}
      {reviewing && !unusableId && (
        <div role="group" aria-label={t('updateDetail.review', { id: record.id })} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant={confirmed ? 'primary' : 'secondary'} size="sm" aria-pressed={confirmed} disabled={!canConfirm && !confirmed} onClick={() => onChoose(confirmed ? null : 'confirmed')}>
            {confirmed ? t('updateDetail.confirmed') : t('confirm')}
          </Button>
          <Button variant="ghost" size="sm" aria-pressed={rejected} onClick={() => onChoose(rejected ? null : 'rejected')}>
            {rejected ? t('updateDetail.rejected') : t('updateDetail.reject')}
          </Button>
        </div>
      )}
    </article>
  );
}

const FIELD_LABELS = (): Record<RecordDoubt['field'], string> => ({
  title: tr('importUpdateModal.title'), meeting_date: tr('updateDetail.date'), attendees: tr('updateDetail.attendees2'), speakers: tr('updateDetail.speakers2'), decisions: tr('updateDetail.decisions'), open_questions: tr('updateDetail.openQuestions'), action_items: tr('updateDetail.actionItems'),
});

/** One side of a changed field: its lines, the ones not on the other side marked, in words as well as colour. */
function ChangeSide({ label, lines, other, tone }: { label: string; lines: string[]; other: string[]; tone: 'before' | 'after' }) {
  const { t } = useLanguage();
  const color = tone === 'before' ? 'var(--color-critical)' : 'var(--color-success)';
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 2 }}>{label}</div>
      {lines.length === 0 || (lines.length === 1 && !lines[0]) ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('updateDetail.empty')}</div> : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {lines.map((line, i) => {
            // Same number of lines: compared place by place, so a reorder still shows. Otherwise by occurrence: the
            // second of two equal lines is changed when the other side has only one.
            const occurrence = lines.slice(0, i).filter((l) => l === line).length;
            const changed = lines.length === other.length ? other[i] !== line : occurrence >= other.filter((l) => l === line).length;
            return (
              <li key={i} style={{ overflowWrap: 'anywhere', ...(changed ? { color, fontWeight: 600 } : { color: 'var(--color-text-secondary)' }) }}>
                {line || '(empty)'}{changed && <span className="sr-only">{tone === 'before' ? ' (changed or removed)' : ' (changed or added)'}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One line of a turn, the changed words marked: struck out before, underlined after. */
function WordLine({ line, words, tone }: { line: string; words: string; tone: 'before' | 'after' }) {
  const { t } = useLanguage();
  const at = line.indexOf(words);
  const color = tone === 'before' ? 'var(--color-critical)' : 'var(--color-success)';
  const Mark = tone === 'before' ? 'del' : 'ins';
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 2 }}>{tone === 'before' ? t('updateDetail.before') : t('updateDetail.after')}</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>
        {at < 0 ? line : <>{line.slice(0, at)}<Mark style={{ color, fontWeight: 600 }}>{words}</Mark>{line.slice(at + words.length)}</>}
      </div>
    </div>
  );
}

/**
 * The transcript side of a correction: each word change on its turn, before and after. Sure ones and the suggestions
 * used are what approving writes, as a new version of the meeting's text; the others are offered, or say why not.
 */
function TranscriptSection({ review, open, onUse, busy }: { review: TranscriptReview; open: boolean; onUse?: (index: number, use: boolean) => void; busy: boolean }) {
  const { t } = useLanguage();
  const where = (c: TranscriptChangeView) => [c.file, `#${c.turn}`, c.time, c.speaker].filter(Boolean).join(' · ');
  // The server's reasons are phrased to follow a label ("Transcript change 2: it touches…"); shown alone, as a sentence.
  const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  const item = (i: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap: 4, ...(i > 0 ? { paddingTop: 10, borderTop: '1px dashed var(--color-border)' } : {}) });
  const counted = review.changes.filter((c) => c.sure || c.used);
  const offered = review.changes.filter((c) => !c.sure && !c.used);
  const lines = (c: TranscriptChangeView) => c.line_before === null || c.line_after === null
    ? <div style={{ fontSize: 'var(--text-sm)' }}>{rich(t, 'updateDetail.to', { before: c.before, after: c.after })}</div>
    : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <WordLine line={c.line_before} words={c.before} tone="before" />
        <WordLine line={c.line_after} words={c.after} tone="after" />
      </div>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid var(--color-border)' }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
        {rich(t, 'updateDetail.transcript', { value: review.made ? t('updateDetail.newVersionFrom', { to: review.made.to, from: review.made.from }) : review.base ? t('updateDetail.on', { base: review.base }) : '' })}
      </div>
      {open && review.problem && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-warning)' }}>{review.problem}</div>}
      {counted.length === 0 && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{open ? t('updateDetail.noWordsChangeYetThe') : t('updateDetail.noWordsChanged')}</div>
      )}
      {counted.map((c, i) => (
        <div key={c.index} style={item(i)}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}>{where(c)}</div>
          {lines(c)}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span><strong>{c.used ? t('updateDetail.usedByYou') : t('updateDetail.why')}</strong> {c.reason}</span>
            {c.used && onUse && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onUse(c.index, false)} aria-label={t('updateDetail.undoTranscriptTurnTo', { turn: c.turn, before: c.before, after: c.after })}>{t('updateDetail.undo')}</Button>}
          </div>
          {open && c.problem && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)' }}>{sentence(c.problem)}</div>}
        </div>
      ))}
      {open && offered.length > 0 && (
        <HelpBox tone="warning" title={t('updateDetail.notSureSuggestedNotApplied')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {offered.map((c, i) => (
              <div key={c.index} style={item(i)}>
                <div style={{ fontSize: 'var(--text-xs)', overflowWrap: 'anywhere' }}>{where(c)}</div>
                {lines(c)}
                <div style={{ fontSize: 'var(--text-xs)' }}>{c.reason}</div>
                {onUse && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="secondary" disabled={busy || Boolean(c.problem)} onClick={() => onUse(c.index, true)}
                      aria-label={t('updateDetail.useSuggestionTranscriptTurnTo', { turn: c.turn, before: c.before, after: c.after })}>{t('updateDetail.useSuggestion')}</Button>
                    {c.problem && <span style={{ fontSize: 'var(--text-xs)' }}>{sentence(c.problem)}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
          {onUse ? t('updateDetail.usingASuggestionUpdatesThis') : t('updateDetail.theseAreNotAppliedCheck')}
        </HelpBox>
      )}
      {open && counted.length > 0 && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {t('updateDetail.approvingWritesTheseAsA')}
        </div>
      )}
    </div>
  );
}

/**
 * A correction, as the executive judges it: each field the server found changed, before and after, with the agent's
 * reason. Changes the agent was not sure of are listed apart: the record keeps the old value for those.
 */
function CorrectionCard({ review, explanations, open, rejected, onUse, onUseWords, busy = false }: {
  review: NonNullable<ContextUpdate['correction_review']>; explanations: RecordChange[]; open: boolean; rejected: boolean;
  /** Set while the correction is in review: use a suggestion (by its place among the explanations), or take it back. */
  onUse?: (index: number, use: boolean) => void;
  /** The same for a transcript suggestion, by its place in the record's transcript changes. */
  onUseWords?: (index: number, use: boolean) => void;
  busy?: boolean;
}) {
  const { t } = useLanguage();
  const words = review.transcript ?? null;
  const wordsCount = Boolean(words?.changes.some((c) => c.sure || c.used));
  const sure = explanations.filter((c) => c.sure);
  // Each with its place among the explanations: what the server knows it by.
  const used = explanations.map((c, index) => ({ c, index })).filter((x) => !x.c.sure && x.c.taken);
  const suggestions = explanations.map((c, index) => ({ c, index })).filter((x) => !x.c.sure && !x.c.taken);
  const stateOf = (index: number) => review.suggestions.find((s) => s.index === index);
  return (
    <section aria-label={t('updateDetail.whatTheCorrectionChanges')} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h4 style={{ ...sectionLabel, margin: 0 }}>{open ? t('updateDetail.whatThisCorrectionChanges') : rejected ? t('updateDetail.whatThisCorrectionSuggestedRejected') : t('updateDetail.whatThisCorrectionChanged')}</h4>
      {open && review.finishing && (
        <HelpBox tone="warning" title={t('updateDetail.finishingWasInterrupted')}>
          {t('updateDetail.theNewVersionOfThe')}
        </HelpBox>
      )}
      {open && review.blocked.length > 0 && (
        <HelpBox tone="critical" title={review.stale ? t('updateDetail.anotherCorrectionOfThisMeeting') : t('updateDetail.thisCorrectionCannotBeApproved')}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{review.blocked.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </HelpBox>
      )}
      {!review.base && (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {t('updateDetail.theVersionThisCorrectedIs')}
        </p>
      )}
      {review.base && review.changes.length === 0 && !wordsCount && (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {!open ? t('updateDetail.nothingChanged') : suggestions.length || words?.changes.length ? t('updateDetail.noChangesAppliedYetThe') : t('updateDetail.nothingTheAgentFoundNothing')}
        </p>
      )}
      {review.changes.map((c: FieldChange) => {
        const why = sure.filter((x) => x.field === c.field);
        const chosen = used.filter((x) => x.c.field === c.field);
        return (
          <div key={c.field} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{FIELD_LABELS()[c.field]}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <ChangeSide label={t('updateDetail.before')} lines={c.before} other={c.after} tone="before" />
              <ChangeSide label={t('updateDetail.after')} lines={c.after} other={c.before} tone="after" />
            </div>
            {why.length + chosen.length > 0
              ? (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                  {why.map((x, i) => <li key={`w${i}`}><strong>{t('updateDetail.why')}</strong> {x.reason}</li>)}
                  {chosen.map((x) => <li key={`c${x.index}`}>{rich(t, 'updateDetail.to2', { strong: <strong>{t('updateDetail.selectedByYou')}</strong>, before: x.c.before, after: x.c.after, reason: x.c.reason })}</li>)}
                </ul>
              )
              : <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-warning)' }}>{t('updateDetail.theAgentDidNotExplain')}</div>}
          </div>
        );
      })}
      {review.doubts_dropped.length > 0 && (
        <HelpBox tone="warning" title={t('updateDetail.noLongerMarkedNotSure')}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{review.doubts_dropped.map((d, i) => <li key={i}>{doubtLine(d)}</li>)}</ul>
          {t('updateDetail.theVersionBeforeHadThese')}
        </HelpBox>
      )}
      {used.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{t('updateDetail.usedByYou2')}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {used.map(({ c, index }) => (
              <li key={index}>
                {FIELD_LABELS()[c.field] ?? c.field}: "{c.before}{t('updateDetail.to3')}{c.after}".{' '}
                {onUse && <Button size="sm" variant="secondary" disabled={busy || Boolean(stateOf(index)?.blocked)} onClick={() => onUse(index, false)} aria-label={t('updateDetail.undoTo', { value: FIELD_LABELS()[c.field] ?? c.field, before: c.before, after: c.after })}>{t('updateDetail.undo')}</Button>}
                {onUse && stateOf(index)?.blocked && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}> {stateOf(index)!.blocked}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {suggestions.length > 0 && (
        <HelpBox tone="warning" title={t('updateDetail.notSureSuggestedNotApplied')}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {suggestions.map(({ c, index }) => {
              const state = stateOf(index);
              return (
                <li key={index}>
                  {FIELD_LABELS()[c.field] ?? c.field}: "{c.before}{t('updateDetail.mayBe')}{c.after}". {c.reason}
                  {onUse && state && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                      <Button size="sm" variant="secondary" disabled={busy || Boolean(state.blocked)} onClick={() => onUse(index, true)}
                        aria-label={t('updateDetail.useSuggestionTo', { value: FIELD_LABELS()[c.field] ?? c.field, before: c.before, after: c.after })}>{t('updateDetail.useSuggestion')}</Button>
                      {state.blocked
                        ? <span style={{ fontSize: 'var(--text-xs)' }}>{state.blocked}</span>
                        : state.unlinks && <span style={{ fontSize: 'var(--text-xs)' }}>{rich(t, 'updateDetail.theStakeholderLinkOfIs', { before: c.before })}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {onUse
            ? t('updateDetail.usingASuggestionUpdatesThis2')
            : t('updateDetail.theRecordKeepsTheCurrent', { value: open ? t('updateDetail.andApprovingDoesNotChange') : '' })}
        </HelpBox>
      )}
      {words && !(rejected && !open) && <TranscriptSection review={words} open={open} busy={busy} {...(onUseWords ? { onUse: onUseWords } : {})} />}
    </section>
  );
}

/**
 * Why a Kaizen was opened, shown before the file changes: the executive judges the diagnosis first, then whether
 * each change fixes it.
 */
function KaizenCard({ kaizen }: { kaizen: NonNullable<ContextUpdate['kaizen']> }) {
  const { t } = useLanguage();
  return (
    <section aria-label={t('updateDetail.rootCause')}>
      <h3 style={sectionLabel}>{t('updateDetail.whyThisKaizen')}</h3>
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10, borderLeft: '3px solid var(--color-accent)' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {kaizen.task_ref
            ? <span>{rich(t, 'updateDetail.afterFeedbackOn', { link: <Link to={`/board/task/${kaizen.task_ref}`} style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}>{kaizen.task_ref}</Link> })}</span>
            : <span>{t('updateDetail.theNoteDoesNotName')}</span>}
          {kaizen.area && <Badge variant="default">{kaizen.area}</Badge>}
        </div>
        {kaizen.symptom && (
          <div>
            <div style={{ ...sectionLabel, marginBottom: 2 }}>{t('updateDetail.whatWentWrong')}</div>
            <MarkdownView content={kaizen.symptom} compact />
          </div>
        )}
        <div>
          <div style={{ ...sectionLabel, marginBottom: 2 }}>{t('updateDetail.rootCause')}</div>
          {kaizen.root_cause
            ? <MarkdownView content={kaizen.root_cause} compact />
            : <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-warning)' }}>{t('updateDetail.theNoteGivesNoRoot')}</p>}
        </div>
      </div>
    </section>
  );
}

function ProposalCard({ proposal, reviewing, decision, onToggle, onNote }: {
  proposal: ContextUpdateProposal;
  reviewing: boolean;
  decision: Decisions[string];
  onToggle: (accepted: boolean) => void;
  onNote: (note: string) => void;
}) {
  const { t } = useLanguage();
  const [showDiff, setShowDiff] = useState(proposal.action !== 'remove');
  const [note, setNote] = useState(decision.reviewer_note);
  useEffect(() => setNote(decision.reviewer_note), [decision.reviewer_note]);

  const accepted = decision.decision === 'accepted';
  const removal = proposal.action === 'remove';
  // A removal shows the current file going away: every line removed.
  const after = removal ? (proposal.current != null ? '' : null) : proposal.proposed ?? null;
  const stats = useMemo(() => (after != null ? diffStats(diffLines(proposal.current ?? null, after)) : null), [proposal.current, after]);
  const ACTION = { create: { label: t('updateDetail.newFile'), bg: 'var(--color-info-subtle)', fg: 'var(--color-info)' }, update: { label: t('updateDetail.update'), bg: 'var(--color-accent-subtle)', fg: 'var(--color-accent)' }, remove: { label: t('remove'), bg: 'var(--color-critical-subtle)', fg: 'var(--color-critical)' } }[proposal.action];
  const confidence = CONFIDENCE()[proposal.confidence];
  const blocked = !!proposal.problem;
  const checkboxId = `accept-${proposal.id}`;

  return (
    <article style={{ ...card, padding: 0, borderLeft: `3px solid ${reviewing ? (accepted ? 'var(--color-success)' : 'var(--color-border-strong)') : decision.decision === 'accepted' ? 'var(--color-success)' : 'var(--color-border)'}` }}>
      <div style={{ display: 'flex', gap: 12, padding: '14px 16px', alignItems: 'flex-start' }}>
        {reviewing && (
          <input id={checkboxId} type="checkbox" checked={accepted} disabled={blocked && !accepted}
            onChange={(e) => onToggle(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0, cursor: blocked && !accepted ? 'not-allowed' : 'pointer', accentColor: 'var(--color-success)' }} />
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
                {decision.decision === 'accepted' ? t('updateDetail.accepted') : t('updateDetail.rejected')}{proposal.outcome ? ` · ${OUTCOME()[proposal.outcome] ?? proposal.outcome}` : ''}
              </span>
            )}
          </div>
          <code style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{proposal.target}</code>
          {proposal.app_provided && reviewing && !blocked && (
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              {rich(t, 'updateDetail.thisFileCameWithThe', { code: <code style={{ fontFamily: 'var(--font-mono)' }}>gtd upgrade</code>, code2: <code style={{ fontFamily: 'var(--font-mono)' }}>{proposal.target.split('/').pop()}.new</code> })}
            </p>
          )}

          {proposal.rationale && (
            <div>
              <div style={{ ...sectionLabel, marginBottom: 2 }}>{t('updateDetail.why2')}</div>
              <MarkdownView content={proposal.rationale} compact />
            </div>
          )}
          {proposal.evidence && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              <span style={{ fontWeight: 600 }}>{t('updateDetail.evidence')} </span>{proposal.evidence}
            </div>
          )}
          {proposal.outcome_note && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}><span style={{ fontWeight: 600 }}>{removal ? t('updateDetail.dashboard') : t('updateDetail.agent')}</span>{proposal.outcome_note}</div>}

          {proposal.problem && <HelpBox tone="critical">{serverText(proposal.problem)}</HelpBox>}
          {removal && reviewing && !proposal.problem && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              {rich(t, 'updateDetail.ifYouAcceptTheDashboard', { value: proposal.target.startsWith('context/') ? t('updateDetail.andItsFolder') : '', code: <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>.situation-board/trash/</code> })}
            </div>
          )}
          {proposal.stale && (
            <HelpBox tone="warning" title={t('updateDetail.thisFileChangedAfterThe')}>
              {removal
                ? t('updateDetail.someoneEditedItSinceThe')
                : proposal.action === 'create' && proposal.target_exists
                ? t('updateDetail.aFileNowExistsAt')
                : t('updateDetail.someoneEditedItSinceThe2')}
            </HelpBox>
          )}

          {after != null && (
            <div>
              <button type="button" onClick={() => setShowDiff((v) => !v)} aria-expanded={showDiff}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: 0, marginBottom: 6, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-accent)' }}>
                {removal ? (showDiff ? t('updateDetail.hideWhatGoes') : t('updateDetail.showWhatGoes')) : showDiff ? t('updateDetail.hideChanges') : t('updateDetail.showChanges')}
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
                {t('updateDetail.noteForTheAgentOptional')}
              </div>
              <p style={{ margin: '0 0 4px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                {t('updateDetail.almostRightSayWhatTo')}
              </p>
              <div onBlur={() => { if (note !== decision.reviewer_note) onNote(note); }}>
                <Textarea value={note} onChange={setNote} rows={2} aria-label={t('updateDetail.noteFor', { id: proposal.id })} />
              </div>
            </div>
          )}
          {!reviewing && decision.reviewer_note && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}><span style={{ fontWeight: 600 }}>{t('updateDetail.yourNote')} </span>{decision.reviewer_note}</div>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * `workspace`: when set (opened from a run-finished notice), every request of the page and its children says it is about
 * that workspace, and the server refuses it when another one is open: a switch in another tab never shows or changes
 * another workspace's update with this id (#246 follow-up).
 */
export default function UpdateDetail({ id, onBack, workspace }: { id: string; onBack: () => void; workspace?: string }) {
  return (
    <PageWorkspace.Provider value={workspace}>
      <UpdateDetailPage id={id} onBack={onBack} />
    </PageWorkspace.Provider>
  );
}

function UpdateDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, locale } = useLanguage();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const version = useDataVersion('context-updates');
  const api = usePageApi();
  const { data, loading, error, refetch } = useApi<ContextUpdate>(`/api/context-updates/${id}`, [version], api.workspace);
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
  const nextRef = useRef<HTMLElement | null>(null);
  // The Next box itself, watched for being on screen (a callback ref: the box can be replaced, e.g. after an error).
  const [nextBox, setNextBox] = useState<HTMLElement | null>(null);
  const runRef = useRef<AnalysisRunHandle>(null);
  // The next step as the box offers it: the sticky bar repeats exactly that (Run, Copy), or nothing while checking.
  const [nextAction, setNextAction] = useState<NextAction>('none');
  // The Next box is on screen: the sticky bar shows only when it is scrolled away, never a second primary next to it.
  const [nextInView, setNextInView] = useState(true);
  // Focus to move to the next step's main action once it is there (it appears after its checks answer).
  const focusPending = useRef(false);
  const prevStatus = useRef<string | null>(null);

  // Right after approving, applying is the one step left and it sits at the top of the page, out of sight of the
  // approve bar. Bring it into view and put focus on its main action (Apply, or Copy when the dashboard cannot run it).
  useEffect(() => {
    const status = data?.status ?? null;
    if (prevStatus.current === 'in_review' && status === 'approved') {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      nextRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      // Once the step's main action is there (see below): it appears after the new panel's checks answer.
      focusPending.current = true;
    }
    if (prevStatus.current !== status) setCopiedFor(null);
    prevStatus.current = status;
  }, [data?.status]);

  // Another update: no focus left to move.
  useEffect(() => { focusPending.current = false; }, [data?.id]);
  useEffect(() => {
    if (!focusPending.current || (nextAction !== 'run' && nextAction !== 'copy')) return;
    focusPending.current = false;
    const frame = requestAnimationFrame(() => nextRef.current?.querySelector<HTMLElement>('[data-next-action]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [nextAction]);

  useEffect(() => {
    setNextInView(true);
    if (!nextBox || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([entry]) => setNextInView(Boolean(entry?.isIntersecting)), { threshold: 0.1 });
    watch.observe(nextBox);
    return () => watch.disconnect();
  }, [nextBox]);

  /** A start from the sticky bar failed: the box, with its message, comes into view. */
  const showNextBox = () => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    nextRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  };

  const notify = (type: 'success' | 'error' | 'info', message: string) => dispatch({ type: 'ADD_NOTIFICATION', payload: { type, message } });
  // The sidebar dot and "Waiting on you" count the same updates: tell them too, not only this page (#201).
  const changed = () => dispatch({ type: 'DATA_CHANGED', payload: 'context-updates' });

  useEffect(() => {
    if (!data) return;
    const serverDecisions: Decisions = Object.fromEntries(data.proposals.map((p) => [p.id, { decision: p.decision, reviewer_note: p.reviewer_note }]));
    const serverConfirmations: Confirmations = Object.fromEntries((data.meeting_records ?? []).map((r) => [r.id, r.confirmation]));
    // A refresh must not undo a click whose save is still on its way.
    setDecisions((local) => mergeServerChoices(local, serverDecisions, pendingDecisions.current.ids()));
    setConfirmations((local) => mergeServerChoices(local, serverConfirmations, pendingRecords.current.ids()));
  }, [data]);

  if (loading) return <LoadingSpinner text={t('updateDetail.loadingUpdate')} />;
  if (error || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600 }}>
        <HelpBox tone="critical">
          {api.workspace && error && /another workspace/.test(error)
            ? <>{rich(t, 'updateDetail.thisUpdateIsInAnother', { workspace: api.workspace })}</>
            : t('updateDetail.thisUpdateCouldNotBe')}
        </HelpBox>
        <div><Button variant="secondary" onClick={onBack}>{t('updateDetail.backToUpdates')}</Button></div>
      </div>
    );
  }

  const u = data;
  const meta = STATUS_META()[u.status];
  const reviewing = u.status === 'in_review';
  // Steps where nothing moves until the user runs a command in the agent.
  // A follow-up whose correction is no longer current is never offered for analysis or apply: it is closed or deleted.
  const command = running || u.follow_up_problem ? null : u.status === 'ready' ? `/gtd-context-analyze ${u.id}` : u.status === 'approved' ? `/gtd-context-apply ${u.id}` : null;
  const copied = copiedFor === u.status;
  const selectable = u.proposals.filter((p) => !p.problem);
  const acceptedCount = u.proposals.filter((p) => decisions[p.id]?.decision === 'accepted').length;
  const records = u.meeting_records ?? [];
  const recordChoice = (r: MeetingRecord) => shownChoice(confirmations, r.id, r.confirmation);
  const confirmedCount = records.filter((r) => recordChoice(r) === 'confirmed').length;
  // A correction the check refuses (stale, its version gone, a record that does not hold) cannot be approved.
  const correctionBlocked = (u.kind === 'meeting-correction' && (u.correction_review?.blocked.length ?? 0) > 0) || Boolean(u.follow_up_problem);
  const canApprove = (acceptedCount > 0 || confirmedCount > 0) && !correctionBlocked;
  // Removals are done by the dashboard on approval and a meeting record needs no file; only creates and
  // updates need the apply command.
  const noFileToWrite = canApprove && u.proposals.every((p) => decisions[p.id]?.decision !== 'accepted' || p.action === 'remove');
  const isCorrection = u.kind === 'meeting-correction';
  const approveHint = isCorrection ? t('updateDetail.approvingMakesTheConfirmedRecord')
    : !noFileToWrite ? t('updateDetail.afterApprovingApplyYourAccepted')
    : acceptedCount > 0 ? t('updateDetail.approvingMovesTheSelectedFiles')
    : t('updateDetail.approvingKeepsTheConfirmedMeeting');

  // A finished correction that is still the meeting's current version: look for its old values in the context.
  const followUp = () => run('follow', async () => {
    const created = await api.post<{ id: string }>(`/api/context-updates/${u.id}/follow-up`);
    navigate(`/context/updates/${created.id}`);
  }, t('updateDetail.followUpOpenedAnalyzeIt'));

  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      await action();
      if (success) notify('success', success);
      changed();
    } catch (err) {
      notify('error', err instanceof Error ? serverText(err.message) : t('updateDetail.somethingWentWrong'));
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
      await api.put(`/api/context-updates/${u.id}/decisions`, { decisions: changes });
    } catch (err) {
      setDecisions((d) => {
        const next = { ...d };
        for (const [pid, ticket, previous] of tickets) if (previous && pendingDecisions.current.isLatest(pid, ticket)) next[pid] = previous;
        return next;
      });
      notify('error', err instanceof Error ? serverText(err.message) : t('updateDetail.couldNotSaveYourChoice'));
    } finally {
      for (const [pid, ticket] of tickets) pendingDecisions.current.finish(pid, ticket);
      updateSaving();
    }
  };

  const saveDecision = (pid: string, change: Partial<Decisions[string]>) => saveDecisions({ [pid]: change });

  /** Confirms or rejects one record, naming the revision the user saw, and takes the server's answer. */
  const setSpeaker = async (record: MeetingRecord, speaker: MeetingSpeaker, person: { ref?: string; name: string } | null) => {
    // Counted with the choices, so nothing finishes the review while this is on its way.
    const ticket = pendingRecords.current.start(record.id);
    updateSaving();
    try {
      await api.put(`/api/context-updates/${u.id}/meeting-records/${record.id}/speaker`, { label: speaker.label, source: speaker.source, person, revision: record.revision });
      setConfirmations((c) => ({ ...c, [record.id]: null }));
      await refetch();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('updateDetail.couldNotChangeTheSpeaker'));
    } finally {
      pendingRecords.current.finish(record.id, ticket);
      updateSaving();
    }
  };

  // A correction's suggestion used or taken back: a change to the record, saved like a speaker, then confirmed again.
  const applySuggestion = async (record: MeetingRecord, index: number, use: boolean, kind: 'suggestions' | 'transcript-suggestions' = 'suggestions') => {
    const ticket = pendingRecords.current.start(record.id);
    updateSaving();
    try {
      await api.post(`/api/context-updates/${u.id}/meeting-records/${record.id}/${kind}/${index}`, { revision: record.revision, use });
      setConfirmations((c) => ({ ...c, [record.id]: null }));
      await refetch();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('updateDetail.couldNotChangeTheRecord'));
      await refetch();
    } finally {
      pendingRecords.current.finish(record.id, ticket);
      updateSaving();
    }
  };

  const chooseRecord = async (record: MeetingRecord, value: MeetingRecord['confirmation']) => {
    const rid = record.id;
    const previous = recordChoice(record);
    const ticket = pendingRecords.current.start(rid);
    updateSaving();
    setConfirmations((c) => ({ ...c, [rid]: value }));
    try {
      const saved = await api.put<ContextUpdate>(`/api/context-updates/${u.id}/meeting-records`, { records: { [rid]: { confirmation: value, revision: record.revision } } });
      const answer = saved.meeting_records.find((r) => r.id === rid);
      if (answer && pendingRecords.current.isLatest(rid, ticket)) setConfirmations((c) => ({ ...c, [rid]: answer.confirmation }));
    } catch (err) {
      if (pendingRecords.current.isLatest(rid, ticket)) setConfirmations((c) => ({ ...c, [rid]: previous }));
      notify('error', err instanceof Error ? serverText(err.message) : t('updateDetail.couldNotSaveYourChoice'));
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
      owner = await api.get<Stakeholder>(`/api/stakeholders/${ownerRef.ref}`).catch(() => undefined);
    }
    dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: meetingActionDraft(u, record, item, owner) });
  };

  const selectAll = (accept: boolean) =>
    saveDecisions(Object.fromEntries(selectable.map((p) => [p.id, { decision: accept ? 'accepted' as const : null }])));

  const addFiles = (files: File[]) => run('upload', async () => {
    const errors: string[] = [];
    for (const f of files) { const e = await uploadMaterial(u.id, f, api.workspace); if (e) errors.push(e); }
    if (errors.length) throw new Error(errors.join('; '));
  });

  const removeFile = async (name: string) => {
    if (!(await confirm({ title: t('updateDetail.removeFromThisUpdate', { name }), message: t('updateDetail.theFileIsDeletedFrom'), confirmLabel: t('removeFile'), tone: 'danger' }))) return;
    void run('remove', () => api.del(`/api/context-updates/${u.id}/materials/${encodeURIComponent(name)}`));
  };

  const reopen = async () => {
    const msg = u.status === 'analyzing'
      ? t('updateDetail.stopWaitingForTheAgent')
      : t('updateDetail.addMoreMaterialTheCurrent', { value: records.length ? t('updateDetail.andMeetingRecordsAlsoConfirmed') : '' });
    if (await confirm({ title: u.status === 'analyzing' ? t('updateDetail.stopWaitingForTheAgent2') : t('updateDetail.addMoreMaterial'), message: msg, confirmLabel: u.status === 'analyzing' ? t('updateDetail.stopWaiting') : t('updateDetail.addMaterial') })) void run('reopen', () => api.post(`/api/context-updates/${u.id}/reopen`));
  };

  const close = async () => {
    const files = u.keep_materials ? t('updateDetail.theMaterialsAreKeptUntil') : t('updateDetail.theMaterialsAreDeleted');
    const kept = confirmedCount > 0 ? t('updateDetail.confirmedMeetingRecordsAreKept') : '';
    if (!(await confirm({ title: t('updateDetail.closeWithoutChanges'), message: t('updateDetail.noContextFileIsChanged', { files, kept }), confirmLabel: t('updateDetail.closeWithoutChanges2') }))) return;
    void run('close', () => api.post(`/api/context-updates/${u.id}/close`), t('updateDetail.closedWithoutChanges'));
  };

  const remove = async () => {
    const msg = u.status === 'done'
      ? t('updateDetail.deleteThisRecordContextChanges', { value: records.some((r) => r.confirmation === 'confirmed') ? t('updateDetail.includingItsConfirmedMeetingRecords') : '' })
      : t('updateDetail.deleteThisUpdateAndIts', { value: confirmedCount > 0 ? t('updateDetail.includingTheMeetingRecordsYou') : '' });
    // A digest's meetings left the queue when it was made, so its folder (or, once done, their own folders, which go
    // with it) is their only copy.
    const meetings = u.digest_meetings?.length ?? 0;
    const onlyCopy = u.origin === 'meetings' && meetings > 0 && (u.status !== 'done' || u.keep_materials || u.meeting_folders)
      ? t('updateDetail.theQueueSoThisIs', { value: meetings === 1 ? t('updateDetail.itsMeetingAlreadyLeft') : t('updateDetail.itsMeetingsAlreadyLeft', { meetings }) })
      : '';
    if (!(await confirm({ title: u.status === 'done' ? t('updateDetail.deleteThisRecord') : t('updateDetail.deleteThisUpdate'), message: t('updateDetail.theUpdateSFolderTo', { msg, onlyCopy, value: u.meeting_folders ? t('updateDetail.andItsMeetingsFoldersGo') : ' goes' }), confirmLabel: u.status === 'done' ? t('updateDetail.deleteRecord') : t('updateDetail.deleteUpdate'), tone: 'danger' }))) return;
    void (async () => {
      try { await api.del(`/api/context-updates/${u.id}`); notify('success', t('updateDetail.updateMovedToTheTrash')); onBack(); changed(); } catch (err) {
        notify('error', err instanceof Error ? err.message : t('updateDetail.couldNotDelete'));
      }
    })();
  };

  const keepMaterials = (keep: boolean) => run('keep', () => api.put(`/api/context-updates/${u.id}/keep-materials`, { keep }));

  const releaseMaterials = async () => {
    if (!(await confirm({ title: t('updateDetail.deleteTheKeptFilesOf'), message: t('updateDetail.theRecordStaysThisCannot'), confirmLabel: t('updateDetail.deleteFiles'), tone: 'danger' }))) return;
    void run('keep', () => api.put(`/api/context-updates/${u.id}/keep-materials`, { keep: false }), t('updateDetail.filesReleased'));
  };

  // A finished update still has its files only when the user kept them; otherwise just the record's list.
  const filesGone = u.status === 'done' && !u.keep_materials;
  const materials: NonNullable<ContextUpdate['material_files']> = filesGone ? u.materials.map((m) => ({ ...m, modified: '' })) : (u.material_files ?? []);
  const keptSize = materials.reduce((sum, f) => sum + f.size, 0);
  const canChooseKeep = ['ready', 'analyzing', 'in_review', 'approved'].includes(u.status);
  const doneNext = u.keep_materials
    ? t('updateDetail.finishedTheRecordBelowShows')
    : meta.next;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 980, paddingBottom: reviewing || command ? 80 : 0 }}>
      <div>
        <button type="button" onClick={onBack} style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
          {t('updateDetail.allUpdates')}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600 }}>{u.title}</h2>
          <TypeBadge origin={u.origin} kind={u.kind} />
          <StatusPill status={u.status} />
          <span style={{ marginLeft: 'auto' }}>
            {u.status !== 'applying' && <Button variant="ghost" size="sm" onClick={remove}>{t('updateDetail.delete')}</Button>}
          </span>
        </div>
        <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{u.id}</span> · {isCorrection ? <>{rich(t, 'updateDetail.correctionOfTheMeetingRecord', { meeting: u.correction?.meeting, created_at: formatRelativeDate(u.created_at) })}</> : u.kind === 'correction-follow-up' ? <>{t('updateDetail.followUpOf')} {u.follows ? <Link to={`/context/updates/${u.follows}`} className="gtd-link">{u.follows}</Link> : t('updateDetail.aCorrection')}{t('updateDetail.opened')} {formatRelativeDate(u.created_at)}</> : <>{u.kind === 'memory-review' ? t('updateDetail.reviewOfYourExistingMemory') : u.kaizen ? '' : <>{rich(t, 'updateDetail.materialFrom', { source_date: u.source_date || t('updateDetail.unknownDate') })} </>}{u.origin === 'system-cleanup' ? t('updateDetail.openedBySystemCleanup') : u.kaizen ? t('updateDetail.openedFromTaskFeedback') : u.origin === 'meetings' ? t('updateDetail.madeByMeetingDigestFrom', { count: u.digest_meetings?.length ?? 0, length: u.digest_meetings?.length ?? 0 }) : 'imported'} {formatRelativeDate(u.created_at)}</>}
          {u.applied_at && <> {rich(t, 'updateDetail.finished', { applied_at: formatRelativeDate(u.applied_at) })}</>}
        </div>
      </div>

      <div style={card}><StepIndicator status={u.status} /></div>

      {/* What to do next: always one clear action. */}
      <section ref={(el) => { nextRef.current = el; setNextBox(el); }} aria-label={t('updateDetail.nextStep')} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12, borderColor: meta.color }}>
        <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}><strong>{t('updateDetail.next')} </strong>{u.status === 'done' ? doneNext : u.follow_up_problem
          ? t('updateDetail.thisFollowUpIsOutdated', { value: ['in_review', 'approved'].includes(u.status) ? 'close' : 'delete' })
          : meta.next}</div>
        {/* A run going by hand (no dashboard run): its command stays at hand to run again. */}
        {u.status === 'analyzing' && !running && !u.follow_up_problem && (
          <CommandBox command={`/gtd-context-analyze ${u.id}`} label={t('updateDetail.runInClaudeCodeTo')} onCopied={() => setCopiedFor(u.status)} />
        )}
        {/* One primary action (#246): the dashboard runs it, the command one click away under "Or run it yourself";
            when the dashboard cannot run it, copying the command is the main action, with the reason. */}
        {['ready', 'analyzing', 'in_review'].includes(u.status) && (
          <AnalysisRun ref={runRef} startable={!u.follow_up_problem} updateId={u.id} status={u.status} onChange={changed} onRunning={setRunning} onAction={setNextAction} onStartFailed={showNextBox}
            {...(u.status === 'ready' && !u.follow_up_problem ? { manual: (emphasis: boolean) => (
              <>
                <CommandBox command={`/gtd-context-analyze ${u.id}`} emphasis={emphasis}
                  label={emphasis ? t('updateDetail.yourTurnCopyThisAnd') : t('updateDetail.copyThisAndRunIt')}
                  onCopied={() => setCopiedFor(u.status)} />
                <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {rich(t, 'updateDetail.usingCodexOrCopilotAsk', { id: u.id })}
                </p>
              </>
            ) } : {})} />
        )}
        {u.status === 'applying' && !running && !u.follow_up_problem && (
          <CommandBox command={`/gtd-context-apply ${u.id}`} label={t('updateDetail.runInClaudeCodeTo2')} onCopied={() => setCopiedFor(u.status)} />
        )}
        {['approved', 'applying', 'done'].includes(u.status) && (
          <AnalysisRun ref={runRef} startable={!u.follow_up_problem} updateId={u.id} status={u.status} onChange={changed} onRunning={setRunning} onAction={setNextAction} onStartFailed={showNextBox}
            {...(u.status === 'approved' && !u.follow_up_problem ? { manual: (emphasis: boolean) => (
              <>
                <CommandBox command={`/gtd-context-apply ${u.id}`} emphasis={emphasis}
                  label={emphasis ? t('updateDetail.lastStepCopyThisAnd') : t('updateDetail.copyThisAndRunIt')}
                  onCopied={() => setCopiedFor(u.status)} />
                <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {rich(t, 'updateDetail.usingCodexOrCopilotAsk2', { id: u.id })}
                </p>
              </>
            ) } : {})} />
        )}
        {(u.status === 'analyzing' || u.status === 'applying') && !running && !u.follow_up_problem && (
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {t('updateDetail.takingTooLongOrThe')}
            {u.status === 'analyzing' && <> {t('updateDetail.or')} <button type="button" onClick={reopen} style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'inherit' }}>{t('updateDetail.goBackToCollecting')}</button>.</>}
          </p>
        )}
        {u.status === 'analyzing' && !u.follow_up_problem && (
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {rich(t, 'updateDetail.usingCodexOrCopilotAsk', { id: u.id })}
          </p>
        )}
        {u.status === 'approved' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" size="sm" loading={busy === 'back'} onClick={() => run('back', () => api.post(`/api/context-updates/${u.id}/back-to-review`))}>{t('updateDetail.changeMySelection')}</Button>
          </div>
        )}
      </section>

      {u.kaizen && <KaizenCard kaizen={u.kaizen} />}

      {u.follow_up_problem && (
        <HelpBox tone="critical" title={t('updateDetail.thisFollowUpNoLonger')}>{u.follow_up_problem}.</HelpBox>
      )}

      {u.notes && (
        <section aria-label={t('importUpdateModal.notesForTheAgent')}>
          <h3 style={sectionLabel}>{t('updateDetail.yourNotesForTheAgent')}</h3>
          <div style={card}><MarkdownView content={u.notes} compact /></div>
        </section>
      )}

      <section aria-label={t('updateDetail.materials')}>
        <h3 style={sectionLabel}>{rich(t, 'updateDetail.materials2', { length: materials.length })}</h3>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filesGone && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('updateDetail.deletedWhenTheUpdateFinished')}</p>}
          {u.status === 'done' && u.keep_materials && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>{rich(t, 'updateDetail.keptAtYourRequestOn', { keptSize: formatBytes(keptSize) })}</span>
              <Button variant="secondary" size="sm" loading={busy === 'keep'} onClick={releaseMaterials}>{t('updateDetail.releaseFiles')}</Button>
            </div>
          )}
          {materials.length === 0 && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('updateDetail.noFilesYet')}</p>}
          {materials.map((f) => (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)' }}>
              {filesGone
                ? <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-text-secondary)' }}>{f.name}</span>
                : <a href={api.link(`/api/context-updates/${u.id}/materials/${f.name.split('/').map(encodeURIComponent).join('/')}`)} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-accent)' }}>{f.name}</a>}
              {(() => {
                const copy = (u.transcripts ?? []).find((x) => x.file === f.name);
                const problem = (u.transcript_problems ?? []).find((x) => x.source === f.name);
                if (copy) {
                  const outdated = copy.current === false;
                  return (
                    <span title={outdated ? t('updateDetail.theOriginalOrThisCopy') : undefined}
                      style={{ fontSize: 'var(--text-xs)', color: copy.complete && !outdated ? 'var(--color-text-muted)' : 'var(--color-warning)' }}>
                      {rich(t, 'updateDetail.readableCopyOf', { source: copy.source, value: copy.complete ? '' : t('updateDetail.incomplete'), value2: outdated ? t('updateDetail.outdated') : '' })}
                    </span>
                  );
                }
                return problem ? <span title={problem.reason} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-warning)' }}>{t('updateDetail.noReadableCopy')}</span> : null;
              })()}
              <OfficeCheckBadge check={f.officeCheck} />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
              {u.status === 'ready' && (
                <button type="button" aria-label={t('removeNamedFile', { name: f.name })} onClick={() => removeFile(f.name)}
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
                {rich(t, 'updateDetail.keepTheOriginalFilesAfter', { part: <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {t('updateDetail.usefulForARecordingOr')}
                </span> })}
              </span>
            </label>
          )}
          {busy === 'upload' && <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('updateDetail.uploading')}</span>}
          {(u.status === 'in_review' || u.status === 'approved') && (
            <div><Button variant="ghost" size="sm" disabled={saving > 0} onClick={reopen}>{t('updateDetail.addMoreMaterial2')}</Button></div>
          )}
        </div>
      </section>

      {['in_review', 'approved', 'applying', 'done'].includes(u.status) && (
        <section aria-label={t('analysisRun.analysis')}>
          <h3 style={sectionLabel}>{t('updateDetail.whatTheAgentFound')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {u.summary && <div style={card}><MarkdownView content={u.summary} compact /></div>}
            {u.unread.length > 0 && (
              <HelpBox tone="warning" title={t('updateDetail.someFilesCouldNotBe')}>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {u.unread.map((r) => <li key={r.name}><strong>{r.name}</strong>: {r.reason}</li>)}
                </ul>
              </HelpBox>
            )}

            {records.length > 0 && (
              <section aria-label={t('updateDetail.meetingRecords')} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h4 style={{ ...sectionLabel, margin: 0 }}>{rich(t, 'updateDetail.meetings', { length: records.length })}</h4>
                {isCorrection && u.correction_review && <CorrectionCard review={u.correction_review} explanations={records[0]?.corrections ?? []} open={u.status !== 'done'} rejected={records[0]?.confirmation === 'rejected'}
                  busy={saving > 0} {...(reviewing && records[0] && !u.correction_review.finishing ? {
                    onUse: (index: number, use: boolean) => void applySuggestion(records[0]!, index, use),
                    onUseWords: (index: number, use: boolean) => void applySuggestion(records[0]!, index, use, 'transcript-suggestions'),
                  } : {})} />}
                {isCorrection && u.status === 'done' && u.correction_review?.current && (u.correction_review.changes.length > 0 || Boolean(u.correction_review.transcript?.made)) && records[0]?.confirmation === 'confirmed' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="secondary" loading={busy === 'follow'} onClick={() => void followUp()}>{t('updateDetail.checkTheContext')}</Button>
                    <span style={{ flex: '1 1 240px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                      {t('updateDetail.notesWrittenFromTheRecord')}
                    </span>
                  </div>
                )}
                {reviewing && isCorrection && (
                  <HelpBox>
                    {t('updateDetail.theCorrectedRecordAsA')}
                  </HelpBox>
                )}
                {reviewing && !isCorrection && (
                  <HelpBox>
                    {t('updateDetail.whatEachMeetingWasAs')}
                  </HelpBox>
                )}
                {records.map((r, i) => (
                  <MeetingRecordCard key={`${i}-${r.id}`} record={r} reviewing={reviewing} confirmation={recordChoice(r)}
                    onChoose={(value) => void chooseRecord(r, value)}
                    onSpeaker={(speaker, person) => void setSpeaker(r, speaker, person)}
                    onCreateTask={r.confirmation === 'confirmed' && u.status === 'done' ? (item) => void createTask(r, item) : undefined} />
                ))}
              </section>
            )}

            {isCorrection ? null : u.proposals.length === 0 ? (
              <HelpBox title={t('updateDetail.nothingWorthChanging')}>
                {u.kind === 'correction-follow-up'
                  ? t('updateDetail.theAgentFoundNoNote')
                  : u.kaizen
                  ? t('updateDetail.theAgentFoundNoFile')
                  : t('updateDetail.theAgentFoundNothingIn')}{' '}{reviewing && (records.length > 0 ? t('updateDetail.confirmTheMeetingRecordsYou') : t('updateDetail.closeTheUpdateToFinish'))}
              </HelpBox>
            ) : (
              <>
                {reviewing && (
                  <HelpBox>
                    {rich(t, 'updateDetail.eachProposalShowsTheFile', { part: <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{t('updateDetail.green')}</span>, part2: <span style={{ color: 'var(--color-critical)', fontWeight: 600 }}>{t('updateDetail.red')}</span> })}
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
                  {rich(t, 'updateDetail.consideredButNotProposed', { length: u.skipped.length })}
                </summary>
                <p style={{ margin: '8px 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {t('updateDetail.whatTheAgentLookedAt')}
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
        <div style={{ position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)' }}>
          {u.proposals.length > 0 && (
            <>
              <span aria-live="polite" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{rich(t, 'updateDetail.ofSelected', { acceptedCount: acceptedCount, length: u.proposals.length })}</span>
              <Button variant="ghost" size="sm" onClick={() => void selectAll(true)}>{t('updateDetail.selectAll')}</Button>
              <Button variant="ghost" size="sm" onClick={() => void selectAll(false)}>{t('updateDetail.clear')}</Button>
            </>
          )}
          {records.length > 0 && <span aria-live="polite" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{rich(t, 'updateDetail.ofMeetingsConfirmed', { confirmedCount: new Intl.NumberFormat(locale).format(confirmedCount), count: records.length })}</span>}
          {canApprove && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{approveHint}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" loading={busy === 'close'} disabled={saving > 0} onClick={close}
              title={t('updateDetail.finishWithoutChangingAnyContext')}>
              {u.proposals.length === 0 && records.length === 0 ? t('updateDetail.closeUpdate') : t('updateDetail.closeWithoutChanges2')}
            </Button>
            {(u.proposals.length > 0 || records.length > 0) && (
              <Button variant="primary" disabled={!canApprove || saving > 0} loading={busy === 'approve'}
                title={saving > 0 ? t('updateDetail.savingYourChoices') : correctionBlocked ? (u.follow_up_problem ? t('updateDetail.thisFollowUpNoLonger2') : t('updateDetail.thisCorrectionCannotBeApproved2')) : !canApprove ? t('updateDetail.tickAtLeastOneProposal') : noFileToWrite ? t('updateDetail.finishThisUpdateNowNothing') : t('updateDetail.lockYourSelectionAndGet')}
                onClick={() => run('approve', () => api.post(`/api/context-updates/${u.id}/approve`),
                  isCorrection ? 'Corrected. The meeting shows the new version of its record.' : !noFileToWrite ? 'Approved. Run the apply command to write the changes.' : acceptedCount > 0 ? 'Approved. The files are in the trash.' : 'Approved. The meeting records are kept.')}>
                {acceptedCount > 0 ? t('updateDetail.approveSelected', { acceptedCount }) : isCorrection ? t('updateDetail.approveCorrection') : t('updateDetail.approve')}
              </Button>
            )}
          </span>
        </div>
      )}

      {/* Waiting on the next step: repeated here only while the Next box is scrolled away, with the same action. */}
      {command && !nextInView && ['run', 'starting', 'copy'].includes(nextAction) && (
        <div role="region" aria-label={t('updateDetail.yourNextStep')} style={{ position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', background: 'var(--color-surface)', border: '1.5px solid var(--color-accent)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)' }}>
          <span aria-live="polite" style={{ flex: '1 1 260px', minWidth: 0, fontSize: 'var(--text-sm)', lineHeight: 1.45 }}>
            {nextAction !== 'copy' ? (
              <><strong>{u.status === 'ready' ? t('updateDetail.yourTurn') : t('updateDetail.lastStep')}</strong>{u.status === 'ready' ? t('updateDetail.runTheAnalysisTheAgent') : t('updateDetail.applyYourAcceptedChangesNothing')}</>
            ) : copied ? (
              <>{rich(t, 'updateDetail.pasteItIntoClaudeCode', { strong: <strong style={{ color: 'var(--color-success)' }}>{t('updateDetail.copied')}</strong> })}</>
            ) : (
              <>{rich(t, 'updateDetail.runInClaudeCode', { strong: <strong>{u.status === 'ready' ? t('updateDetail.yourTurn') : t('updateDetail.lastStep')}</strong>, code: <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{command.split(' ')[0]}</code>, value: u.status === 'ready' ? t('updateDetail.soTheAgentCanAnalyze') : t('updateDetail.toWriteTheAcceptedChanges') })}</>
            )}
          </span>
          {nextAction !== 'copy'
            ? <Button variant="primary" loading={nextAction === 'starting'} onClick={() => runRef.current?.start()}>{u.status === 'ready' ? t('analysisRun.runAnalysis') : t('updateDetail.applyWithClaudeCode')}</Button>
            : (
              <Button variant={copied ? 'secondary' : 'primary'} onClick={() => void copyText(command).then((ok) => { if (ok) setCopiedFor(u.status); })}>
                {copied ? t('updateDetail.copyAgain') : t('updateDetail.copyCommand')}
              </Button>
            )}
        </div>
      )}
    </div>
  );
}
