import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@/components/common/Button';
import { Select } from '@/components/common/Input';
import { apiGet, errorMessage } from '@/utils/api';
import { microphoneAccess } from '@/utils/desktop';
import { MicIcon, RecordingPill } from '@/components/recording/RecordingParts';
import {
  DICTATION_RATE, dictationModels, MAX_DICTATION_SECONDS, pickDictationModel, saveDictationModel, savedDictationModel, wavFile,
  type DictationModel,
} from '@/utils/dictation';
import type { Transcription } from '@/types';

/**
 * Dictate into a text field: click, speak, click Stop, and the words are added to the field. The audio is transcribed
 * offline with a downloaded model (Settings > Transcription) and never stored. The microphone is recorded the way a
 * meeting is (an AudioWorklet at 16 kHz), but the clip stays in this page until Stop and is sent whole.
 */

type Phase = 'loading' | 'idle' | 'starting' | 'recording' | 'transcribing';

interface Recording {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
  blocks: Uint8Array[];
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  /** Stop was pressed (or the time ran out): the last block is on its way. */
  stopping: boolean;
}

function microphoneMessage(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError') return 'The microphone is blocked. Allow it for this app in your browser or system settings, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app, or cannot be opened.';
  return (err as Error)?.message || 'Dictation could not start.';
}

interface DictateButtonProps {
  /** Receives the transcribed text; the field decides where it goes. */
  onText: (text: string) => void;
  /** The field the text goes into, for the button's accessible name ("Dictate the objective"). */
  fieldName: string;
}

export default function DictateButton({ onText, fieldName }: DictateButtonProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [models, setModels] = useState<DictationModel[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const recording = useRef<Recording | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // The field's latest handler: the text goes into what the field holds when it arrives, typing meanwhile included.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    mounted.current = true;
    apiGet<Transcription>('/api/transcription')
      .catch(() => null)
      .then((overview) => {
        if (!mounted.current) return;
        const list = dictationModels(overview);
        setModels(list);
        setModel(pickDictationModel(list, overview, savedDictationModel()));
        setPhase('idle');
      });
    return () => {
      mounted.current = false;
      // Closing the form ends the microphone and drops a clip on its way: nothing is added to a form that is gone.
      release();
      request.current?.abort();
    };
  }, []);

  const release = () => {
    const r = recording.current;
    recording.current = null;
    if (!r) return;
    clearInterval(r.timer);
    for (const track of r.stream.getTracks()) track.stop();
    void r.context.close().catch(() => {});
  };

  const transcribe = useCallback(async (blocks: Uint8Array[]) => {
    if (!model) return;
    setPhase('transcribing');
    setAnnouncement('Transcribing.');
    const controller = new AbortController();
    request.current = controller;
    try {
      const res = await fetch(`/api/transcription/dictation?model=${encodeURIComponent(model)}`, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav', Accept: 'application/json' }, body: new Blob([wavFile(blocks)]), signal: controller.signal,
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessage(body, `Dictation failed (${res.status}).`));
      const text = (body as { text?: string } | null)?.text?.trim() ?? '';
      if (!mounted.current) return;
      if (text) { onTextRef.current(text); setAnnouncement('Text added.'); }
      else setError('No speech was heard. Check the microphone, then try again.');
    } catch (err) {
      if (controller.signal.aborted || !mounted.current) return;
      setError((err as Error).message);
    } finally {
      if (mounted.current) setPhase('idle');
    }
  }, [model]);

  const stop = useCallback(() => {
    const r = recording.current;
    if (!r || r.stopping) return;
    r.stopping = true;
    // The worklet sends what it still holds, then says it is done: the last words are not cut off.
    r.node.port.postMessage('stop');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const blocks = r.blocks;
      release();
      void transcribe(blocks);
    };
    const fallback = setTimeout(finish, 1000);
    const previous = r.node.port.onmessage;
    r.node.port.onmessage = (event: MessageEvent<{ samples?: ArrayBuffer; done?: boolean }>) => {
      previous?.call(r.node.port, event);
      if (event.data.done) { clearTimeout(fallback); finish(); }
    };
  }, [transcribe]);

  const start = async () => {
    if (phase !== 'idle' || !model) return;
    setError(null);
    setPhase('starting');
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Dictation works when the dashboard is opened on this computer, at localhost.');
      const access = await microphoneAccess();
      if (access !== 'granted') throw new Error(access);
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      context = new AudioContext({ sampleRate: DICTATION_RATE });
      if (context.sampleRate !== DICTATION_RATE) throw new Error('This browser cannot record at 16 kHz. Use the desktop app, Chrome or Edge.');
      await context.audioWorklet.addModule('/recorder-worklet.js');
      const node = new AudioWorkletNode(context, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      context.createMediaStreamSource(stream).connect(node);
      const silent = context.createGain();
      silent.gain.value = 0; // keeps the graph running; nothing recorded is played back
      node.connect(silent);
      silent.connect(context.destination);
      if (!mounted.current) throw new Error('closed');
      const blocks: Uint8Array[] = [];
      node.port.onmessage = (event: MessageEvent<{ samples?: ArrayBuffer }>) => { if (event.data.samples) blocks.push(new Uint8Array(event.data.samples)); };
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const seconds = (Date.now() - startedAt) / 1000;
        setElapsed(seconds);
        if (seconds >= MAX_DICTATION_SECONDS) stop();
      }, 250);
      recording.current = { stream, context, node, blocks, startedAt, timer, stopping: false };
      setElapsed(0);
      setPhase('recording');
      setAnnouncement('Listening. Press Stop when you are done.');
    } catch (err) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => {});
      if (!mounted.current) return;
      setPhase('idle');
      setError(microphoneMessage(err));
    }
  };

  const choose = (id: string) => { setModel(id); saveDictationModel(id); };
  const busy = phase === 'starting' || phase === 'transcribing';
  const noModel = phase !== 'loading' && models.length === 0;
  const current = models.find((m) => m.id === model);

  return (
    <div className="gtd-dictate">
      <div className="gtd-dictate__row">
        {phase === 'recording' ? (
          <RecordingPill label={`Dictating the ${fieldName}`} elapsed={elapsed} onStop={stop}
            stopLabel={`Stop and add the words to the ${fieldName}`} stopTitle="Stop and add the words" />
        ) : (
          <Button size="sm" variant="secondary" icon={<MicIcon />} onClick={() => void start()} loading={busy} disabled={phase === 'loading' || noModel}
            aria-label={`Dictate the ${fieldName}`} title={noModel ? 'Download a model in Settings > Transcription to dictate' : `Dictate the ${fieldName}`}>
            {phase === 'transcribing' ? 'Transcribing…' : 'Dictate'}
          </Button>
        )}
        {models.length > 1 && (
          <Select size="sm" aria-label="Dictation model" value={model ?? ''} onChange={choose} disabled={phase !== 'idle'}
            options={models.map((m) => ({ value: m.id, label: m.name }))} />
        )}
        <span className="gtd-dictate__note">
          {noModel
            ? 'Download a model in Settings > Transcription to dictate.'
            : phase === 'recording'
              ? `Listening… up to ${MAX_DICTATION_SECONDS / 60} minutes.`
              : current && models.length === 1 ? `Offline, with ${current.name}.` : 'Offline, on this computer.'}
        </span>
      </div>
      {error && <span className="gtd-field__error" role="alert">{error}</span>}
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </div>
  );
}
