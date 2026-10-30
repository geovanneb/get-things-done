import Button from '@/components/common/Button';
import { useRecordLauncher } from './RecordLauncher';
import { useRecorder } from './RecordingProvider';

/** m:ss under an hour, then h:mm:ss: short enough for the top bar. */
function timer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="4.5" y="1.25" width="4" height="6.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 6.25a4 4 0 0 0 8 0M6.5 10.25v1.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

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
      <div role="group" aria-label={`Recording ${recorder.title}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 28, padding: '0 4px 0 10px', borderRadius: 'var(--radius-md)', border: '1px solid color-mix(in oklch, var(--color-critical) 40%, transparent)', background: 'var(--color-critical-subtle)', flexShrink: 0 }}>
        <span aria-hidden="true" className={saving ? undefined : 'recording-dot'}
          style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-critical)', flexShrink: 0 }} />
        <span title={recorder.title} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--color-critical)', fontVariantNumeric: 'tabular-nums' }}>
          {saving ? 'Saving…' : timer(recorder.elapsed)}
        </span>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => void recorder.stop()}
          aria-label={`Stop and save the recording of ${recorder.title}`} title="Stop and save the recording"
          style={{ height: 22, padding: '0 8px', color: 'var(--color-critical)' }}>
          Stop
        </Button>
      </div>
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
