import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '@/utils/api';
import { desktopBridge, microphoneAccess, reportLanguageMenu, reportRecording, type SuggestedLanguage } from '@/utils/desktop';
import { useDataVersion } from '@/store';
import { mixSources } from '@/utils/recordingMix';
import { BYTES_PER_SECOND, RecordingUploader, type SendResult } from '@/utils/recordingUpload';
import type { MeetingParticipant, QueuedMeeting, SpokenLanguage, Transcription } from '@/types';

/**
 * The recorder, above the routes, so moving around the dashboard never stops it. The microphone goes to an AudioWorklet
 * at 16 kHz; each block goes to the server (see RecordingUploader). The page shows what was captured and what was
 * saved, because only saved audio survives a crash of the page; a gap in the capture is shown, never hidden.
 */

export interface RecordingOptions { title: string; date: string; participants: MeetingParticipant[]; deviceId: string; voiceCleanup: boolean; systemAudio: boolean }

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
  /** The computer's own sound (the other people in a call), when it is recorded too. Null when it is not. */
  systemLevel: number | null;
  /** Something the user should know right now. */
  warning: string | null;
  /** What changed for good during this recording, such as the computer's sound no longer being recorded. */
  lost: string[];
  /** The language being spoken, as this recording's transcripts should take it: `auto` detects it for each part. */
  language: string;
  /** What can be chosen: the languages of the chosen model. Empty when they could not be read. */
  languages: SpokenLanguage[];
  /** A change of language did not reach the server. */
  languageError: string | null;
  /** A spoken language that sounds more likely than the one set, from the live transcript; null when there is none. */
  suggestion: SuggestedLanguage | null;
  error: string | null;
  /** The last recording that was saved, to say so. */
  notice: string | null;
  /** That meeting, so its transcript can be opened. */
  lastMeetingId: string | null;
}

interface RecorderContextValue extends RecorderState {
  active: boolean;
  start: (options: RecordingOptions) => Promise<void>;
  stop: () => Promise<void>;
  setLanguage: (language: string) => Promise<void>;
  /** Switch to the suggested language (`id` of the suggestion shown), or keep the one set. */
  answerSuggestion: (answer: 'switch' | 'keep', id: string) => Promise<void>;
  discard: () => Promise<void>;
  dismiss: () => void;
}

const idle: RecorderState = { status: 'idle', meetingId: null, title: '', elapsed: 0, captured: 0, saved: 0, gap: 0, level: 0, systemLevel: null, warning: null, lost: [], language: 'auto', languages: [], languageError: null, suggestion: null, error: null, notice: null, lastMeetingId: null };
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
  /** The computer's sound, when recorded too. */
  system: MediaStream | null;
  context: AudioContext;
  node: AudioWorkletNode;
  uploader: RecordingUploader;
  startedAt: number;
  /** When the microphone itself, not the mix, last gave sound. */
  lastSound: number;
  lastBlock: number;
  timer: ReturnType<typeof setInterval>;
  stopListening?: () => void;
  /** One change of language at a time, in the order they were made. */
  languageChange: Promise<void>;
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

/**
 * The computer's own sound, through the desktop app: on Windows, and on a Mac from macOS 14.2, which asks once for
 * System Audio Recording. Only the audio is kept; the picture the system hands over with it is stopped at once.
 */
