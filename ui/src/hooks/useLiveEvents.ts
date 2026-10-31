import { useEffect } from 'react';
import { useAppDispatch, DataScope } from '../store';
import { RECONNECT_DELAY_MS, streamTracker } from '../utils/liveEvents';

interface FileChangeEvent {
  type: 'change' | 'add' | 'unlink';
  path: string;
  timestamp: string;
}

/** Map a changed file path to the data slice it belongs to. */
export function scopeForPath(filePath: string): DataScope {
  const p = filePath.replace(/\\/g, '/');
  if (p.includes('/tasks/')) return 'tasks';
  if (p.includes('/stakeholders/')) return 'stakeholders';
  if (p.includes('/outputs/')) return 'outputs';
  if (p.includes('/context-updates/')) return 'context-updates';
  if (p.includes('/context/')) return 'context';
  if (p.includes('/routines/')) return 'routines';
  if (p.includes('/profile/')) return 'profile';
  return 'other';
}

/**
 * Subscribes once to the server's file-watcher stream and bumps the matching
 * data version, so open views refetch when the workspace changes on disk
 * (an agent editing task.md, a deliverable being written, and so on).
 */
export function useLiveEvents(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const stream = streamTracker();

    const handleFileChange = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as FileChangeEvent;
        dispatch({ type: 'DATA_CHANGED', payload: scopeForPath(event.path) });
      } catch {
        // Ignore malformed payloads
      }
    };

    // Back after a drop, or through at last: changes made meanwhile were never announced, so read everything once (#201).
    const handleConnected = () => {
      if (stream.connected()) dispatch({ type: 'ALL_DATA_CHANGED' });
    };

    // Model downloads live outside the workspace, so the server announces them itself.
    const handleTranscription = () => dispatch({ type: 'DATA_CHANGED', payload: 'transcription' });
    // More live transcript, or its status changed: the page reads on from its own number, so a missed notice costs nothing.
    const handleLive = () => dispatch({ type: 'DATA_CHANGED', payload: 'live-transcript' });

    // The browser retries a dropped stream by itself, but gives up for good on some errors (a failed restart,
    // for example). Then open a new one after a short wait.
    const handleError = () => {
      stream.failed();
      if (stopped || source?.readyState !== EventSource.CLOSED || retry) return;
      retry = setTimeout(() => {
        retry = null;
        open();
      }, RECONNECT_DELAY_MS);
    };

    const open = () => {
      source?.close();
      try {
        source = new EventSource('/api/events');
      } catch {
        return;
      }
      source.addEventListener('connected', handleConnected);
      source.addEventListener('file_change', handleFileChange as EventListener);
      source.addEventListener('transcription', handleTranscription);
      source.addEventListener('live-transcript', handleLive);
      source.addEventListener('error', handleError);
    };

    open();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [dispatch]);
}
