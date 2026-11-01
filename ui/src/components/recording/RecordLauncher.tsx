import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onRecordingCommand } from '@/utils/desktop';
import { RecordMeetingModal } from './RecordMeetingModal';
import { useRecorder } from './RecordingProvider';
import type { RecordPrefill } from '@/utils/meetingParticipants';

interface RecordLauncher {
  /** Opens the record dialog. Does nothing while a recording runs: there is one at a time. */
  openRecordDialog: () => void;
  /** The same, started from what is already known about the meeting. */
  openRecordDialogFor: (prefill: RecordPrefill) => void;
}

const LauncherContext = createContext<RecordLauncher | null>(null);

/**
 * One record dialog for every way in: the top bar, ⌘K and the desktop app's menu-bar menu. The dialog's content stays
 * in RecordMeetingModal; this only decides when it opens, and passes on what the menu asks of a running recording.
 */
export function RecordLauncherProvider({ children }: { children: React.ReactNode }) {
  const recorder = useRecorder();
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<RecordPrefill | null>(null);
  // The menu's commands arrive outside React; they act on the recorder as it is now.
  const latest = useRef(recorder);
  latest.current = recorder;

  const openRecordDialog = useCallback(() => {
    setPrefill(null);
    if (!latest.current.active) setOpen(true);
  }, []);
  const openRecordDialogFor = useCallback((next: RecordPrefill) => {
    setPrefill(next);
    if (!latest.current.active) setOpen(true);
  }, []);

  useEffect(() => onRecordingCommand((command) => {
    if (command === 'open') openRecordDialog();
    else if (command === 'stop') { if (latest.current.status === 'recording') void latest.current.stop(); }
    else if (command.startsWith('suggestion:')) {
      const [, answer, id] = command.split(':');
      void latest.current.answerSuggestion(answer as 'switch' | 'keep', id!);
    } else void latest.current.setLanguage(command.slice('language:'.length));
  }), [openRecordDialog]);

  const value = useMemo(() => ({ openRecordDialog, openRecordDialogFor }), [openRecordDialog, openRecordDialogFor]);
  return (
    <LauncherContext.Provider value={value}>
      {children}
      <RecordMeetingModal isOpen={open} onClose={() => setOpen(false)} prefill={prefill} />
    </LauncherContext.Provider>
  );
}

export function useRecordLauncher(): RecordLauncher {
  const launcher = useContext(LauncherContext);
  if (!launcher) throw new Error('useRecordLauncher needs RecordLauncherProvider');
  return launcher;
}
