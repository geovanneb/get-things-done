import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiPost } from '@/utils/api';
import { microphoneAccess, reportRecording } from '@/utils/desktop';
import { BYTES_PER_SECOND, RecordingUploader, type SendResult } from '@/utils/recordingUpload';
import type { QueuedMeeting } from '@/types';

/**
 * The recorder, above the routes, so moving around the dashboard never stops it. The microphone goes to an AudioWorklet
 * at 16 kHz; each block goes to the server (see RecordingUploader). The page shows what was captured and what was
 * saved, because only saved audio survives a crash of the page; a gap in the capture is shown, never hidden.
 */

export interface RecordingOptions { title: string; date: string; deviceId: string; voiceCleanup: boolean }

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'saving' | 'failed';

/** Decided at once, not on the next render: two clicks can never start or stop twice. */
type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'discarding';

export interface RecorderState {
  status: RecorderStatus;
  meetingId: string | null;
  title: string;
  /** Seconds since recording started, of audio captured, and of audio the server stored. */
  elapsed: number;
  captured: number;
  saved: number;
  /** Seconds the microphone gave nothing while the clock ran, for example while the computer slept. */
  gap: number;
  /** The loudest sound in the last moment, 0 to 1. */
  level: number;
  /** Something the user should know right now. */
  warning: string | null;
  error: string | null;
  /** The last recording that was saved, to say so. */
  notice: string | null;
}

interface RecorderContextValue extends RecorderState {
  active: boolean;
  start: (options: RecordingOptions) => Promise<void>;
  stop: () => Promise<void>;
  discard: () => Promise<void>;
  dismiss: () => void;
}

const idle: RecorderState = { status: 'idle', meetingId: null, title: '', elapsed: 0, captured: 0, saved: 0, gap: 0, level: 0, warning: null, error: null, notice: null };
const RecorderContext = createContext<RecorderContextValue | null>(null);

/** No sound above this for this long: the microphone is probably the wrong one, or muted. */
const SILENCE_LEVEL = 0.003;
const SILENCE_MS = 30_000;
/** A gap under this is only timing. */
const GAP_SECONDS = 3;
/** Saved in blocks this far apart, so a crash of the page costs seconds. */
const SEND_EVERY_MS = 5000;

interface Session {
  meetingId: string;
  token: string;
  generation: string;
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
  uploader: RecordingUploader;
  startedAt: number;
  lastSound: number;
  lastBlock: number;
  timer: ReturnType<typeof setInterval>;
}