async function captureSystemAudio(): Promise<MediaStream> {
  const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }).catch((err: unknown) => {
    throw new Error((err as DOMException)?.name === 'NotAllowedError'
      ? "The computer's sound is blocked, so only the microphone is recorded. Allow it for Get Things Done in the system's privacy settings (on a Mac: System Settings > Privacy & Security > System Audio Recording), then start again."
      : "The computer's sound cannot be recorded here, so only the microphone is recorded.");
  });
  for (const track of display.getVideoTracks()) track.stop();
  const audio = display.getAudioTracks().filter((t) => t.readyState === 'live');
  if (audio.length === 0) throw new Error("The computer's sound cannot be recorded here, so only the microphone is recorded.");
  return new MediaStream(audio);
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
  /**
   * Answers to a suggestion and changes of language: how many were made (a read begun before one is not used), and
   * how many are still on their way (no read is used meanwhile; the suggestion is read again when they are done).
   */
  const answered = useRef(0);
  const pendingAnswers = useRef(0);
  const [answersDone, setAnswersDone] = useState(0);
  const stopping = useRef<Promise<void> | null>(null);
  const update = useCallback((patch: Partial<RecorderState>) => setState((s) => ({ ...s, ...patch })), []);

  // A reloaded page holds no recording, whatever the app still thinks.
  useEffect(() => { reportRecording(false); }, []);

  /** The microphone goes at once. The app stays protected until `ended`, when the audio is safe. */
  const release = useCallback((s: Session) => {
    clearInterval(s.timer);
    s.stopListening?.();
    s.node.port.onmessage = null;
    s.node.disconnect();
    for (const track of [...s.stream.getTracks(), ...(s.system?.getTracks() ?? [])]) track.stop();
    void s.context.close().catch(() => {});
    session.current = null;
  }, []);

  const ended = useCallback(() => {
    phase.current = 'idle';
    stopping.current = null;
    reportRecording(false);
  }, []);

  const start = useCallback(async ({ title, date, participants, deviceId, voiceCleanup, systemAudio }: RecordingOptions) => {
    if (phase.current !== 'idle') return;
    phase.current = 'starting';
    reportRecording(true);
    update({ ...idle, status: 'starting', title });
    let stream: MediaStream | null = null;
    let system: MediaStream | null = null;
    let context: AudioContext | null = null;
    let created: string | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Recording works when the dashboard is opened on this computer, at localhost.');
      // First, while the click still counts: the system asks for this only with a fresh click.
      let systemNote: string | null = null;
      if (systemAudio) {
        system = await captureSystemAudio().catch((err: Error) => { systemNote = err.message; return null; });
      }
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
      const meters = mixSources(context, node, stream, system);
      const silent = context.createGain();
      silent.gain.value = 0; // keeps the graph running; nothing recorded is ever played back
      node.connect(silent);
      silent.connect(context.destination);

      // The meeting comes last, so a blocked microphone leaves nothing behind.
      const meeting = await apiPost<QueuedMeeting>('/api/meeting-queue', { title, meeting_date: date, participants });
      created = meeting.id;
      const token = crypto.randomUUID();
      const opened = await apiPost<{ generation: string; offset: number; language: string }>(`/api/meeting-queue/${meeting.id}/recording`, { token });
      // Optional: without the list the recording goes on, with its language as it started.
      const overview = await apiGet<Transcription>('/api/transcription').catch(() => null);
      const languages = overview?.models.find((m) => m.id === overview.settings.model)?.language_options ?? [];

      const now = Date.now();
      const uploader = new RecordingUploader({ send: (offset, block) => sendBlock(meeting.id, token, offset, block) });
      const flush = () => uploader.flush().catch((err: Error) => update({ warning: err.message }));
      const running: Session = {
        meetingId: meeting.id, token, generation: opened.generation, stream, system, context, node, uploader,
        startedAt: now, lastSound: now, lastBlock: now, timer: setInterval(() => undefined, 60_000), languageChange: Promise.resolve(),
      };
      session.current = running;
      phase.current = 'running';
      // What changed for good stays listed until the end, each on its own line.
      const lost: string[] = systemNote ? [systemNote] : [];
      const note = (text: string) => { if (!lost.includes(text)) lost.push(text); };
      let systemOn = Boolean(system);
      node.port.onmessage = (event: MessageEvent<{ samples?: ArrayBuffer; peak?: number }>) => {
        if (!event.data.samples) return;
        const at = Date.now();
        running.lastBlock = at;

        uploader.add(new Uint8Array(event.data.samples));
      };
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => note('The microphone went away. Stop to save what was recorded.'));
        const muted = 'The microphone stopped giving sound. Stop to save what was recorded.';
        track.addEventListener('mute', () => note(muted));
        // It came back: the banner says so, and that a moment may be missing, instead of a warning that no longer holds.
        track.addEventListener('unmute', () => {
          const at = lost.indexOf(muted);
          if (at >= 0) lost.splice(at, 1);
          note('The microphone stopped for a moment and came back; that moment may be missing.');
        });
      }
      for (const track of system?.getAudioTracks() ?? []) {
        // The microphone goes on: only the other side of a call is missing from here on.
        track.addEventListener('ended', () => { systemOn = false; note("The computer's sound stopped being recorded. The microphone goes on."); });
      }
      // It may have ended while the microphone and the server were being set up.
      if (system && system.getAudioTracks().every((t) => t.readyState === 'ended')) {
        systemOn = false;
        note("The computer's sound stopped being recorded. The microphone goes on.");
      }
      // The microphone's own silence, read often: the other side of a call must not hide a muted microphone.
      const listen = setInterval(() => { if (meters.microphone() > SILENCE_LEVEL) running.lastSound = Date.now(); }, 200);
      running.stopListening = () => clearInterval(listen);
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
        else if (at - running.lastSound > SILENCE_MS) warning = 'No sound from the microphone for a while. Is it the right one, and is it muted?';
        if (uploader.failed) {
          if (phase.current === 'stopping') return; // Stop is on it, and says what happened
          release(running);
          ended();
          update({ status: 'failed', error: `${uploader.failed} See the meeting on the Meetings page.`, warning: null, saved: uploader.saved / BYTES_PER_SECOND, level: 0 });
          return;
        }
        const systemLevel = meters.system && systemOn ? meters.system() : null;
        setState((s) => (s.status !== 'recording' ? s : { ...s, elapsed, captured, saved: uploader.saved / BYTES_PER_SECOND, gap, level: meters.microphone(), systemLevel, warning, lost: [...lost] }));
      }, 1000);
      update({ status: 'recording', meetingId: meeting.id, language: opened.language, languages });
    } catch (err) {
      for (const track of [...(stream?.getTracks() ?? []), ...(system?.getTracks() ?? [])]) track.stop();
      void context?.close().catch(() => {});
      // A meeting that never got its recording is not left behind.
      if (created) await fetch(`/api/meeting-queue/${created}`, { method: 'DELETE' }).catch(() => {});
      ended();
      update({ ...idle, status: 'failed', error: microphoneMessage(err), title });
    }
  }, [ended, release, update]);

  /** A change of language or an answer is done: reads made meanwhile are not used, and the suggestion is read again. */
  const settled = useCallback(() => {
    pendingAnswers.current = Math.max(0, pendingAnswers.current - 1);
    answered.current++;
    setAnswersDone((n) => n + 1);
  }, []);

  const setLanguage = useCallback((language: string): Promise<void> => {
    // Of the recording it was asked for: it never reaches the next one.
    const s = session.current;
    if (!s || phase.current !== 'running') return Promise.resolve();
    answered.current++;
    pendingAnswers.current++;
    const change = async () => {
      if (session.current !== s || phase.current !== 'running') return;
      try {
        const changed = await apiPut<{ language: string }>(`/api/meeting-queue/${s.meetingId}/recording/language`, { token: s.token, language });
        // What was heard before says nothing about the language set now: the server dropped the suggestion too.
        if (session.current === s) update({ language: changed.language, languageError: null, suggestion: null });
      } catch (err) {
        if (session.current === s) update({ languageError: `The language was not changed: ${(err as Error).message}` });
      }
    };
    s.languageChange = s.languageChange.then(change).finally(settled);
    return s.languageChange;
  }, [update, settled]);

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
        update({ status: 'failed', error: `${uploader.failed} See the meeting on the Meetings page.` });
        return;
      }
      await apiPost(`/api/meeting-queue/${meetingId}/recording/finish`, { token, offset: uploader.saved, generation, queue: true });
      const notCaptured = gap > 90 ? `About ${Math.round(gap / 60)} min of the meeting was not captured.` : gap > GAP_SECONDS ? `About ${Math.round(gap)} s of the meeting was not captured.` : '';
      const missing = [notCaptured, complete ? '' : 'The last moments may be missing.'].filter(Boolean).map((m) => ` ${m}`).join('');
      setState((current) => ({ ...idle, notice: `"${current.title}" is saved and waits for its transcript.${missing}`, lastMeetingId: meetingId }));
    };
    const running = run()
      .catch((err: Error) => update({ status: 'failed', error: `${err.message} The audio is saved: finish it on the Meetings page.` }))
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
      update({ status: 'failed', error: 'The recording could not be deleted just now. It is on the Meetings page: remove it there.', warning: null });
      return;
    }
    setState(idle);
  }, [ended, release, state.meetingId, update]);

  const dismiss = useCallback(() => setState((s) => ({ ...idle, lastMeetingId: s.lastMeetingId })), []);

  const active = state.status === 'starting' || state.status === 'recording' || state.status === 'saving';
  useEffect(() => {
    if (!active) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  // The suggested spoken language, from the live transcript in this dashboard: read when it changes, and every few
  // seconds in case a notice was missed.
  const { status, language, languages, meetingId, suggestion } = state;
  const liveVersion = useDataVersion('live-transcript');
  useEffect(() => {
    if (status !== 'recording' || !meetingId) { if (suggestion) update({ suggestion: null }); return undefined; }
    let cancelled = false;
    let latest = 0;
    const read = async () => {
      // Only the newest read counts, and none that began before an answer or a change of language: an older one
      // would bring back a suggestion that was just answered.
      const asked = ++latest;
      const revision = answered.current;
      const live = await apiGet<{ suggestion?: { id: string; language: string; mode: 'mismatch' | 'auto' } | null }>(`/api/meeting-queue/${meetingId}/recording/transcript?from=999999999`).catch(() => null);
      if (cancelled || !live || asked !== latest || revision !== answered.current || pendingAnswers.current > 0 || session.current?.meetingId !== meetingId) return;
      const s = live.suggestion ?? null;
      const label = s ? languages.find((l) => l.id === s.language)?.label ?? s.language : '';
      const next = s ? { id: s.id, language: s.language, label, mode: s.mode } : null;
      setState((st) => (st.suggestion?.id === next?.id && st.suggestion?.label === next?.label ? st : { ...st, suggestion: next }));
    };
    void read();
    const timer = setInterval(() => { void read(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `suggestion` is what this sets
  }, [status, meetingId, liveVersion, languages, answersDone]);

  const answerSuggestion = useCallback((answer: 'switch' | 'keep', id: string): Promise<void> => {
    const s = session.current;
    if (!s || phase.current !== 'running') return Promise.resolve();
    answered.current++;
    pendingAnswers.current++;
    // In the same line as changes made by hand, so they reach the server in the order they were made.
    const send = async () => {
      if (session.current !== s || phase.current !== 'running') return;
      try {
        if (answer === 'switch') {
          const changed = await apiPut<{ language: string }>(`/api/meeting-queue/${s.meetingId}/recording/language`, { token: s.token, suggestion: id });
          if (session.current === s) update({ language: changed.language, languageError: null, suggestion: null });
        } else {
          await apiPost(`/api/meeting-queue/${s.meetingId}/recording/language/keep`, { token: s.token, suggestion: id });
          if (session.current === s) update({ suggestion: null });
        }
      } catch (err) {
        // Refused: it is no longer the current suggestion (the language was changed meanwhile); read it again.
        if (session.current === s) update({ suggestion: null, languageError: answer === 'switch' ? `The language was not changed: ${(err as Error).message}` : null });
      }
    };
    s.languageChange = s.languageChange.then(send).finally(settled);
    return s.languageChange;
  }, [update, settled]);

  // In a browser, a suggestion made while the tab is in the background is said once by the system, if allowed. The
  // desktop app says it from the menu bar instead.
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (!suggestion || notified.current === suggestion.id || desktopBridge() || typeof Notification === 'undefined') return;
    notified.current = suggestion.id;
    if (!document.hidden || Notification.permission !== 'granted') return;
    const current = languages.find((l) => l.id === language)?.label ?? language;
    new Notification(suggestion.mode === 'auto' ? `Most speech sounds like ${suggestion.label}` : `This sounds like ${suggestion.label}`, {
      body: suggestion.mode === 'auto' ? `Set ${suggestion.label} for a more accurate transcript.` : `The recording is set to ${current}. Open the dashboard to switch.`,
      tag: `gtd-language-${suggestion.id}`,
    });
  }, [suggestion, language, languages]);

  // The menu bar shows the usual languages and the current one, so a meeting can be switched without opening the window,
  // and a suggestion, which it also says once.
  useEffect(() => {
    if (status !== 'recording' || languages.length === 0) return;
    const shown = languages.filter((l) => l.common || l.id === language).map(({ id, label }) => ({ id, label }));
    reportLanguageMenu({ current: language, options: [{ id: 'auto', label: 'Auto' }, ...shown], ...(suggestion ? { suggested: suggestion } : {}) });
  }, [status, language, languages, suggestion]);

  const value = useMemo(() => ({ ...state, active, start, stop, setLanguage, answerSuggestion, discard, dismiss }), [state, active, start, stop, setLanguage, answerSuggestion, discard, dismiss]);
  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}

export function useRecorder(): RecorderContextValue {
  const value = useContext(RecorderContext);
  if (!value) throw new Error('useRecorder needs a RecordingProvider');
  return value;
}
