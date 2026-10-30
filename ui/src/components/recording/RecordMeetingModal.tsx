import type React from 'react';
import { useEffect, useState } from 'react';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import { useRecorder } from './RecordingProvider';
import { ParticipantsField } from '@/components/meetings/ParticipantsField';
import { systemAudioSupport } from '@/utils/desktop';
import { consentSentence, type RecordPrefill } from '@/utils/meetingParticipants';
import type { MeetingParticipant } from '@/types';

const inputStyle: React.CSSProperties = { padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'inherit' };
const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0 };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Starts a recording: what it is called, which microphone, and a reminder to tell the others, each time. */
export function RecordMeetingModal({ isOpen, onClose, prefill }: { isOpen: boolean; onClose: () => void; prefill: RecordPrefill | null }) {
  const { start } = useRecorder();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [voiceCleanup, setVoiceCleanup] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [systemSupport, setSystemSupport] = useState<string | null>(null);
  const [told, setTold] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // A new meeting each time: the last one's people must not reach this reminder.
    setTold(false);
    setTitle(prefill?.title ?? '');
    setDate(today());
    setParticipants(prefill?.participants ?? []);
    void systemAudioSupport().then(setSystemSupport);
    void navigator.mediaDevices?.enumerateDevices().then((all) => setDevices(all.filter((d) => d.kind === 'audioinput'))).catch(() => setDevices([]));
  }, [isOpen, prefill]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Record a meeting" size="sm">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 'var(--text-sm)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          Title
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </label>
        <ParticipantsField value={participants} onChange={(next) => { setParticipants(next); setTold(false); }} />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          Microphone
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} style={inputStyle}>
            <option value="">The system's default</option>
            {devices.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={voiceCleanup} onChange={(e) => setVoiceCleanup(e.target.checked)} />
          <span>Clean up the voice<br /><span style={hintStyle}>Good for a laptop microphone. Turn it off for a conference microphone, which usually does this itself.</span></span>
        </label>
        {systemSupport === 'yes' ? (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={systemAudio} onChange={(e) => setSystemAudio(e.target.checked)} />
            <span>Also record the computer&apos;s sound<br /><span style={hintStyle}>The other people in a video call, also when you wear headphones. The first time, the system asks to allow it.</span></span>
          </label>
        ) : (
          <p style={hintStyle}>{systemSupport ?? 'Only the microphone is recorded, so people heard through headphones are not.'}</p>
        )}
        <p style={hintStyle}>
          The audio is saved in your workspace as it
          arrives, and stays on this computer unless the workspace folder is synced. It is removed once its transcript is in a
          digest, unless Keep recordings is on in Settings.
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={told} onChange={(e) => setTold(e.target.checked)} />
          <span>{consentSentence(participants)}</span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!told || !date} onClick={() => { void start({ title: title.trim() || 'Recorded meeting', date, participants, deviceId, voiceCleanup, systemAudio: systemSupport === 'yes' && systemAudio }); onClose(); }}>Start recording</Button>
        </div>
      </div>
    </Modal>
  );
}
