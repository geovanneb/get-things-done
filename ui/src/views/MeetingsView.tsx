import React from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import { apiPost, apiPut } from '@/utils/api';
import { useDataVersion } from '@/store';
import Button from '@/components/common/Button';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Card from '@/components/common/Card';
import Notice from '@/components/common/Notice';
import Page, { PageHeader } from '@/components/common/Page';
import Toggle from '@/components/common/Toggle';
import { LiveTranscript } from '@/components/meetings/LiveTranscript';
import { TranscriptReader } from '@/components/meetings/TranscriptReader';
import { recordingElsewhere } from '@/components/meetings/QueuedMeetingActions';
import { MeetingsList } from '@/components/meetings/MeetingsList';
import { useRecordLauncher } from '@/components/recording/RecordLauncher';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { readableTranscript, transcriptOnItsWay } from '@/utils/transcriptReading';
import type { HistoryMeeting, MeetingDigest, SystemCleanup } from '@/types';
import type { MeetingsOutlet } from './MeetingDetailView';


const REFRESH_MS = 10_000;

/**
 * Asked once, before any transcript is kept: meeting text used to be deleted when its review was done. Until the user
 * answers, nothing is kept (the server reads an unanswered question as no). The answer can be changed in System cleanup.
 */
function KeepTextQuestion({ days, onAnswered }: { days: number; onAnswered: () => void }) {
  const [keep, setKeep] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const answer = async (value: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await apiPut('/api/routines/system-cleanup', { meetings: { keep_text: value } });
      onAnswered();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };
  return (
    <Card title="Meetings can now keep their transcripts" description="Until now, a meeting's transcript and notes were deleted once its review was done. Choose before any is kept.">
      <div className="gtd-stack" style={{ gap: 'var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
          <Toggle id="keep-meeting-text" label="Keep meeting transcripts and notes" checked={keep} onChange={setKeep} />
          <label htmlFor="keep-meeting-text">
            <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>Keep meeting transcripts and notes</span><br />
            Only the meeting text: not the other materials, and not the audio (that follows Keep recordings in Settings &gt; Transcription).
          </label>
        </div>
        <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
          <li>Each meeting is kept {days} days from the day it took place or was imported, then moved to the trash. Change this in Routines &gt; System cleanup &gt; Meetings.</li>
          <li>Mark a meeting <strong>Keep this meeting</strong> to keep it longer, or delete it yourself at any time.</li>
          <li>The trash holds it 30 more days, so you can restore it. It stays on this computer until then.</li>
          <li>Kept text stays in its update's folder under context-updates/, where materials wait during review. Agents never read it as task input.</li>
        </ul>
        <span>Meetings reviewed before this version keep their confirmed records, but their transcripts were already deleted.</span>
        {error && <Notice tone="critical" title="Your choice was not saved.">{error} Try again.</Notice>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <Button variant="ghost" disabled={saving} onClick={() => void answer(false)}>Not now, keep deleting them</Button>
          <Button variant="primary" loading={saving} onClick={() => void answer(keep)}>{keep ? 'Keep transcripts' : 'Save my choice'}</Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * When the queue goes into a digest, and a way to make one now: the meetings are here, so the button is too. A digest
 * still open for review holds the next one back; it says so, and where to find it.
 */
function DigestNow({ job, onDone }: { job: MeetingDigest; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const waiting = job.queue.filter((m) => m.status === 'queued' && !m.in_digest).length;
  const when = job.next_run_at ? new Date(job.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const run = async () => {
    setBusy(true);
    setNotice(null);
    try {
      // A run that failed still answers 201, with what went wrong.
      const result = await apiPost<{ status: 'ok' | 'error'; message: string }>('/api/routines/meeting-digest/run');
      setNotice({ text: result.message, error: result.status === 'error' });
      onDone();
    } catch (err) {
      setNotice({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const line = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' } as const;
  return (
    <>
      {job.open_digest
        ? <span style={line}>Digest <Link to={`/context/updates/${job.open_digest}`} className="gtd-link">{job.open_digest}</Link> is open for review: the next one waits for it.</span>
        : when && waiting > 0 && <span style={line}>Next digest {when}</span>}
      <Button size="sm" variant="secondary" loading={busy} disabled={busy || waiting === 0 || Boolean(job.open_digest)}
        title={waiting === 0 ? 'No meeting waits for a digest' : 'Make a digest from the queue now, without waiting for the schedule'}
        onClick={() => void run()}>
        Make digest now
      </Button>
      {notice && <span role={notice.error ? 'alert' : 'status'} style={{ ...line, flexBasis: '100%', textAlign: 'right', color: notice.error ? 'var(--color-critical)' : line.color }}>{notice.text}</span>}
    </>
  );
}

/** Recording, the live transcript, and the meetings on their way into a digest. The digest's schedule stays in Routines. */
export default function MeetingsView() {
  const recorder = useRecorder();
  const { openRecordDialog } = useRecordLauncher();
  const routines = useDataVersion('routines');
  const updates = useDataVersion('context-updates');
  const transcription = useDataVersion('transcription');
  const { data, error, refetch } = useApi<MeetingDigest>('/api/routines/meeting-digest', [routines, updates, transcription]);
  const { data: history, error: historyError, refetch: refetchHistory } = useApi<HistoryMeeting[]>('/api/meetings/history', [routines, updates]);
  const { data: cleanup, refetch: refetchCleanup } = useApi<SystemCleanup>('/api/routines/system-cleanup', [routines]);
  const retention = cleanup ? { keep_text: cleanup.settings.meetings?.keep_text ?? null, enabled: cleanup.settings.rules.meetings?.enabled ?? false, days: cleanup.settings.rules.meetings?.older_than_days ?? 180, action: cleanup.settings.rules.meetings?.action ?? 'trash' } : null;
  const changed = React.useCallback(() => { refetch(); refetchHistory(); }, [refetch, refetchHistory]);
  // Nothing announces audio arriving or a page that crashed, so while a recording exists its state is asked for.
  const recording = Boolean(data?.queue.some((m) => m.live?.state === 'recording'));
  // What the reader shows: what was asked for, else the meeting that just ended, whose transcript opens by itself.
  const [picked, setPicked] = React.useState<{ meeting: string; file: string } | null>(null);
  const [closed, setClosed] = React.useState<string | null>(null);
  // A recording that just ended comes first: it replaces what was being read.
  React.useEffect(() => {
    if (recorder.lastMeetingId) { setPicked(null); setClosed(null); }
  }, [recorder.lastMeetingId]);
  // A meeting that went into a digest has left the queue, and with it what was picked.
  const pickedMeeting = data?.queue.find((m) => m.id === picked?.meeting);
  const shown = pickedMeeting ?? data?.queue.find((m) => m.id === recorder.lastMeetingId && m.id !== closed);
  const transcript = shown ? readableTranscript(shown, pickedMeeting ? picked?.file : undefined) : null;
  const waiting = Boolean(shown && transcriptOnItsWay(shown));
  React.useEffect(() => {
    if (!recording && !waiting) return undefined;
    const timer = setInterval(refetch, REFRESH_MS);
    return () => clearInterval(timer);
  }, [recording, waiting, refetch]);
  // This page's recording, or one running in another page: its text can be followed from here too.
  const own = recorder.active ? recorder.meetingId : null;
  const elsewhere = own ? undefined : data?.queue.find((m) => recordingElsewhere(m));
  const following = own ?? elsewhere?.id ?? null;

  return (
    <Page width="default">
      <PageHeader description="Every meeting, recorded here or imported: read it, see what was confirmed, and follow it into the next digest. The digest's schedule is in Routines." />
      {retention && retention.keep_text === null && <KeepTextQuestion days={retention.days} onAnswered={() => { refetchCleanup(); refetchHistory(); }} />}
      <Card
        title={own ? recorder.title : elsewhere ? `${elsewhere.title}, recording in another page` : 'Recording'}
        description={following ? undefined : 'Transcribed on this computer. With a live model in Settings > Transcription, the text appears here as people speak.'}
        actions={!recorder.active && !elsewhere && <Button variant="primary" onClick={openRecordDialog}>Record a meeting</Button>}
      >
        {following ? <LiveTranscript meetingId={following} /> : null}
      </Card>
      {shown && transcript && (
        <TranscriptReader key={`${shown.id}/${transcript.file}/${transcript.name}/${transcript.sha256}`} meetingId={shown.id} title={shown.title} transcript={transcript}
          canName={transcript.final && !shown.in_digest} onNamed={refetch} participants={shown.participants ?? []}
          onClose={() => { if (pickedMeeting) setPicked(null); else setClosed(shown.id); }} />
      )}
      {shown && !transcript && waiting && (
        <Card title={shown.title}>
          <LoadingSpinner inline text="The transcript appears here when it is ready." />
        </Card>
      )}
      <MeetingsList job={data ?? null} history={history ?? null} error={error ?? historyError} retention={retention} onChanged={changed}
        actions={data && <DigestNow job={data} onDone={changed} />} />
      <Outlet context={{ job: data ?? null, retention, onChanged: changed } satisfies MeetingsOutlet} />
    </Page>
  );
}
