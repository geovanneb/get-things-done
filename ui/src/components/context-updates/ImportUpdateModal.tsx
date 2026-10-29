import { useEffect, useRef, useState } from 'react';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Input, { Textarea } from '@/components/common/Input';
import { apiPost } from '@/utils/api';
import type { ContextUpdate, QueuedMeeting } from '@/types';
import { HelpBox, formatBytes, hardToRead } from './shared';

const MAX_FILE = 50 * 1024 * 1024;

const labelStyle: React.CSSProperties = { display: 'block', marginBottom: 4, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)' };
const hintStyle: React.CSSProperties = { margin: '0 0 6px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.45 };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Uploads one file to an update; resolves to an error message, or null when it worked. */
export async function uploadMaterial(updateId: string, file: File): Promise<string | null> {
  if (file.size > MAX_FILE) return `${file.name} is larger than 50 MB`;
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`/api/context-updates/${updateId}/materials`, { method: 'POST', body: form });
    if (res.ok) return null;
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return `${file.name}: ${body?.message ?? `upload failed (${res.status})`}`;
  } catch {
    return `${file.name}: upload failed`;
  }
}

/** Uploads one file to a meeting in the queue; resolves to an error message, or null when it worked. */
async function uploadToMeeting(meetingId: string, file: File): Promise<string | null> {
  if (file.size > MAX_FILE) return `${file.name} is larger than 50 MB`;
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`/api/meeting-queue/${meetingId}/files`, { method: 'POST', body: form });
    if (res.ok) return null;
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return `${file.name}: ${body?.message ?? `upload failed (${res.status})`}`;
  } catch {
    return `${file.name}: upload failed`;
  }
}

