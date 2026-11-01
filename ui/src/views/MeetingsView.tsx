import React from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import { apiPost } from '@/utils/api';
import { useDataVersion } from '@/store';
import Button from '@/components/common/Button';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Card from '@/components/common/Card';
import Notice from '@/components/common/Notice';
import Page from '@/components/common/Page';
import { LiveTranscript } from '@/components/meetings/LiveTranscript';
import { TranscriptReader } from '@/components/meetings/TranscriptReader';
import { MeetingQueueList, recordingElsewhere } from '@/components/meetings/MeetingQueueList';
import { useRecordLauncher } from '@/components/recording/RecordLauncher';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { readableTranscript, transcriptOnItsWay } from '@/utils/transcriptReading';
import type { MeetingDigest } from '@/types';


const REFRESH_MS = 10_000;

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
      {notice && <span role={notice.error ? 'alert' : 'status'} style={{ ...line, flexBasis: '100%', color: notice.error ? 'var(--color-critical)' : line.color }}>{notice.text}</span>}
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
    <Page width="narrow">
      <Card
        title={own ? recorder.title : elsewhere ? `${elsewhere.title}, recording in another page` : 'Recording'}
        description={following ? undefined : 'The recording is transcribed on this computer. With a live model in Settings > Transcription, the text appears here as people speak.'}
        actions={!recorder.active && !elsewhere && <Button variant="primary" onClick={openRecordDialog}>Record a meeting</Button>}
      >
        {following ? <LiveTranscript meetingId={following} /> : null}
      </Card>
      {shown && (transcript || waiting) && (
        <Card aria-label="Transcript of the meeting">
          {transcript
            ? <TranscriptReader key={`${shown.id}/${transcript.file}/${transcript.name}/${transcript.sha256}`} meetingId={shown.id} title={shown.title} transcript={transcript}
              canName={transcript.final && !shown.in_digest} onNamed={refetch} participants={shown.participants ?? []}
              onClose={() => { if (pickedMeeting) setPicked(null); else setClosed(shown.id); }} />
            : <p role="status" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{shown.title}: the transcript appears here when it is ready.</p>}
        </Card>
      )}
      <Card title="Queue" description="Meetings on their way into the next digest. The digest's schedule is in Routines."
        actions={data && <DigestNow job={data} onDone={refetch} />}>
        {error && <Notice tone="critical" title="Could not load the queue.">{error}</Notice>}
        {!data && !error && <LoadingSpinner text="Loading meetings…" />}
        {data && <MeetingQueueList job={data} onChanged={refetch} onRead={(meeting, file) => setPicked({ meeting, file })} />}
      </Card>
    </Page>
  );
}
