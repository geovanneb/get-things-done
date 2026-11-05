import Button from '@/components/common/Button';

/**
 * What every place that records the microphone shows, so they look and read the same: the microphone icon on the
 * button that starts, and while recording a red dot, the time and Stop (the top bar's Record, dictation in a field).
 */

/** m:ss under an hour, then h:mm:ss: short enough for the top bar. */
export function recordingTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="4.5" y="1.25" width="4" height="6.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 6.25a4 4 0 0 0 8 0M6.5 10.25v1.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

interface RecordingPillProps {
  /** The group's accessible name, e.g. "Recording Weekly sync". */
  label: string;
  elapsed: number;
  /** The time's tooltip, e.g. the meeting's title. */
  timeTitle?: string;
  /** Shown instead of the time while the recording is being finished (e.g. "Saving…"); Stop is then disabled. */
  finishing?: string;
  onStop: () => void;
  stopLabel: string;
  stopTitle: string;
}

/** A recording that runs: red dot, time, Stop. Styles in primitives.css (.gtd-recording-pill). */
export function RecordingPill({ label, elapsed, timeTitle, finishing, onStop, stopLabel, stopTitle }: RecordingPillProps) {
  return (
    <div role="group" aria-label={label} className="gtd-recording-pill">
      <span aria-hidden="true" className={finishing ? 'gtd-recording-pill__dot' : 'gtd-recording-pill__dot recording-dot'} />
      <span title={timeTitle} className="gtd-recording-pill__time">{finishing ?? recordingTimer(elapsed)}</span>
      <Button size="sm" variant="ghost" disabled={Boolean(finishing)} onClick={onStop} aria-label={stopLabel} title={stopTitle} className="gtd-recording-pill__stop">
        Stop
      </Button>
    </div>
  );
}