/** Drop zone for many files at once; also opens the file picker on click or Enter. */
export function DropZone({ onFiles, compact = false }: { onFiles: (files: File[]) => void; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      role="button" tabIndex={0}
      aria-label="Add files: drop them here or press Enter to choose"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}
      style={{ border: `1.5px dashed ${over ? 'var(--color-accent)' : 'var(--color-border-strong)'}`, borderRadius: 'var(--radius-md)', background: over ? 'var(--color-accent-subtle)' : 'var(--color-bg)', padding: compact ? '12px' : '22px 16px', textAlign: 'center', cursor: 'pointer', transition: 'background 0.1s, border-color 0.1s' }}>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)' }}>Drop files here, or click to choose</div>
      {!compact && (
        <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          Any format: transcripts, slides, PDFs, spreadsheets, photos, screenshots. Up to 50 MB each.
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
  const [mode, setMode] = useState<'update' | 'meeting'>('update');
  const [title, setTitle] = useState('');
  const [sourceDate, setSourceDate] = useState(today);
  const [notes, setNotes] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setMode('update'); setTitle(''); setSourceDate(today()); setNotes(''); setText(''); setFiles([]); setSaving(null); setError(null);
  }, [isOpen]);

  const addFiles = (incoming: File[]) => {
    setFiles((prev) => [...prev, ...incoming.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);
  };

  const hasContent = files.length > 0 || text.trim().length > 0;
  const tooBig = files.filter((f) => f.size > MAX_FILE);
  const risky = files.filter((f) => hardToRead(f.name));

  const queueMeeting = async () => {
    setSaving('Saving...');
    let meetingId: string | null = null;
    try {
      const meeting = await apiPost<QueuedMeeting>('/api/meeting-queue', {
        title: title.trim() || (files[0] ? files[0].name.replace(/\.[^.]+$/, '') : 'Meeting'),
        meeting_date: sourceDate,
      });
      meetingId = meeting.id;
      const all = text.trim()
        ? [...files, new File([text], /^\uFEFF?WEBVTT/.test(text) ? 'pasted-transcript.vtt' : 'pasted-text.md', { type: 'text/plain' })]
        : files;
      const errors: string[] = [];
      for (let i = 0; i < all.length; i++) {
        setSaving(`Uploading ${i + 1} of ${all.length}...`);
        const failed = await uploadToMeeting(meeting.id, all[i]!);
        if (failed) errors.push(failed);
      }
      if (errors.length) {
        // A meeting with a missing file never goes into a digest: remove the draft and say why.
        await fetch(`/api/meeting-queue/${meeting.id}`, { method: 'DELETE' }).catch(() => {});
        setError(`Nothing was queued, because some files did not upload: ${errors.join('; ')}`);
        setSaving(null);
        return;
      }
      onQueued(await apiPost<QueuedMeeting>(`/api/meeting-queue/${meeting.id}/queue`));
    } catch (err) {
      if (meetingId) await fetch(`/api/meeting-queue/${meetingId}`, { method: 'DELETE' }).catch(() => {});
      setError(err instanceof Error ? err.message : 'Could not queue the meeting.');
      setSaving(null);
    }
  };

  const save = async () => {
    if (!hasContent) { setError('Add at least one file or paste some text.'); return; }
    if (tooBig.length) { setError(`Remove files over 50 MB: ${tooBig.map((f) => f.name).join(', ')}`); return; }
    setError(null);
    if (mode === 'meeting') { await queueMeeting(); return; }
    setSaving('Saving...');
    try {
      const update = await apiPost<ContextUpdate>('/api/context-updates', {
        title: title.trim() || (files[0] ? files[0].name.replace(/\.[^.]+$/, '') : ''),
        source_date: sourceDate, notes, text,
      });
      const errors: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setSaving(`Uploading ${i + 1} of ${files.length}...`);
        const failed = await uploadMaterial(update.id, files[i]!);
        if (failed) errors.push(failed);
      }
      onCreated(update, errors);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the update.');
      setSaving(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={saving ? () => {} : onClose} title="Import context update" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <HelpBox title="How this works">
          {mode === 'meeting' ? (
            <>
              Add a meeting&apos;s transcript or notes to the queue. The Meeting digest routine (see Routines) collects
              queued meetings into one context update on its schedule; that update is analyzed like any other. <strong>Nothing
              changes until you review and approve each proposal.</strong>
            </>
          ) : (
            <>
              Add anything that might change your context: a meeting transcript, a deck someone shared, a photo of a
              whiteboard. After you save, you get a command to run in Claude Code. The agent compares the material with
              your current context and proposes only the changes that matter. <strong>Nothing changes until you review
              and approve each proposal.</strong>
            </>
          )}
        </HelpBox>

        <div role="radiogroup" aria-label="What to do with it" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            ['update', 'Import now', 'One context update for this material, analyzed when you run the command.'],
            ['meeting', 'Add to the meeting digest', 'A meeting for the queue. The Meeting digest routine collects queued meetings into one update.'],
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
          <label style={labelStyle}>Files</label>
          <DropZone onFiles={addFiles} />
          {files.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {files.map((f) => (
                <li key={`${f.name}-${f.size}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '4px 8px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: f.size > MAX_FILE ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((prev) => prev.filter((p) => p !== f))}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '0 4px', fontSize: 'var(--text-base)' }}>×</button>
                </li>
              ))}
            </ul>
          )}
          {risky.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <HelpBox tone="warning">
                The agent may not be able to read {risky.map((f) => f.name).join(', ')}. Audio, video and archives are
                saved, but upload a transcript or the extracted files too if you can.
              </HelpBox>
            </div>
          )}
        </div>

        <div>
          <label style={labelStyle}>Or paste text</label>
          <p style={hintStyle}>A transcript copied from your meeting tool, notes, or an email thread. Saved as a file with the rest.</p>
          <Textarea value={text} onChange={setText} rows={5} placeholder="Paste a transcript or notes..." aria-label="Pasted text" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          <div>
            <label style={labelStyle}>Title</label>
            <p style={hintStyle}>Optional. Defaults to the first file name.</p>
            <Input value={title} onChange={setTitle} placeholder={mode === 'meeting' ? 'e.g. Weekly sync' : 'e.g. Steering committee, October'} aria-label="Title" />
          </div>
          <div>
            <label style={labelStyle}>{mode === 'meeting' ? 'Meeting date' : 'Date of the material'}</label>
            <p style={hintStyle}>{mode === 'meeting' ? 'When the meeting happened. The digest uses it to tell newer facts from older ones.' : 'When the meeting happened or the deck was shared. Used to tell newer facts from older ones.'}</p>
            <Input type="date" value={sourceDate} onChange={setSourceDate} aria-label={mode === 'meeting' ? 'Meeting date' : 'Date of the material'} />
          </div>
        </div>

        {mode === 'update' && (
          <div>
            <label style={labelStyle}>Notes for the agent</label>
            <p style={hintStyle}>Optional. What this is, who was there, what to trust or ignore. For example: "Budget figures are a first draft."</p>
            <Textarea value={notes} onChange={setNotes} rows={3} placeholder="Anything the agent should know..." aria-label="Notes for the agent" />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, paddingTop: 4 }}>
          {saving && <span aria-live="polite" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginRight: 'auto' }}>{saving}</span>}
          <Button variant="secondary" onClick={onClose} disabled={!!saving}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!!saving || !hasContent}>{mode === 'meeting' ? 'Add to the queue' : 'Save and get command'}</Button>
        </div>
      </div>
    </Modal>
  );
}
