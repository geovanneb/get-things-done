import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MeetingDigestService, namesFor, voicesFor, type QueuedMeeting, type RecordingState } from '../meetingDigestService';
import { readFolder, type FolderVersion } from '../meetingFolder';
import { heldMeetings, isMeetingId, QUEUED_MEETING_ID } from '../meetingLibrary';
import { ContextUpdateService } from '../contextUpdateService';
import { ProfileService } from '../profileService';
import { StakeholderService } from '../stakeholderService';
import { SPEAKER_MODEL, TranscriptionModelService } from '../transcriptionModels';
import { TranscriptionEngine, type RecordingVoice } from '../transcription/engine';
import { convertToWav } from '../transcription/convert';
import { centroid, cosine, secondsOf, type Interval } from '../transcription/voices';
import { WorkspaceService } from '../workspace';
import { hashFile } from '../../utils/fileHash';
import { fileInside, topLevelName } from '../../utils/files';
import type { SpeakerName } from '../speakerData';
import { MATCH_RULES, suggestSpeakers, type KnownVoice } from './matching';
import { CONSENT_VERSION, consentText, printVoice, VOICE_REF, VoiceprintStore, type MovedBinding, type SampleSource } from './store';
import { EventEmitter } from 'events';

/**
 * Recognize known voices (issue #287, docs/voiceprints.md): remembers a stakeholder's voice with their consent, from
 * speakers the user named, and suggests their name when a transcription hears it again. Suggestions only: a name is
 * given by the user's click, never by this service.
 */

/** The embedding model voices are made with: prints made with another one are stale and never compared. */
export const VOICE_MODEL = { id: SPEAKER_MODEL.id, sha256: SPEAKER_MODEL.files[1]!.sha256 };

/** Notices for the dashboard when remembered voices change (they live outside the workspace, so no file watch sees them). */
export const voiceprintEvents = new EventEmitter();

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** Where speakers were confirmed: a recording in the queue, or a Transcribe again version of a kept meeting. */
export type VoiceSourceRef = { kind: 'queue'; meeting: string; file: string; transcript_sha256: string } | { kind: 'folder'; meeting: string; version: string; transcript_sha256: string };

/** A source from a request, checked before anything is read with it. */
export function parseVoiceSource(input: unknown): VoiceSourceRef {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const sha = o['transcript_sha256'];
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) throw httpError(400, 'Invalid transcript_sha256');
  if (o['kind'] === 'queue') {
    if (typeof o['meeting'] !== 'string' || !QUEUED_MEETING_ID.test(o['meeting'])) throw httpError(400, 'Invalid meeting');
    return { kind: 'queue', meeting: o['meeting'], file: topLevelName(o['file'] as string), transcript_sha256: sha };
  }
  if (o['kind'] === 'folder') {
    if (!isMeetingId(o['meeting'])) throw httpError(400, 'Invalid meeting');
    if (typeof o['version'] !== 'string' || !/^v\d{1,4}$/.test(o['version'])) throw httpError(400, 'Invalid version');
    return { kind: 'folder', meeting: o['meeting'], version: o['version'], transcript_sha256: sha };
  }
  throw httpError(400, 'Invalid source: queue or folder');
}

/** A speaker of a source as confirmed now: its stretches, its name, the audio. */
interface Resolved {
  names: SpeakerName[];
  voices: { label: string; intervals: [number, number][]; seconds: number }[];
  audio: { path: string; sha256: string; name: string };
  /** Re-reads the source: true while `label` is still named `ref` on the same transcript and audio. */
  confirms: (label: string, ref: string) => Promise<boolean>;
}

/** A remembered voice as Settings and the stakeholder pages show it: never its samples. */
export interface PrintView {
  ref: string;
  name: string;
  /** The person is still a stakeholder (or `me`). A print whose person is gone is never used, only listed to forget. */
  stakeholder: boolean;
  damaged: boolean;
  /** Made with another speaker model: not used until the voice is remembered again. */
  stale_model: boolean;
  /** Given under an older wording of the consent. */
  old_consent: boolean;
  /** Enough clean speech to suggest the name. */
  ready: boolean;
  seconds: number;
  samples: number;
  meetings: number;
  consent: { version: number; person: string; recorded_by: string; at: string } | null;
  updated_at: string | null;
}

