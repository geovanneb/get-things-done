import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onRecordingCommand } from '@/utils/desktop';
import { RecordMeetingModal } from './RecordMeetingModal';
import { useRecorder } from './RecordingProvider';

interface RecordLauncher {
  /** Opens the record dialog. Does nothing while a recording runs: there is one at a time. */
  openRecordDialog: () => void;
}

const LauncherContext = createContext<RecordLauncher | null>(null);

/**
 * One record dialog for every way in: the top bar, ⌘K and the desktop app's menu-bar menu. The dialog's content stays
 * in RecordMeetingModal; this only decides when it opens, and stops a recording when the menu asks.
 */
export function RecordLauncherProvider({ children }: { children: React.ReactNode }) {
  const recorder = useRecorder();
  const [open, setOpen] = useState(false);
  // The menu's commands arrive outside React; they act on the recorder as it is now.
  const latest = useRef(recorder);
  latest.current = recorder;

  const openRecordDialog = useCallback(() => {
    if (!latest.current.active) setOpen(true);
  }, []);

  useEffect(() => onRecordingCommand((command) => {
    if (command === 'open') openRecordDialog();
    else if (latest.current.status === 'recording') void latest.current.stop();
  }), [openRecordDialog]);

  const value = useMemo(() => ({ openRecordDialog }), [openRecordDialog]);
  return (
    <LauncherContext.Provider value={value}>
      {children}
      <RecordMeetingModal isOpen={open} onClose={() => setOpen(false)} />
    </LauncherContext.Provider>
  );
}

export function useRecordLauncher(): RecordLauncher {
  const launcher = useContext(LauncherContext);
  if (!launcher) throw new Error('useRecordLauncher needs RecordLauncherProvider');
  return launcher;
}
