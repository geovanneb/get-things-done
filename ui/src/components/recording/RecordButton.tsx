import Button from '@/components/common/Button';
import { useRecordLauncher } from './RecordLauncher';
import { useRecorder } from './RecordingProvider';
import { MicIcon, RecordingPill } from './RecordingParts';

/**
 * Recording in the top bar, on every page: one click opens the record dialog, and while a recording runs the same place
 * shows it (red dot and time) with Stop. The corner banner keeps the details: what is saved, gaps and warnings.
 */
export function RecordButton() {
  const recorder = useRecorder();
  const { openRecordDialog } = useRecordLauncher();

  if (recorder.status === 'recording' || recorder.status === 'saving') {
    const saving = recorder.status === 'saving';
    return (
      <RecordingPill label={`Recording ${recorder.title}`} elapsed={recorder.elapsed} timeTitle={recorder.title} finishing={saving ? 'Saving…' : undefined}
        onStop={() => void recorder.stop()} stopLabel={`Stop and save the recording of ${recorder.title}`} stopTitle="Stop and save the recording" />
    );
  }

  const starting = recorder.status === 'starting';
  return (
    <Button variant="secondary" size="sm" onClick={openRecordDialog} disabled={starting}
      icon={<MicIcon />} aria-label="Record a meeting" title="Record a meeting">
      <span className="app-header__label app-header__label--record">{starting ? 'Starting…' : 'Record'}</span>
    </Button>
  );
}