export interface VoiceprintsView {
  /** Recognize known voices is on, and the speaker model is here. */
  enabled: boolean;
  setting: boolean;
  speaker_model: boolean;
  consent_version: number;
  /** The wording asked for a person's consent; `{person}` stands for their name. */
  consent_text: string;
  min_seconds: number;
  prints: PrintView[];
  moved: MovedBinding[];
}

export class VoiceprintService {
  constructor(
    private readonly store = new VoiceprintStore(),
    private readonly engine = new TranscriptionEngine(),
    private readonly models = new TranscriptionModelService(),
    private readonly queue = new MeetingDigestService(),
    private readonly stakeholders = new StakeholderService(),
    private readonly workspace: () => string = () => new WorkspaceService().getWorkspacePath(),
  ) {}

  /** The setting is on and the speaker model is downloaded. */
  async enabled(): Promise<boolean> {
    const settings = await this.models.readSettings();
    return settings.recognize_voices === true && settings.speakers === true && Boolean(await this.models.installedPath(SPEAKER_MODEL.id).catch(() => null));
  }

  private async people(): Promise<Map<string, string>> {
    const list = await this.stakeholders.listStakeholders('people').catch(() => []);
    return new Map(list.map((p) => [p.id, p.name] as const));
  }

  async view(): Promise<VoiceprintsView> {
    const settings = await this.models.readSettings();
    const model = Boolean(await this.models.installedPath(SPEAKER_MODEL.id).catch(() => null));
    const ws = this.workspace();
    const people = await this.people();
    const prints = (await this.store.list(ws)).map((p): PrintView => {
      const stakeholder = p.ref === 'me' || people.has(p.ref);
      if ('damaged' in p) {
        return { ref: p.ref, name: p.ref === 'me' ? 'You' : people.get(p.ref) ?? p.ref, stakeholder, damaged: true, stale_model: false, old_consent: false, ready: false, seconds: 0, samples: 0, meetings: 0, consent: null, updated_at: null };
      }
      const voice = printVoice(p);
      const stale = p.model.sha256 !== VOICE_MODEL.sha256;
      return {
        ref: p.ref, name: p.ref === 'me' ? 'You' : people.get(p.ref) ?? p.name, stakeholder, damaged: false, stale_model: stale,
        old_consent: p.consent.version < CONSENT_VERSION, ready: !stale && voice.seconds >= MATCH_RULES.printSeconds,
        seconds: voice.seconds, samples: p.samples.length, meetings: new Set(p.samples.map((s) => `${s.source.kind}/${s.source.meeting}`)).size,
        consent: p.consent, updated_at: p.updated_at,
      };
    });
    return {
      enabled: settings.recognize_voices === true && settings.speakers === true && model, setting: settings.recognize_voices === true, speaker_model: model,
      consent_version: CONSENT_VERSION, consent_text: consentText('{person}'), min_seconds: MATCH_RULES.printSeconds,
      prints, moved: await this.store.moved(ws),
    };
  }

  /**
   * The voices that may be suggested: same model, readable, and still a stakeholder. Reconciled here, before every
   * comparison, because a stakeholder can be deleted by editing files, without the delete hook.
   */
  async known(): Promise<KnownVoice[]> {
    const people = await this.people();
    return (await this.store.list(this.workspace())).flatMap((p) => {
      if ('damaged' in p || p.model.sha256 !== VOICE_MODEL.sha256 || (p.ref !== 'me' && !people.has(p.ref))) return [];
      const v = printVoice(p);
      return v.centroid ? [{ ref: p.ref, centroid: v.centroid, seconds: v.seconds }] : [];
    });
  }

