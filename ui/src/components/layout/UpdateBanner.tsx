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
/** While the dashboard restarts for an update: how often it is asked, how long one ask may take, and when to worry. */
const RESTART_POLL_MS = 2000;
const RESTART_ASK_MS = 5000;
const RESTART_LATE_MS = 10 * 60_000;
const UPDATE_STARTED = 'gtd:update-started';

/** Settings started "Update and restart": the banner follows the restart on whatever page is open. */
export function updateStarted(version: string): void {
  window.dispatchEvent(new CustomEvent(UPDATE_STARTED, { detail: version }));
}

/** The update status, or null when the dashboard does not answer in time (it is stopped for the update). */
async function askStatus(): Promise<AppUpdateStatus | null> {
  try {
    const res = await fetch('/api/app/update', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(RESTART_ASK_MS) });
    return res.ok ? await res.json() as AppUpdateStatus : null;
  } catch { return null; }
}

/** The version this page was built from (null in a test run without the build). */
const PAGE_VERSION = typeof __GTD_VERSION__ === 'string' ? __GTD_VERSION__ : null;

/**
 * While an update restarts the dashboard (started here, or seen going): asks every couple of seconds, not answering
 * being expected, and reloads the page once the dashboard answers with no update going, so the page and the server
 * match, on the new version or, when the update did not finish, on the old one with its reason in Settings.
 */
function useRestartWatch(going: string | null): { restarting: string | null; late: boolean } {
  const [restarting, setRestarting] = React.useState<string | null>(null);
  const [late, setLate] = React.useState(false);
  React.useEffect(() => {
    const started = (e: Event) => setRestarting((e as CustomEvent<string>).detail);
    window.addEventListener(UPDATE_STARTED, started);
    return () => window.removeEventListener(UPDATE_STARTED, started);
  }, []);
  React.useEffect(() => { if (going) setRestarting((r) => r ?? going); }, [going]);
  React.useEffect(() => {
    if (!restarting) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const since = Date.now();
    const lateTimer = setTimeout(() => setLate(true), RESTART_LATE_MS);
    const tick = async () => {
      const s = await askStatus();
      if (stop) return;
      if (s && !s.installing) { window.location.reload(); return; }
      timer = setTimeout(() => void tick(), RESTART_POLL_MS);
    };
    timer = setTimeout(() => void tick(), Math.max(0, RESTART_POLL_MS - (Date.now() - since)));
    return () => { stop = true; clearTimeout(timer); clearTimeout(lateTimer); };
  }, [restarting]);
  return { restarting, late };
}

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
  const { restarting, late } = useRestartWatch(data?.installing ? data.latest : null);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  const bar: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 16px',
    borderBottom: '1px solid var(--color-border)', background: 'var(--color-accent-subtle)', fontSize: 'var(--text-sm)',
  };
  if (restarting) {
    return (
      <div role="status" aria-label="Updating" style={bar}>
        <span style={{ flex: '1 1 240px' }}>
          {late
            ? <>Get Things Done has not come back here yet. Run <code>gtd status</code> in a terminal to see whether it runs and on which port (<code>gtd open</code> opens it), or <code>gtd start</code> to start it; the update&apos;s log is in <code>~/.gtd/update.log</code>.</>
            : <>Updating Get Things Done to {restarting}… It stops and starts again; this page reconnects by itself.</>}
        </span>
      </div>
    );
  }
  // A global npm install updated under this page (from here, another tab or a terminal): the page was built from
  // another version than the dashboard runs now, and is out of date until reloaded.
  if (data?.kind === 'npm' && PAGE_VERSION && data.current !== PAGE_VERSION) {
    return (
      <div role="status" style={bar}>
        <span style={{ flex: '1 1 240px' }}>Get Things Done is now {data.current}. Reload this page to use it.</span>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
  if (!data?.newer || !data.latest || data.latest === data.dismissed || data.latest === hidden || recorder.active || data.busy || data.installing) return null;
  // Installed from Settings and waiting for a restart: said instead of offering it again.
  const installed = data.installed === data.latest;
  if (data.how === 'self') return null;
  const later = () => {
    setHidden(data.latest);
    void apiPost('/api/app/update/dismiss', { version: data.latest }).then(refetch, () => {});
  };
  const link: React.CSSProperties = { fontSize: 'var(--text-sm)', fontWeight: 600 };
  return (
    <div role="status" aria-label="A new version is available" style={bar}>
      <span style={{ flex: '1 1 240px' }}>{installed ? `Get Things Done ${data.latest} is installed. Restart it to finish.` : `Get Things Done ${data.latest} is available.`}</span>
      {data.notes_url && <a href={data.notes_url} target="_blank" rel="noreferrer" style={link}>What&apos;s new</a>}
      {data.how === 'manual' && data.kind === 'desktop'
        ? <a href={data.release_url} target="_blank" rel="noreferrer" style={link}>Download</a>
        : <Link to="/settings#updates" style={link}>{installed ? 'How to restart' : data.can_install ? 'Update and restart' : 'How to update'}</Link>}
      <Button size="sm" variant="ghost" onClick={later}>Later</Button>
    </div>
  );
}
