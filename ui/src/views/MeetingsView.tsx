import React from 'react';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import Button from '@/components/common/Button';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { LiveTranscript } from '@/components/meetings/LiveTranscript';
import { TranscriptReader } from '@/components/meetings/TranscriptReader';
import { MeetingQueueList, recordingElsewhere } from '@/components/meetings/MeetingQueueList';
import { useRecordLauncher } from '@/components/recording/RecordLauncher';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { readableTranscript, transcriptOnItsWay } from '@/utils/transcriptReading';
import type { MeetingDigest } from '@/types';

const cardStyle = { border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', padding: 16 } as const;
const headingStyle = { margin: '0 0 10px', fontSize: 'var(--text-base)', fontWeight: 600 } as const;

const REFRESH_MS = 10_000;

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
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={cardStyle} aria-label="Recording">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h3 style={{ ...headingStyle, margin: 0, flex: 1 }}>{own ? recorder.title : elsewhere ? `${elsewhere.title}, recording in another page` : 'Record a meeting'}</h3>
          {!recorder.active && !elsewhere && <Button size="sm" variant="primary" onClick={openRecordDialog}>Record a meeting</Button>}
        </div>
        {following
          ? <div style={{ marginTop: 10 }}><LiveTranscript meetingId={following} /></div>
          : <p style={{ margin: '6px 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>The recording is transcribed on this computer. With a live model in Settings &gt; Transcription, the text appears here as people speak.</p>}
      </section>
      {shown && (transcript || waiting) && (
        <section style={cardStyle} aria-label="Transcript of the meeting">
          {transcript
            ? <TranscriptReader key={`${shown.id}/${transcript.file}/${transcript.name}/${transcript.sha256}`} meetingId={shown.id} title={shown.title} transcript={transcript}
              canName={transcript.final && !shown.in_digest} onNamed={refetch} participants={shown.participants ?? []}
              onClose={() => { if (pickedMeeting) setPicked(null); else setClosed(shown.id); }} />
            : <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{shown.title}: the transcript appears here when it is ready.</p>}
        </section>
      )}
      <section style={cardStyle} aria-label="Meetings in the queue">
        <h3 style={headingStyle}>Queue</h3>
        {error && <p role="alert" style={{ margin: 0, color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{error}</p>}
        {!data && !error && <LoadingSpinner text="Loading meetings..." />}
        {data && <MeetingQueueList job={data} onChanged={refetch} onRead={(meeting, file) => setPicked({ meeting, file })} />}
      </section>
    </div>
  );
}