  /**
   * Suggestions for the voices of a new transcript. `expected`: the people the meeting expected (your own voice always
   * is). Never throws: without suggestions the transcript is the same.
   */
  async suggest(voices: readonly RecordingVoice[], expected: readonly string[]): Promise<{ model_sha256: string; items: { label: string; ref: string; score: number }[] } | undefined> {
    try {
      const heard = voices.flatMap((v) => (v.centroid ? [{ label: v.label, centroid: v.centroid, seconds: v.seconds, ...(v.samples ? { samples: v.samples } : {}) }] : []));
      if (!heard.length) return undefined;
      const known = await this.known();
      if (!known.length) return undefined;
      const items = suggestSpeakers(heard, known, new Set([...expected, 'me']));
      return { model_sha256: VOICE_MODEL.sha256, items };
    } catch (err) {
      console.error(`[voiceprints] Suggestions: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Who a kept meeting expected, for a Transcribe again: the people of its record (attendees and speakers) and anyone
   * named in one of its versions. Empty when that cannot be read: then only a very high score suggests anyone.
   */
  async expectedForFolder(meetingId: string): Promise<string[]> {
    try {
      const folder = await readFolder(this.workspace(), meetingId);
      if (folder.state !== 'ok') return [];
      const refs = new Set<string>(folder.manifest.versions.flatMap((v) => (v.speakers?.names ?? []).map((n) => n.ref).filter((r): r is string => Boolean(r))));
      const update = (await new ContextUpdateService().list()).find((u) => u.id === folder.manifest.update_id);
      const record = update ? heldMeetings(update).find((m) => m.id === meetingId)?.record : null;
      for (const p of record?.attendees ?? []) if (p.ref) refs.add(p.ref);
      for (const s of record?.speakers ?? []) if (s.person?.ref) refs.add(s.person.ref);
      return [...refs];
    } catch {
      return [];
    }
  }

  /** The stretches to keep for a transcript: times only, rounded, as the recording stores them. */
  static stretches(voices: readonly RecordingVoice[]): { label: string; intervals: [number, number][]; seconds: number }[] {
    return voices.map((v) => ({ label: v.label, intervals: v.intervals.map((i): [number, number] => [i.start, i.end]), seconds: v.seconds }));
  }

  private async resolve(source: VoiceSourceRef): Promise<Resolved> {
    const ws = this.workspace();
    if (source.kind === 'queue') {
      const read = async () => {
        const meeting: QueuedMeeting = await this.queue.loadMeeting(source.meeting);
        const entry = meeting.files.find((f) => f.name === source.file && f.recording);
        const r: RecordingState | undefined = entry?.recording;
        if (!entry || !r || r.transcript_sha256 !== source.transcript_sha256) return null;
        return { entry, r };
      };
      const found = await read();
      if (!found) throw httpError(409, 'The transcript changed meanwhile; look again');
      const audio = await fileInside(await this.queue.meetingFolder(source.meeting), found.entry.name);
      return {
        names: namesFor(found.r), voices: voicesFor(found.r), audio: { path: audio, sha256: found.entry.sha256, name: found.entry.name },
        confirms: async (label, ref) => {
          const now = await read().catch(() => null);
          return Boolean(now && now.entry.sha256 === found.entry.sha256 && namesFor(now.r).some((n) => n.label === label && n.ref === ref));
        },
      };
    }
    const read = async () => {
      const folder = await readFolder(ws, source.meeting);
      if (folder.state !== 'ok') return null;
      const version: FolderVersion | undefined = folder.manifest.versions.find((v) => v.id === source.version);
      const audio = version?.from ? folder.manifest.audio.find((a) => a.name === version.from!.name && a.sha256 === version.from!.sha256) : undefined;
      if (!version?.speakers || version.speakers.transcript_sha256 !== source.transcript_sha256 || !audio) return null;
      return { folder, version, speakers: version.speakers, audio };
    };
    const found = await read();
    if (!found) throw httpError(409, 'The transcript or its recording changed meanwhile, or the recording is not kept; look again');
    const audio = await fileInside(found.folder.audioDir, found.audio.name);
    return {
      names: found.speakers.names ?? [], voices: found.speakers.voices, audio: { path: audio, sha256: found.audio.sha256, name: found.audio.name },
      confirms: async (label, ref) => {
        const now = await read().catch(() => null);
        return Boolean(now && (now.speakers.names ?? []).some((n) => n.label === label && n.ref === ref));
      },
    };
  }

  /** Where a sample comes from: the recording's file (for a version, the kept recording it was transcribed from). */
  private static sampleSource(source: VoiceSourceRef, audio: Resolved['audio'], label: string): SampleSource {
    return source.kind === 'queue'
      ? { kind: 'queue', meeting: source.meeting, file: source.file, audio_sha256: audio.sha256, transcript_sha256: source.transcript_sha256, label }
      : { kind: 'folder', meeting: source.meeting, file: audio.name, version: source.version, audio_sha256: audio.sha256, transcript_sha256: source.transcript_sha256, label };
  }

  /** Who recorded a consent: the profile's name, or this computer's account. */
  private async recorder(): Promise<string> {
    const profile = await new ProfileService().getProfile().catch(() => null);
    const account = (() => { try { return os.userInfo().username; } catch { return ''; } })();
    const name = profile?.name && profile.name !== 'Executive' ? profile.name : '';
    return (name ? `${name}${account ? ` (${account})` : ''}` : account || 'the user of this computer').slice(0, 120);
  }

  /**
   * Remembers the voice of a speaker the user named with a stakeholder. The person comes from the confirmed name,
   * never from the request. The first time needs `consent: true`, given for that person. Reads the recording (a
   * format other than WAV is converted again, to a temporary file), then saves under the store's lock only if the
   * name, the transcript and the recording still stand and nothing was forgotten meanwhile.
   */
  async remember(input: unknown): Promise<PrintView> {
    if (!await this.enabled()) throw httpError(409, 'Turn on Recognize known voices in Settings > Transcription first');
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const source = parseVoiceSource(body['source']);
    const label = typeof body['label'] === 'string' ? body['label'] : '';
    const ws = this.workspace();
    const resolved = await this.resolve(source);
    const named = resolved.names.find((n) => n.label === label);
    if (!named?.ref || !VOICE_REF.test(named.ref)) throw httpError(409, `Name ${label || 'the speaker'} with a stakeholder first: only a stakeholder's voice can be remembered`);
    const ref = named.ref;
    const voice = resolved.voices.find((v) => v.label === label);
    if (!voice || !voice.intervals.length) throw httpError(409, `${label} has too little speech of their own (without others talking over them) to remember`);
    const expect = await this.store.snapshot(ws, ref);
    const people = await this.people();
    if (ref !== 'me' && !people.has(ref)) throw httpError(409, `${named.name} is not a stakeholder any more`);
    const person = ref === 'me' ? 'You' : people.get(ref)!;
    const existing = await this.store.read(ws, ref);
    let consent = null;
    if (!existing) {
      if (body['consent'] !== true) throw httpError(400, `Remembering ${person}'s voice needs their consent first`);
      consent = { version: CONSENT_VERSION, person, recorded_by: await this.recorder(), at: new Date().toISOString() };
    }
    const intervals: Interval[] = voice.intervals.map(([start, end]) => ({ start, end }));
    const embeddings = await this.embedRecording(resolved.audio, intervals);
    // Adding to a voice already remembered: only the stretches that sound like that person. A speaker diarization
    // merged with someone else would otherwise mix the other person into the voice.
    const known = existing && existing.model.sha256 === VOICE_MODEL.sha256 ? printVoice(existing).centroid : null;
    const keep = embeddings.map((e) => e !== null && (!known || cosine(e, known) >= MATCH_RULES.sampleScore));
    if (known && !keep.some(Boolean)) throw httpError(409, `${label} does not sound like ${person}'s remembered voice, so nothing was added`);
    const used = intervals.filter((_, i) => keep[i]);
    const mean = centroid(embeddings.filter((e, i): e is number[] => e !== null && keep[i]!));
    if (!mean) throw httpError(409, `${label}'s speech could not be read as a voice`);
    const print = await this.store.addSample(ws, {
      ref, name: person, model: VOICE_MODEL, consent, expect,
      sample: { embedding: mean.map((x) => Math.round(x * 1e5) / 1e5), seconds: secondsOf(used), source: VoiceprintService.sampleSource(source, resolved.audio, label), at: new Date().toISOString() },
      stillConfirmed: () => resolved.confirms(label, ref),
    });
    voiceprintEvents.emit('change');
    return (await this.view()).prints.find((p) => p.ref === print.ref)!;
  }

  /** Embeddings of stretches of a recording, after checking its bytes are still the ones confirmed. */
  private async embedRecording(audio: Resolved['audio'], intervals: Interval[]): Promise<(number[] | null)[]> {
    if ((await hashFile(audio.path).catch(() => null))?.sha256 !== audio.sha256) throw httpError(409, 'The recording changed or is gone, so its voices cannot be remembered');
    if (path.extname(audio.name).toLowerCase() === '.wav') return this.engine.embed(audio.path, intervals);
    // The converted copy the transcription made is gone: convert again, into a private temporary folder.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-voice-'));
    try {
      const wav = path.join(dir, 'audio.wav');
      await convertToWav(audio.path, wav, AbortSignal.timeout(30 * 60 * 1000));
      return await this.engine.embed(wav, intervals);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * After the user named speakers: a sample added for a label now named someone else (or no one) goes, from every
   * print but the one of the label's current person; and each label named with a person whose voice is already
   * remembered adds a sample (a later confirmation), in the background. Never throws: naming stands either way.
   */
  async afterNaming(source: VoiceSourceRef, labels: readonly string[], names: readonly SpeakerName[]): Promise<void> {
    const ws = this.workspace();
    const now = new Map(names.map((n) => [n.label, n.ref] as const));
    const changed = new Set(labels);
    try {
      const dropped = await this.store.dropSamples(ws, (s, printRef) => s.kind === source.kind && s.meeting === source.meeting && changed.has(s.label)
        && (source.kind === 'queue' ? s.file === source.file : s.version === source.version) && now.get(s.label) !== printRef);
      if (dropped) voiceprintEvents.emit('change');
    } catch (err) {
      console.error(`[voiceprints] Dropping samples: ${(err as Error).message}`);
    }
    if (!await this.enabled().catch(() => false)) return;
    for (const label of labels) {
      const ref = now.get(label);
      if (!ref || !await this.store.read(ws, ref).catch(() => null)) continue;
      // One at a time, after the response: a recording can take a moment to read.
      await this.remember({ source, label }).catch((err: Error) => console.error(`[voiceprints] Remembering ${label}: ${err.message}`));
    }
  }

  async forget(ref: string): Promise<void> {
    await this.store.forget(this.workspace(), ref);
    voiceprintEvents.emit('change');
  }

  async forgetAll(): Promise<number> {
    const n = await this.store.forgetAll(this.workspace());
    voiceprintEvents.emit('change');
    return n;
  }

  async relink(key: unknown): Promise<void> {
    await this.store.relink(this.workspace(), typeof key === 'string' ? key : '');
    voiceprintEvents.emit('change');
  }

  async forgetMoved(key: unknown): Promise<void> {
    await this.store.forgetMoved(this.workspace(), typeof key === 'string' ? key : '');
    voiceprintEvents.emit('change');
  }

  /** A stakeholder was deleted through the dashboard: their voice goes with them. Never blocks the deletion. */
  async stakeholderDeleted(ref: string): Promise<void> {
    if (!/^STK-\d{4}$/.test(ref)) return;
    await this.forget(ref).catch((err: Error) => console.error(`[voiceprints] Forgetting ${ref}: ${err.message}`));
  }

  /** The person a suggestion names, as the stakeholder is called now; refused when the suggestion is stale. */
  async suggestedPerson(ref: string, model: unknown): Promise<{ name: string; ref: string }> {
    if (model !== VOICE_MODEL.sha256) throw httpError(409, 'This suggestion was made with another speaker model; look again');
    if (ref === 'me') return { name: 'Me', ref };
    const name = (await this.people()).get(ref);
    if (!name) throw httpError(409, 'The suggested person is not a stakeholder any more');
    return { name, ref };
  }
}
