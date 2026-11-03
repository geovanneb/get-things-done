import React from 'react';
import { Link } from 'react-router-dom';
import Button from '@/components/common/Button';
import { apiPost } from '@/utils/api';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { useRecorder } from '@/components/recording/RecordingProvider';
import type { AppUpdateStatus } from '@/types';

/** How often the page asks this dashboard what it found and what runs (a local question); the internet, at most daily. */
const REFRESH_MS = 60 * 1000;

/**
 * A newer version is out: said once per version, at the top of every page, until Later. Never while something
 * important runs (a recording, a transcription, an AI tool run). The desktop app that updates itself says it with its
 * own dialog instead (until it can say it here).
 */
export default function UpdateBanner() {
  const [tick, setTick] = React.useState(0);
  // Asked again as soon as a run or a transcription starts or ends anywhere (an analysis changes its update, a task run
  // its task), so the notice gives way at once; the minute's poll catches the rest.
  const updates = useDataVersion('context-updates');
  const tasks = useDataVersion('tasks');
  const transcription = useDataVersion('transcription');
  const { data, refetch } = useApi<AppUpdateStatus>('/api/app/update', [tick, updates, tasks, transcription]);
  const recorder = useRecorder();
  const [hidden, setHidden] = React.useState<string | null>(null);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  if (!data?.newer || !data.latest || data.latest === data.dismissed || data.latest === hidden || recorder.active || data.busy) return null;
  if (data.how === 'self') return null;
  const later = () => {
    setHidden(data.latest);
    void apiPost('/api/app/update/dismiss', { version: data.latest }).then(refetch, () => {});
  };
  const link: React.CSSProperties = { fontSize: 'var(--text-sm)', fontWeight: 600 };
  return (
    <div role="status" aria-label="A new version is available" style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 16px',
      borderBottom: '1px solid var(--color-border)', background: 'var(--color-accent-subtle)', fontSize: 'var(--text-sm)',
    }}>
      <span style={{ flex: '1 1 240px' }}>Get Things Done {data.latest} is available.</span>
      {data.notes_url && <a href={data.notes_url} target="_blank" rel="noreferrer" style={link}>What&apos;s new</a>}
      {data.how === 'manual' && data.kind === 'desktop'
        ? <a href={data.release_url} target="_blank" rel="noreferrer" style={link}>Download</a>
        : <Link to="/settings#updates" style={link}>How to update</Link>}
      <Button size="sm" variant="ghost" onClick={later}>Later</Button>
    </div>
  );
}
