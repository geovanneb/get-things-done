import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import { useEffect, useRef, useState } from 'react';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Input, { Textarea } from '@/components/common/Input';
import { apiPost } from '@/utils/api';
import { ParticipantsField } from '@/components/meetings/ParticipantsField';
import type { ContextUpdate, MeetingParticipant, QueuedMeeting } from '@/types';
import { HelpBox, formatBytes, hardToRead } from './shared';
import DictateButton from '@/components/common/DictateButton';
import { withDictation } from '@/utils/dictation';

const MAX_FILE = 50 * 1024 * 1024;
/** A meeting recording, queued for transcription: up to 4 GB (decimal), as the server accepts. */
const MAX_RECORDING = 4_000_000_000;
const RECORDING = /\.(wav|m4a|mp3|aac|flac|aiff?|caf|ogg|opus|webm|wma|mp4|mov)$/i;
const isRecording = (name: string) => RECORDING.test(name);
/** Recordings a meeting for the digest gets transcribed from (the server says when this computer cannot). */
const TRANSCRIBED = /\.(wav|m4a|mp3|aac|flac|aiff?|caf)$/i;
/** The limit for a file: in a meeting for the digest a recording may be 4 GB; everything else 50 MB. */
const limitFor = (file: File, meeting: boolean) => (meeting && isRecording(file.name) ? MAX_RECORDING : MAX_FILE);
const limitLabel = (file: File, meeting: boolean) => (limitFor(file, meeting) === MAX_RECORDING ? '4 GB' : '50 MB');

const labelStyle: React.CSSProperties = { display: 'block', marginBottom: 4, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)' };
const hintStyle: React.CSSProperties = { margin: '0 0 6px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.45 };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Uploads one file to an update; resolves to an error message, or null when it worked. `workspace`: the page belongs to
 * that workspace (opened from a run-finished notice), and the upload is refused when another one is open.
 */
export async function uploadMaterial(updateId: string, file: File, workspace?: string): Promise<string | null> {
  if (file.size > MAX_FILE) return tr('importUpdateModal.isLargerThan50Mb', { name: file.name });
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`/api/context-updates/${updateId}/materials`, {
      method: 'POST', body: form, headers: workspace ? { 'X-GTD-Workspace': encodeURIComponent(workspace) } : {},
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return `${file.name}: ${body?.message ?? tr('newTaskModal.uploadFailed', { status: res.status })}`;
  } catch {
    return tr('newTaskModal.uploadFailed2', { name: file.name });
  }
}

/** Uploads one file to a meeting in the queue; resolves to an error message, or null when it worked. */
async function uploadToMeeting(meetingId: string, file: File): Promise<string | null> {
  if (file.size > limitFor(file, true)) return tr('importUpdateModal.isLargerThan', { name: file.name, limitLabel: limitLabel(file, true) });
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`/api/meeting-queue/${meetingId}/files`, { method: 'POST', body: form });
    if (res.ok) return null;
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return `${file.name}: ${body?.message ?? tr('newTaskModal.uploadFailed', { status: res.status })}`;
  } catch {
    return tr('newTaskModal.uploadFailed2', { name: file.name });
  }
}

/** Drop zone for many files at once; also opens the file picker on click or Enter. */
export function DropZone({ onFiles, compact = false }: { onFiles: (files: File[]) => void; compact?: boolean }) {
  const { t } = useLanguage();
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      role="button" tabIndex={0}
      aria-label={t('importUpdateModal.addFilesDropThemHere')}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}
      style={{ border: `1.5px dashed ${over ? 'var(--color-accent)' : 'var(--color-border-strong)'}`, borderRadius: 'var(--radius-md)', background: over ? 'var(--color-accent-subtle)' : 'var(--color-bg)', padding: compact ? '12px' : '22px 16px', textAlign: 'center', cursor: 'pointer', transition: 'background 0.1s, border-color 0.1s' }}>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)' }}>{t('importUpdateModal.dropFilesHereOrClick')}</div>
      {!compact && (
        <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {t('importUpdateModal.anyFormatTranscriptsSlidesPdfs')}
        </div>
      )}
    </div>
  );
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (update: ContextUpdate, uploadErrors: string[]) => void;
  /** A meeting went into the digest queue instead of becoming an update now. */
  onQueued: (meeting: QueuedMeeting) => void;
}