async function sendBlock(meetingId: string, token: string, offset: number, block: Uint8Array): Promise<SendResult> {
  const res = await fetch(`/api/meeting-queue/${meetingId}/recording?offset=${offset}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Recording-Token': token },
    body: block as unknown as BodyInit,
  });
  if (res.ok) return { ok: true, offset: ((await res.json()) as { offset: number }).offset };
  // The server is restarting, or busy for a moment: the audio waits here.
  if (res.status >= 500 && res.status !== 507) return { ok: false, retry: true };
  if (res.status === 429) return { ok: false, retry: true };
  const body = await res.json().catch(() => ({})) as { message?: string; details?: { offset?: number } };
  return { ok: false, retry: false, message: body.message ?? `The server refused the audio (${res.status})`, offset: body.details?.offset };
}

function microphoneMessage(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError') return 'The microphone is blocked. Allow it for this app in your browser or system settings, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app, or cannot be opened.';
  return (err as Error)?.message || 'The recording could not start.';
}

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecorderState>(idle);
  const session = useRef<Session | null>(null);
  const phase = useRef<Phase>('idle');
  const stopping = useRef<Promise<void> | null>(null);
  const update = useCallback((patch: Partial<RecorderState>) => setState((s) => ({ ...s, ...patch })), []);

  // A reloaded page holds no recording, whatever the app still thinks.
  useEffect(() => { reportRecording(false); }, []);

  /** The microphone goes at once. The app stays protected until `ended`, when the audio is safe. */
  const release = useCallback((s: Session) => {
    clearInterval(s.timer);
    s.node.port.onmessage = null;
    s.node.disconnect();
    for (const track of s.stream.getTracks()) track.stop();
    void s.context.close().catch(() => {});
    session.current = null;
  }, []);

  const ended = useCallback(() => {
    phase.current = 'idle';
    stopping.current = null;
    reportRecording(false);
  }, []);

  const start = useCallback(async ({ title, date, deviceId, voiceCleanup }: RecordingOptions) => {
    if (phase.current !== 'idle') return;
    phase.current = 'starting';
    reportRecording(true);
    update({ ...idle, status: 'starting', title });
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let created: string | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Recording works when the dashboard is opened on this computer, at localhost.');
      const access = await microphoneAccess();
      if (access !== 'granted') throw new Error(access);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1, echoCancellation: voiceCleanup, noiseSuppression: voiceCleanup, autoGainControl: voiceCleanup,
        },
      });
      context = new AudioContext({ sampleRate: 16_000 });
      // Never store audio under the wrong rate: a browser that cannot do 16 kHz is told so.
      if (context.sampleRate !== 16_000) throw new Error('This browser cannot record at 16 kHz. Use the desktop app, Chrome or Edge.');
      await context.audioWorklet.addModule('/recorder-worklet.js');
      const node = new AudioWorkletNode(context, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const source = context.createMediaStreamSource(stream);
      const silent = context.createGain();
      silent.gain.value = 0; // keeps the graph running; the microphone is never played back
      source.connect(node);
      node.connect(silent);
      silent.connect(context.destination);

      // The meeting comes last, so a blocked microphone leaves nothing behind.
      const meeting = await apiPost<QueuedMeeting>('/api/meeting-queue', { title, meeting_date: date });
      created = meeting.id;
      const token = crypto.randomUUID();
      const opened = await apiPost<{ generation: string; offset: number }>(`/api/meeting-queue/${meeting.id}/recording`, { token });

      const now = Date.now();
      const uploader = new RecordingUploader({ send: (offset, block) => sendBlock(meeting.id, token, offset, block) });
      const flush = () => uploader.flush().catch((err: Error) => update({ warning: err.message }));
      const running: Session = {
        meetingId: meeting.id, token, generation: opened.generation, stream, context, node, uploader,
        startedAt: now, lastSound: now, lastBlock: now, timer: setInterval(() => undefined, 60_000),
      };
      session.current = running;
      phase.current = 'running';
      let level = 0;
      node.port.onmessage = (event: MessageEvent<{ samples?: ArrayBuffer; peak?: number }>) => {
        if (!event.data.samples) return;
        const at = Date.now();
        running.lastBlock = at;
        level = event.data.peak ?? 0;
        if (level > SILENCE_LEVEL) running.lastSound = at;
        uploader.add(new Uint8Array(event.data.samples));
      };
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => update({ warning: 'The microphone went away. Stop to save what was recorded.' }));
        track.addEventListener('mute', () => update({ warning: 'The microphone stopped giving sound. Stop to save what was recorded.' }));
      }
      context.addEventListener('statechange', () => {
        if (session.current === running && running.context.state === 'suspended') void running.context.resume().catch(() => {});
      });
      clearInterval(running.timer);
      let sent = now;
      running.timer = setInterval(() => {
        const at = Date.now();
        if (at - sent >= SEND_EVERY_MS) { sent = at; void flush(); }
        const elapsed = (at - running.startedAt) / 1000;
        const captured = uploader.captured / BYTES_PER_SECOND;
        const gap = elapsed - captured > GAP_SECONDS ? elapsed - captured : 0;
        // Audio at risk comes first.
        let warning: string | null = null;
        if (uploader.unsaved > 30 * BYTES_PER_SECOND) warning = `The server is not answering: ${Math.round(uploader.unsaved / BYTES_PER_SECOND)} s of audio waits in this page and is lost if it closes.`;
        else if (at - running.lastBlock > 5000) warning = 'No audio is arriving from the microphone.';
        else if (at - running.lastSound > SILENCE_MS) warning = 'No sound for a while. Is this the right microphone, and is it muted?';
        if (uploader.failed) {
          if (phase.current === 'stopping') return; // Stop is on it, and says what happened
          release(running);
          ended();
          update({ status: 'failed', error: `${uploader.failed} It is on the Routines page, to finish or discard.`, warning: null, saved: uploader.saved / BYTES_PER_SECOND, level: 0 });
          return;
        }
        setState((s) => (s.status !== 'recording' ? s : { ...s, elapsed, captured, saved: uploader.saved / BYTES_PER_SECOND, gap, level, warning: warning ?? (s.warning?.startsWith('The microphone went') ? s.warning : null) }));
      }, 1000);
      update({ status: 'recording', meetingId: meeting.id });
    } catch (err) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => {});
      // A meeting that never got its recording is not left behind.
      if (created) await fetch(`/api/meeting-queue/${created}`, { method: 'DELETE' }).catch(() => {});
      ended();
      update({ ...idle, status: 'failed', error: microphoneMessage(err), title });
    }
  }, [ended, release, update]);

  const stop = useCallback((): Promise<void> => {
    if (stopping.current) return stopping.current;
    const s = session.current;
    if (!s || phase.current !== 'running') return Promise.resolve();
    phase.current = 'stopping';
    const run = async () => {
      update({ status: 'saving', warning: null });
      // The last moments still in the worklet, then everything to the server, then the recording is sealed.
      const complete = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2000);
        const previous = s.node.port.onmessage;
        s.node.port.onmessage = (event: MessageEvent<{ done?: boolean }>) => {
          previous?.call(s.node.port, event);
          if (event.data.done) { clearTimeout(timeout); resolve(true); }
        };
        s.node.port.postMessage('stop');
      });
      const { uploader, meetingId, token, generation, startedAt } = s;
      const gap = (Date.now() - startedAt) / 1000 - uploader.captured / BYTES_PER_SECOND;
      release(s);
      const showSaved = setInterval(() => update({ saved: uploader.saved / BYTES_PER_SECOND }), 1000);
      await uploader.flush().catch(() => {});
      clearInterval(showSaved);
      if (uploader.failed) {
        update({ status: 'failed', error: `${uploader.failed} It is on the Routines page, to finish or discard.` });
        return;
      }
      await apiPost(`/api/meeting-queue/${meetingId}/recording/finish`, { token, offset: uploader.saved, generation, queue: true });
      const notCaptured = gap > 90 ? `About ${Math.round(gap / 60)} min of the meeting was not captured.` : gap > GAP_SECONDS ? `About ${Math.round(gap)} s of the meeting was not captured.` : '';
      const missing = [notCaptured, complete ? '' : 'The last moments may be missing.'].filter(Boolean).map((m) => ` ${m}`).join('');
      setState((current) => ({ ...idle, notice: `"${current.title}" is saved and waits for its transcript.${missing}` }));
    };
    const running = run()
      .catch((err: Error) => update({ status: 'failed', error: `${err.message} The audio is saved: finish it on the Routines page.` }))
      .finally(ended);
    stopping.current = running;
    return running;
  }, [ended, release, update]);

  const discard = useCallback(async () => {
    if (phase.current === 'starting' || phase.current === 'stopping' || phase.current === 'discarding') return;
    phase.current = 'discarding';
    const s = session.current;
    if (s) { s.uploader.cancel(); release(s); }
    const id = s?.meetingId ?? state.meetingId;
    const res = id ? await fetch(`/api/meeting-queue/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    ended();
    if (id && !res?.ok) {
      update({ status: 'failed', error: 'The recording could not be deleted just now. It is on the Routines page: remove it there.', warning: null });
      return;
    }
    setState(idle);
  }, [ended, release, state.meetingId, update]);

  const dismiss = useCallback(() => setState(idle), []);

  const active = state.status === 'starting' || state.status === 'recording' || state.status === 'saving';
  useEffect(() => {
    if (!active) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  const value = useMemo(() => ({ ...state, active, start, stop, discard, dismiss }), [state, active, start, stop, discard, dismiss]);
  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}

export function useRecorder(): RecorderContextValue {
  const value = useContext(RecorderContext);
  if (!value) throw new Error('useRecorder needs a RecordingProvider');
  return value;
}
