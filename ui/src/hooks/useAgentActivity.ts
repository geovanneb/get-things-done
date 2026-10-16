import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../utils/api';
import type { AgentActivitySnapshot } from '../components/agentic/engine/activityTypes';

interface FileChangeEvent {
  type: 'change' | 'add' | 'unlink';
  path: string;
  timestamp: string;
}

interface UseAgentActivityResult {
  snapshot: AgentActivitySnapshot | null;
  error: string | null;
  loading: boolean;
  /** Wall-clock ms of the last real file-change event, 0 if none yet. */
  lastEventAt: number;
  refresh: () => void;
}

/**
 * Feeds the Agent Floor. Polls the activity snapshot on a slow interval as a
 * safety net, and refetches immediately whenever the file watcher reports a
 * change, so what is drawn tracks what is actually happening on disk.
 *
 * `onFileChange` is called for every watcher event, including ones that do not
 * change the snapshot — that is what drives the moment-to-moment animation.
 */
export function useAgentActivity(
  onFileChange: (path: string) => void,
  enabled: boolean,
): UseAgentActivityResult {
  const [snapshot, setSnapshot] = useState<AgentActivitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastEventAt, setLastEventAt] = useState(0);

  // Kept in a ref so the SSE effect never has to re-subscribe when the handler
  // identity changes on a re-render.
  const handlerRef = useRef(onFileChange);
  handlerRef.current = onFileChange;

  const fetchSnapshot = useCallback(async () => {
    try {
      const data = await apiGet<AgentActivitySnapshot>('/api/agent-activity');
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent activity.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 20000);
    return () => clearInterval(interval);
  }, [enabled, fetchSnapshot]);

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      source = new EventSource('/api/events');
    } catch {
      return;
    }

    const handle = (e: MessageEvent) => {
      let event: FileChangeEvent;
      try {
        event = JSON.parse(e.data) as FileChangeEvent;
      } catch {
        return;
      }
      handlerRef.current(event.path);
      setLastEventAt(Date.now());

      // Coalesce bursts — an agent writing several files in a row should cause
      // one refetch, not one per file.
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(fetchSnapshot, 700);
    };

    source.addEventListener('file_change', handle as EventListener);

    return () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      source?.removeEventListener('file_change', handle as EventListener);
      source?.close();
    };
  }, [enabled, fetchSnapshot]);

  return { snapshot, error, loading, lastEventAt, refresh: fetchSnapshot };
}
