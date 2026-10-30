import { useEffect } from 'react';
import { useAppDispatch, DataScope } from '../store';

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
    try {
      source = new EventSource('/api/events');
    } catch {
      return;
    }

    const handleFileChange = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as FileChangeEvent;
        dispatch({ type: 'DATA_CHANGED', payload: scopeForPath(event.path) });
      } catch {
        // Ignore malformed payloads
      }
    };

    // Model downloads live outside the workspace, so the server announces them itself.
    const handleTranscription = () => dispatch({ type: 'DATA_CHANGED', payload: 'transcription' });

    source.addEventListener('file_change', handleFileChange as EventListener);
    source.addEventListener('transcription', handleTranscription);

    return () => {
      source?.removeEventListener('file_change', handleFileChange as EventListener);
      source?.removeEventListener('transcription', handleTranscription);
      source?.close();
    };
  }, [dispatch]);
}