export default function ImportUpdateModal({ isOpen, onClose, onCreated, onQueued }: Props) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<'update' | 'meeting'>('update');
  const [title, setTitle] = useState('');
  const [sourceDate, setSourceDate] = useState(today);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [notes, setNotes] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setMode('update'); setTitle(''); setSourceDate(today()); setParticipants([]); setNotes(''); setText(''); setFiles([]); setSaving(null); setError(null);
  }, [isOpen]);

  const addFiles = (incoming: File[]) => {
    setFiles((prev) => [...prev, ...incoming.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);
  };

  const hasContent = files.length > 0 || text.trim().length > 0;
  const tooBig = files.filter((f) => f.size > limitFor(f, mode === 'meeting'));
  // A recording in a meeting for the digest is transcribed first, so the agent reads its transcript.
  const risky = files.filter((f) => hardToRead(f.name) && !(mode === 'meeting' && TRANSCRIBED.test(f.name)));

  const queueMeeting = async () => {
    setSaving(t('importUpdateModal.saving'));
    let meetingId: string | null = null;
    try {
      const meeting = await apiPost<QueuedMeeting>('/api/meeting-queue', {
        title: title.trim() || (files[0] ? files[0].name.replace(/\.[^.]+$/, '') : t('importUpdateModal.meeting')),
        meeting_date: sourceDate,
        participants,
      });
      meetingId = meeting.id;
      const all = text.trim()
        ? [...files, new File([text], /^\uFEFF?WEBVTT/.test(text) ? 'pasted-transcript.vtt' : 'pasted-text.md', { type: 'text/plain' })]
        : files;
      const errors: string[] = [];
      for (let i = 0; i < all.length; i++) {
        setSaving(t('newTaskModal.uploadingOf', { value: i + 1, length: all.length }));
        const failed = await uploadToMeeting(meeting.id, all[i]!);
        if (failed) errors.push(failed);
      }
      if (errors.length) {
        // A meeting with a missing file never goes into a digest: remove the draft and say why.
        await fetch(`/api/meeting-queue/${meeting.id}`, { method: 'DELETE' }).catch(() => {});
        setError(t('importUpdateModal.nothingWasQueuedBecauseSome', { join: errors.join('; ') }));
        setSaving(null);
        return;
      }
      onQueued(await apiPost<QueuedMeeting>(`/api/meeting-queue/${meeting.id}/queue`));
    } catch (err) {
      if (meetingId) await fetch(`/api/meeting-queue/${meetingId}`, { method: 'DELETE' }).catch(() => {});
      setError(err instanceof Error ? err.message : t('importUpdateModal.couldNotQueueTheMeeting'));
      setSaving(null);
    }
  };

  const save = async () => {
    if (!hasContent) { setError(t('importUpdateModal.addAtLeastOneFile')); return; }
    if (tooBig.length) { setError(t('importUpdateModal.removeFilesOverTheirSize', { join: tooBig.map((f) => `${f.name} (${limitLabel(f, mode === 'meeting')})`).join(', ') })); return; }
    setError(null);
    if (mode === 'meeting') { await queueMeeting(); return; }
    setSaving(t('importUpdateModal.saving'));
    try {
      const update = await apiPost<ContextUpdate>('/api/context-updates', {
        title: title.trim() || (files[0] ? files[0].name.replace(/\.[^.]+$/, '') : ''),
        source_date: sourceDate, notes, text,
      });
      const errors: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setSaving(t('newTaskModal.uploadingOf', { value: i + 1, length: files.length }));
        const failed = await uploadMaterial(update.id, files[i]!);
        if (failed) errors.push(failed);
      }
      onCreated(update, errors);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('importUpdateModal.couldNotSaveTheUpdate'));
      setSaving(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={saving ? () => {} : onClose} title={t('importUpdateModal.importContextUpdate')} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <HelpBox title={t('importUpdateModal.howThisWorks')}>
          {mode === 'meeting' ? (
            <>
              {rich(t, 'importUpdateModal.addAMeetingSTranscript', { strong: <strong>{t('importUpdateModal.nothingChangesUntilYouReview')}</strong> })}
            </>
          ) : (
            <>
              {rich(t, 'importUpdateModal.addAnythingThatMightChange', { strong: <strong>{t('importUpdateModal.nothingChangesUntilYouReview')}</strong> })}
            </>
          )}
        </HelpBox>

        <div role="radiogroup" aria-label={t('importUpdateModal.whatToDoWithIt')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            ['update', t('importUpdateModal.importNow'), t('importUpdateModal.oneContextUpdateForThis')],
            ['meeting', t('importUpdateModal.addToTheMeetingDigest'), t('importUpdateModal.aMeetingForTheQueue')],
          ] as const).map(([value, label, hint]) => (
            <label key={value} style={{ flex: '1 1 220px', display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', cursor: 'pointer',
              border: `1px solid ${mode === value ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)',
              background: mode === value ? 'var(--color-accent-subtle)' : 'transparent' }}>
              <input type="radio" name="import-mode" value={value} checked={mode === value} onChange={() => setMode(value)} disabled={!!saving} style={{ marginTop: 3 }} />
              <span>
                <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.4 }}>{hint}</span>
              </span>
            </label>
          ))}
        </div>

        {error && <HelpBox tone="critical">{error}</HelpBox>}

        <div>
          <label style={labelStyle}>{t('newTaskModal.files')}</label>
          <DropZone onFiles={addFiles} />
          {mode === 'meeting' && (
            <p style={{ ...hintStyle, margin: '6px 0 0' }}>
              {t('importUpdateModal.aRecordingOfTheMeeting')}
            </p>
          )}
          {files.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {files.map((f) => (
                <li key={`${f.name}-${f.size}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '4px 8px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: f.size > limitFor(f, mode === 'meeting') ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
                  <button type="button" aria-label={t('removeNamedFile', { name: f.name })} onClick={() => setFiles((prev) => prev.filter((p) => p !== f))}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '0 4px', fontSize: 'var(--text-base)' }}>×</button>
                </li>
              ))}
            </ul>
          )}
          {risky.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <HelpBox tone="warning">
                {t('importUpdateModal.theAgentMayNotBe')} {risky.map((f) => f.name).join(', ')}{t('importUpdateModal.audioVideoAndArchivesAre')}
              </HelpBox>
            </div>
          )}
        </div>

        <div>
          <label style={labelStyle}>{t('importUpdateModal.orPasteText')}</label>
          <p style={hintStyle}>{t('importUpdateModal.aTranscriptCopiedFromYour')}</p>
          <Textarea value={text} onChange={setText} rows={5} placeholder={t('importUpdateModal.pasteATranscriptOrNotes')} aria-label={t('importUpdateModal.pastedText')} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          <div>
            <label style={labelStyle}>{t('importUpdateModal.title')}</label>
            <p style={hintStyle}>{t('importUpdateModal.optionalDefaultsToTheFirst')}</p>
            <Input value={title} onChange={setTitle} placeholder={mode === 'meeting' ? t('importUpdateModal.eGWeeklySync') : t('importUpdateModal.eGSteeringCommitteeOctober')} aria-label={t('importUpdateModal.title')} />
          </div>
          <div>
            <label style={labelStyle}>{mode === 'meeting' ? t('importUpdateModal.meetingDate') : t('importUpdateModal.dateOfTheMaterial')}</label>
            <p style={hintStyle}>{mode === 'meeting' ? t('importUpdateModal.whenTheMeetingHappenedThe') : t('importUpdateModal.whenTheMeetingHappenedOr')}</p>
            <Input type="date" value={sourceDate} onChange={setSourceDate} aria-label={mode === 'meeting' ? t('importUpdateModal.meetingDate') : t('importUpdateModal.dateOfTheMaterial')} />
          </div>
        </div>

        {mode === 'meeting' && <ParticipantsField value={participants} onChange={setParticipants} />}

        {mode === 'update' && (
          <div>
            <label style={labelStyle}>{t('importUpdateModal.notesForTheAgent')}</label>
            <p style={hintStyle}>{t('importUpdateModal.optionalWhatThisIsWho')}</p>
            <Textarea value={notes} onChange={setNotes} rows={3} placeholder={t('importUpdateModal.anythingTheAgentShouldKnow')} aria-label={t('importUpdateModal.notesForTheAgent')}
              footer={<DictateButton fieldName={t('importUpdateModal.notesForTheAgent2')} onText={(text) => setNotes((n) => withDictation(n, text))} />} />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, paddingTop: 4 }}>
          {saving && <span aria-live="polite" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginRight: 'auto' }}>{saving}</span>}
          <Button variant="ghost" onClick={onClose} disabled={!!saving}>{t('cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!!saving || !hasContent}>{mode === 'meeting' ? t('importUpdateModal.addToTheQueue') : t('importUpdateModal.saveAndGetCommand')}</Button>
        </div>
      </div>
    </Modal>
  );
}
