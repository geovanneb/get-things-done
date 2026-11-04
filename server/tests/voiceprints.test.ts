import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { centroid, cleanIntervals, cosine, isEmbedding, MAX_VOICE_SAMPLES, MAX_VOICE_SECONDS, MIN_SAMPLE_SECONDS, normalize } from '../src/services/transcription/voices';
import { voicesOfLabels } from '../src/services/transcription/engine';
import { MATCH_RULES, suggestSpeakers } from '../src/services/voiceprints/matching';
import { bindingKey, MAX_PRINT_SAMPLES, parsePrint, VoiceprintStore, type Consent, type SampleSource, type VoiceSample } from '../src/services/voiceprints/store';
import { parseVoiceSource, VoiceprintService, VOICE_MODEL } from '../src/services/voiceprints/service';
import { parseSpeakerSuggestions, parseSpeakerVoices } from '../src/services/speakerData';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingTranscriptionService } from '../src/services/meetingTranscription';
import { dismissVersionSuggestion, nameVersionSpeakers, publishTranscription, claimTranscription, requestTranscription } from '../src/services/meetingVersions';
import { readFolder } from '../src/services/meetingFolder';
import type { TranscriptionEngine } from '../src/services/transcription/engine';
import type { TranscriptionModelService } from '../src/services/transcriptionModels';
import type { StakeholderService } from '../src/services/stakeholderService';

// ---- fictional vectors -----------------------------------------------------------------------------------------

const DIM = 128;
/** A unit vector mostly along axis `n`, with a little of axis `n + 1`: fictional voices with known similarities. */
function voice(n: number, blend = 0, other = n + 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[n] = 1;
  v[other] = blend;
  return normalize(v)!;
}

// ---- clean samples ---------------------------------------------------------------------------------------------

test('samples are only where one voice speaks alone, trimmed, cut to size and capped', () => {
  const turns = [
    { start: 0, end: 5, speaker: 1 },
    { start: 4, end: 9, speaker: 2 }, // overlaps the end of voice 1
    { start: 9, end: 30, speaker: 1 },
    { start: 12, end: 12.5, speaker: 0 }, // a cough in the middle of voice 1
    { start: 31, end: 31.8, speaker: 1 }, // too short once trimmed
  ];
  const one = cleanIntervals(turns, 1);
  for (const i of one) {
    assert.ok(i.end - i.start >= MIN_SAMPLE_SECONDS - 1e-9, `${i.start}-${i.end} is long enough`);
    assert.ok(i.end - i.start <= 10 + 1e-9, 'never longer than a sample');
    for (const o of turns.filter((t) => t.speaker !== 1)) assert.ok(i.end <= o.start || i.start >= o.end, `${i.start}-${i.end} never overlaps another sound`);
  }
  assert.ok(one.every((i, n) => n === 0 || i.start >= one[n - 1]!.end), 'in time order, never overlapping');
  assert.ok(one.some((i) => i.start >= 0.2 && i.end <= 3.8), 'voice 1 before voice 2 starts, with its edges trimmed');
  assert.ok(!one.some((i) => i.start < 31.8 && i.end > 31), 'a turn too short is never a sample');
  assert.deepEqual(cleanIntervals(turns, 0), [], 'a sound with no voice is never remembered');
  assert.deepEqual(cleanIntervals([{ start: 0, end: 10, speaker: 1 }, { start: 0, end: 10, speaker: 2 }], 1), [], 'two voices at once: nothing clean');

  // A long monologue: at most the caps, longest first.
  const long = cleanIntervals([{ start: 0, end: 600, speaker: 3 }], 3);
  assert.ok(long.length <= MAX_VOICE_SAMPLES);
  assert.ok(long.reduce((s, i) => s + i.end - i.start, 0) <= MAX_VOICE_SECONDS + 10);
});

test('the labels of a transcript get their own voice\'s samples, also when renumbered', () => {
  const turns = [{ start: 0, end: 6, speaker: 1 }, { start: 6, end: 12, speaker: 2 }];
  // Voice 2 spoke first in the transcript (voice 1 had no words): it is Speaker 1 there.
  const voices = voicesOfLabels(turns, [[2, 1], [1, 2]], [{ speaker: 2, centroid: voice(1), seconds: 5.6 }]);
  assert.deepEqual(voices.map((v) => v.label), ['Speaker 1', 'Speaker 2']);
  assert.ok(voices[0]!.intervals.every((i) => i.start >= 6), 'Speaker 1 is voice 2');
  assert.deepEqual(voices[0]!.centroid, voice(1));
  assert.equal(voices[1]!.centroid, undefined, 'no mean asked for voice 1');
});

test('vector arithmetic: mean direction and cosine', () => {
  assert.ok(Math.abs(cosine(voice(1), voice(1)) - 1) < 1e-9);
  assert.ok(Math.abs(cosine(voice(1), voice(5))) < 1e-9);
  assert.equal(cosine([0, 0], [1, 0]), 0, 'no direction, no similarity');
  assert.equal(cosine([1, 0], [1, 0, 0]), 0, 'different sizes never compare');
  const mean = centroid([voice(1), voice(2, 0, 1)])!;
  assert.ok(cosine(mean, voice(1)) > 0.7 && cosine(mean, voice(2)) > 0.7);
  assert.equal(centroid([]), null);
  assert.equal(isEmbedding(voice(1)), true);
  assert.equal(isEmbedding([1, 2, 3]), false, 'too short to be an embedding');
  assert.equal(isEmbedding([...voice(1).slice(1), Number.NaN]), false);
});

// ---- matching --------------------------------------------------------------------------------------------------

test('a suggestion needs a high score, a clear lead, and enough speech on both sides', () => {
  const known = [{ ref: 'STK-0001', centroid: voice(1), seconds: 30 }, { ref: 'STK-0002', centroid: voice(10), seconds: 30 }];
  const expected = new Set(['STK-0001', 'STK-0002']);
  // Clearly voice 1.
  assert.deepEqual(suggestSpeakers([{ label: 'Speaker 1', centroid: voice(1, 0.2), seconds: 20 }], known, expected), [{ label: 'Speaker 1', ref: 'STK-0001', score: 0.98 }]);
  // Someone never remembered: far from both, nothing.
  assert.deepEqual(suggestSpeakers([{ label: 'Speaker 1', centroid: voice(30), seconds: 20 }], known, expected), [], 'an unknown voice is never guessed');
  // Between two people: no clear lead, nothing.
  const between = normalize(voice(1).map((x, i) => x + voice(10)[i]!))!;
  assert.deepEqual(suggestSpeakers([{ label: 'Speaker 1', centroid: between, seconds: 20 }], known, expected), []);
  // Too little speech in the recording, or in the print.
  assert.deepEqual(suggestSpeakers([{ label: 'Speaker 1', centroid: voice(1), seconds: MATCH_RULES.voiceSeconds - 0.5 }], known, expected), []);
  assert.deepEqual(suggestSpeakers([{ label: 'Speaker 1', centroid: voice(1), seconds: 20 }], [{ ...known[0]!, seconds: MATCH_RULES.printSeconds - 1 }], expected), [], 'one short yes makes no print');
});

test('someone the meeting did not expect needs a very high score; one voice split in two gets the same name twice', () => {
  const known = [{ ref: 'STK-0001', centroid: voice(1), seconds: 30 }];
  const fair = voice(1, 0.9); // about 0.74 to voice 1
  assert.ok(cosine(fair, voice(1)) > MATCH_RULES.score && cosine(fair, voice(1)) < MATCH_RULES.unexpected);
  assert.equal(suggestSpeakers([{ label: 'Speaker 1', centroid: fair, seconds: 20 }], known, new Set(['STK-0001'])).length, 1, 'expected: enough');
  assert.equal(suggestSpeakers([{ label: 'Speaker 1', centroid: fair, seconds: 20 }], known, new Set()).length, 0, 'not expected: not enough');
  assert.equal(suggestSpeakers([{ label: 'Speaker 1', centroid: voice(1, 0.1), seconds: 20 }], known, new Set()).length, 1, 'not expected, but very close');
  // Diarization split one person into two labels: both clearly them, so both get the suggestion.
  const split = suggestSpeakers([{ label: 'Speaker 1', centroid: voice(1, 0.1), seconds: 20 }, { label: 'Speaker 3', centroid: voice(1, 0.15, 3), seconds: 8 }], known, new Set(['STK-0001']));
  assert.deepEqual(split.map((s) => [s.label, s.ref]), [['Speaker 1', 'STK-0001'], ['Speaker 3', 'STK-0001']]);
});

test('a voice that is two people merged by diarization gets no suggestion, even when its mean is close enough', () => {
  const known = [{ ref: 'STK-0001', centroid: voice(1), seconds: 30 }];
  const expected = new Set(['STK-0001']);
  // Measured in the desktop app: one person's stretches score 0.9 on their own, the merged guest's 0.25.
  const kim = { seconds: 8, embedding: voice(1, 0.2) };
  const guest = { seconds: 8, embedding: voice(20) };
  const mean = normalize(voice(1).map((x, i) => x * 2 + voice(20)[i]!))!;
  assert.ok(cosine(mean, voice(1)) > MATCH_RULES.score, 'the mean alone would pass');
  assert.deepEqual(suggestSpeakers([{ label: 'Speaker 2', centroid: mean, seconds: 16, samples: [kim, guest] }], known, expected), [], 'half the speech is someone else');
  assert.equal(suggestSpeakers([{ label: 'Speaker 2', centroid: mean, seconds: 32, samples: [kim, kim, kim, { ...guest, seconds: 4 }] }], known, expected).length, 1, 'a short cough-like stretch of someone else is tolerated');
  assert.equal(suggestSpeakers([{ label: 'Speaker 2', centroid: voice(1, 0.2), seconds: 16, samples: [kim, kim] }], known, expected).length, 1);
});

// ---- the store -------------------------------------------------------------------------------------------------

async function tmp(t: { after: (fn: () => Promise<void>) => void }, prefix = 'gtd-voices-'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const consent: Consent = { version: 1, person: 'Kim Park', recorded_by: 'Alex Morgan (alex)', at: '2026-11-04T09:00:00.000Z' };
const source = (meeting: string, label = 'Speaker 1', transcript = 'a'.repeat(64)): SampleSource => ({ kind: 'queue', meeting, file: 'call.wav', audio_sha256: 'b'.repeat(64), transcript_sha256: transcript, label });
const sample = (meeting: string, embedding = voice(1), label?: string): VoiceSample => ({ embedding, seconds: 12, source: source(meeting, label), at: new Date().toISOString() });

test('a print is private, outside the workspace, made only with consent, and keeps the newest samples', async (t) => {
  const root = await tmp(t);
  const ws = await tmp(t, 'gtd-ws-');
  const store = new VoiceprintStore(() => root);
  const add = async (s: VoiceSample, c: Consent | null = null) => store.addSample(ws, { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, sample: s, consent: c, expect: await store.snapshot(ws, 'STK-0002'), stillConfirmed: async () => true });

  await assert.rejects(add(sample('MQ-2026-0001')), /consent/, 'the first sample needs consent');
  assert.deepEqual(await store.list(ws), [], 'and nothing is written without it');
  const first = await add(sample('MQ-2026-0001'), consent);
  assert.deepEqual(first.consent, consent);
  const file = path.join(root, bindingKey(ws), 'STK-0002.json');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'readable only by this user');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  assert.ok(!file.startsWith(ws), 'never inside the workspace');

  // Later samples need no consent again; the same speaker of the same transcript replaces its earlier sample.
  await add(sample('MQ-2026-0001', voice(1, 0.1)));
  assert.equal((await store.read(ws, 'STK-0002'))!.samples.length, 1);
  for (let i = 2; i <= MAX_PRINT_SAMPLES + 3; i++) await add(sample(`MQ-2026-${String(i).padStart(4, '0')}`));
  const full = (await store.read(ws, 'STK-0002'))!;
  assert.equal(full.samples.length, MAX_PRINT_SAMPLES, 'capped');
  assert.equal(full.samples[0]!.source.meeting, 'MQ-2026-0004', 'the oldest went first');
  assert.deepEqual(full.consent, consent, 'consent stays as it was given');

  // A sample made with another speaker model starts the print over, keeping the consent.
  const other = await store.addSample(ws, { ref: 'STK-0002', name: 'Kim Park', model: { id: 'speaker-detection', sha256: 'c'.repeat(64) }, sample: sample('MQ-2026-0099'), consent: null, expect: await store.snapshot(ws, 'STK-0002'), stillConfirmed: async () => true });
  assert.equal(other.samples.length, 1);
  assert.deepEqual(other.consent, consent);
});

test('a Forget, a correction, or a change of the print during an extraction wins: nothing is saved', async (t) => {
  const root = await tmp(t);
  const ws = await tmp(t, 'gtd-ws-');
  const store = new VoiceprintStore(() => root);
  const base = { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, consent, stillConfirmed: async () => true };
  // The extraction starts, then the user forgets someone (anyone): the save is refused.
  const before = await store.snapshot(ws, 'STK-0002');
  await store.forget(ws, 'STK-0005');
  await assert.rejects(store.addSample(ws, { ...base, sample: sample('MQ-2026-0001'), expect: before }), /changed while/);
  assert.equal(await store.read(ws, 'STK-0002'), null, 'no print came back');
  // The name was corrected meanwhile: refused.
  await assert.rejects(store.addSample(ws, { ...base, sample: sample('MQ-2026-0001'), expect: await store.snapshot(ws, 'STK-0002'), stillConfirmed: async () => false }), /name changed/);
  // Another sample saved meanwhile: refused, the newer one stands.
  const start = await store.snapshot(ws, 'STK-0002');
  await store.addSample(ws, { ...base, sample: sample('MQ-2026-0002'), expect: start });
  await assert.rejects(store.addSample(ws, { ...base, sample: sample('MQ-2026-0003'), expect: start }), /changed while/);
  assert.deepEqual((await store.read(ws, 'STK-0002'))!.samples.map((s) => s.source.meeting), ['MQ-2026-0002']);
  // Forget all, and a Forget-all during an extraction of a first print.
  const first = await store.snapshot(ws, 'STK-0003');
  assert.equal(await store.forgetAll(ws), 1);
  await assert.rejects(store.addSample(ws, { ...base, ref: 'STK-0003', sample: sample('MQ-2026-0004'), expect: first }), /changed while/);
  assert.deepEqual(await store.list(ws), []);
});

test('dropping a confirmation\'s samples, a damaged print, and refused refs', async (t) => {
  const root = await tmp(t);
  const ws = await tmp(t, 'gtd-ws-');
  const store = new VoiceprintStore(() => root);
  assert.equal(await store.dropSamples(ws, () => true), 0);
  assert.equal(fs.existsSync(path.join(root, bindingKey(ws))), false, 'nothing is made for a workspace that remembers nothing');
  const add = async (ref: string, s: VoiceSample) => store.addSample(ws, { ref, name: ref, model: VOICE_MODEL, sample: s, consent, expect: await store.snapshot(ws, ref), stillConfirmed: async () => true });
  await add('STK-0002', sample('MQ-2026-0001', voice(1), 'Speaker 1'));
  await add('STK-0002', sample('MQ-2026-0002', voice(1), 'Speaker 2'));
  await add('STK-0003', sample('MQ-2026-0001', voice(5), 'Speaker 2'));
  // Speaker 1 of MQ-0001 was renamed: its sample leaves Kim's print; the print stays with its other sample.
  assert.equal(await store.dropSamples(ws, (s, ref) => s.meeting === 'MQ-2026-0001' && s.label === 'Speaker 1' && ref !== 'STK-0009'), 1);
  assert.deepEqual((await store.read(ws, 'STK-0002'))!.samples.map((s) => s.source.meeting), ['MQ-2026-0002']);
  // A print left with no sample goes, consent and all.
  await store.dropSamples(ws, (s) => s.meeting === 'MQ-2026-0001');
  assert.equal(await store.read(ws, 'STK-0003'), null);

  // A file that cannot be read is listed as damaged, never used, and blocks adding until it is forgotten.
  await fsp.writeFile(path.join(root, bindingKey(ws), 'STK-0004.json'), '{"schema":1,"ref":"STK-0004"');
  assert.deepEqual((await store.list(ws)).find((p) => p.ref === 'STK-0004'), { ref: 'STK-0004', damaged: true });
  await assert.rejects(add('STK-0004', sample('MQ-2026-0005')), /cannot be read/);
  await store.forget(ws, 'STK-0004');
  assert.equal((await store.list(ws)).some((p) => p.ref === 'STK-0004'), false);

  for (const ref of ['../x', 'STK-1', 'GRP-0001', 'Me']) await assert.rejects(store.forget(ws, ref), /Invalid person/);
  assert.equal(parsePrint({ schema: 1, ref: 'STK-0002' }, 'STK-0002'), null);
});

test('a moved workspace\'s voices can be relinked; a copy never gets them by itself', async (t) => {
  const root = await tmp(t);
  const parent = await tmp(t, 'gtd-ws-');
  const old = path.join(parent, 'old');
  const copy = path.join(parent, 'copy');
  await fsp.mkdir(old);
  await fsp.mkdir(copy);
  const store = new VoiceprintStore(() => root);
  await store.addSample(old, { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, sample: sample('MQ-2026-0001'), consent, expect: await store.snapshot(old, 'STK-0002'), stillConfirmed: async () => true });
  assert.deepEqual(await store.moved(copy), [], 'the old folder is still there: a copy, nothing offered');
  const moved = path.join(parent, 'moved');
  await fsp.rename(old, moved);
  const offered = await store.moved(moved);
  assert.deepEqual(offered.map((m) => m.prints), [[{ ref: 'STK-0002', name: 'Kim Park' }]]);
  await assert.rejects(store.relink(moved, 'f'.repeat(32)), /No voices/);
  await store.relink(moved, offered[0]!.key);
  assert.equal((await store.read(moved, 'STK-0002'))?.samples.length, 1);
  assert.deepEqual(await store.moved(moved), []);
  assert.equal(fs.existsSync(path.join(root, offered[0]!.key)), false, 'the old binding is gone');
});

test('relink refuses damaged voices without deleting or partially copying the source', async (t) => {
  const root = await tmp(t);
  const parent = await tmp(t, 'gtd-ws-');
  const old = path.join(parent, 'gone');
  const destination = path.join(parent, 'destination');
  const store = new VoiceprintStore(() => root);
  await store.addSample(old, { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, sample: sample('MQ-2026-0001'), consent, expect: await store.snapshot(old, 'STK-0002'), stillConfirmed: async () => true });
  const broken = path.join(root, bindingKey(old), 'STK-0003.json');
  await fsp.writeFile(broken, '{"unfinished":');
  await assert.rejects(store.relink(destination, bindingKey(old)), /cannot be read/);
  assert.equal(await fsp.readFile(broken, 'utf8'), '{"unfinished":');
  assert.ok(await store.read(old, 'STK-0002'));
  assert.deepEqual(await store.list(destination), []);
});

test('forgetting moved voices cannot succeed while relink still has a copy to publish', async (t) => {
  const root = await tmp(t);
  const parent = await tmp(t, 'gtd-ws-');
  const old = path.join(parent, 'gone');
  const destination = path.join(parent, 'destination');
  const store = new VoiceprintStore(() => root);
  await store.addSample(old, { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, sample: sample('MQ-2026-0001'), consent, expect: await store.snapshot(old, 'STK-0002'), stillConfirmed: async () => true });
  const rename = fs.promises.rename;
  let arrived!: () => void;
  const ready = new Promise<void>((r) => { arrived = r; });
  let resume!: () => void;
  const gate = new Promise<void>((r) => { resume = r; });
  t.mock.method(fs.promises, 'rename', async (from: fs.PathLike, to: fs.PathLike) => {
    if (to === path.join(root, bindingKey(destination), 'STK-0002.json')) { arrived(); await gate; }
    return rename(from, to);
  });
  const linking = store.relink(destination, bindingKey(old));
  await ready;
  const forgetting = store.forgetMoved(destination, bindingKey(old)).then(() => 'forgotten', () => 'refused');
  // Give the independent delete a chance to finish while publication is deliberately suspended.
  await Promise.race([forgetting, new Promise((r) => setTimeout(r, 100))]);
  resume();
  await linking;
  assert.equal(await forgetting, 'refused', 'once moved, the old location must not report successful deletion');
  assert.ok(await store.read(destination, 'STK-0002'));
});

// ---- the service: suggestions, remembering, and the lifecycle -------------------------------------------------

/** Fictional stakeholders, models with Recognize known voices on, and an engine whose embed job returns `vectors`. */
function fakes(ws: string, options: { people?: { id: string; name: string }[]; vectors?: () => (number[] | null)[]; enabled?: boolean } = {}) {
  const calls: { wav: string; intervals: unknown[] }[] = [];
  const models = {
    readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto', speakers: true, recognize_voices: options.enabled ?? true }),
    installedPath: async () => '/fictional/models',
  } as unknown as TranscriptionModelService;
  const engine = { embed: async (wav: string, intervals: unknown[]) => { calls.push({ wav, intervals }); return options.vectors ? options.vectors() : intervals.map(() => voice(1)); } } as unknown as TranscriptionEngine;
  const stakeholders = { listStakeholders: async () => options.people ?? [{ id: 'STK-0002', name: 'Kim Park' }, { id: 'STK-0003', name: 'Jo Lin' }] } as unknown as StakeholderService;
  return { models, engine, stakeholders, calls };
}

/** A fictional WAV of silence, as a queued recording. */
function silentWav(seconds = 2): Buffer {
  const data = Buffer.alloc(16000 * 2 * seconds);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** A workspace with a queued, transcribed recording whose Speaker 1 and Speaker 2 have stretches of their own. */
async function transcribedMeeting(t: { after: (fn: () => Promise<void>) => void }) {
  const ws = await tmp(t, 'gtd-ws-');
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = ws;
  const models = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = path.join(ws, '.models');
  t.after(async () => {
    await MeetingTranscriptionService.settled();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH; else process.env.ESB_WORKSPACE_PATH = previous;
    if (models === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = models;
  });
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(ws, d), { recursive: true });
  const queue = new MeetingDigestService();
  const m = await queue.createMeeting({ title: 'Fictional weekly sync', meeting_date: '2026-11-02', participants: [{ name: 'Kim Park', ref: 'STK-0002' }] });
  await queue.addFile(m.id, 'call.wav', silentWav());
  const transcript = '[00:00:00 → 00:00:05] Speaker 1\n  Fictional words.\n\n[00:00:05 → 00:00:09] Speaker 2\n  More fictional words.\n';
  await queue.addFile(m.id, 'call.transcript.md', Buffer.from(transcript));
  const sha = (await queue.loadMeeting(m.id)).files.find((f) => f.name === 'call.transcript.md')!.sha256;
  await queue.withQueue(async () => {
    const meeting = await queue.loadMeeting(m.id);
    const entry = meeting.files.find((f) => f.name === 'call.wav')!;
    entry.recording = {
      status: 'done', transcript: 'call.transcript.md', transcript_sha256: sha, seconds: 9,
      speaker_voices: { transcript_sha256: sha, voices: [{ label: 'Speaker 1', intervals: [[0.2, 1.9]], seconds: 1.7 }, { label: 'Speaker 2', intervals: [], seconds: 0 }] },
      speaker_suggestions: { transcript_sha256: sha, model_sha256: VOICE_MODEL.sha256, items: [{ label: 'Speaker 1', ref: 'STK-0002', score: 0.91 }, { label: 'Speaker 2', ref: 'STK-0003', score: 0.88 }] },
    };
    await queue.saveMeeting(meeting);
  });
  return { ws, queue, id: m.id, sha };
}

test('remembering a voice: only a speaker named with a stakeholder, with consent the first time, from the confirmed recording', async (t) => {
  const { ws, queue, id, sha } = await transcribedMeeting(t);
  const root = await tmp(t);
  const store = new VoiceprintStore(() => root);
  const f = fakes(ws);
  const service = new VoiceprintService(store, f.engine, f.models, queue, f.stakeholders, () => ws);
  const transcription = new MeetingTranscriptionService(queue, f.models, {} as TranscriptionEngine);
  const src = { kind: 'queue', meeting: id, file: 'call.wav', transcript_sha256: sha };

  await assert.rejects(service.remember({ source: src, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' }), /Name Speaker 1 with a stakeholder first/);
  await transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Sam Rot' } } });
  await assert.rejects(service.remember({ source: src, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' }), /stakeholder first/, 'a typed name is not a person to remember');
  await transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' }, 'Speaker 2': { name: 'Jo Lin', ref: 'STK-0003' } } });
  await assert.rejects(service.remember({ source: src, label: 'Speaker 1' }), /consent/);
  await assert.rejects(service.remember({ source: src, label: 'Speaker 2', consent: true, consent_ref: 'STK-0003' }), /too little speech of their own/);
  await assert.rejects(service.remember({ source: { ...src, transcript_sha256: 'f'.repeat(64) }, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' }), /changed meanwhile/);
  assert.equal(f.calls.length, 0, 'nothing was read before every check passed');

  const view = await service.remember({ source: src, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' });
  assert.equal(view.ref, 'STK-0002');
  assert.equal(view.name, 'Kim Park');
  assert.deepEqual(f.calls[0]!.intervals, [{ start: 0.2, end: 1.9 }], 'only the speaker\'s own stretches are read');
  const print = (await store.read(ws, 'STK-0002'))!;
  assert.equal(print.samples[0]!.source.transcript_sha256, sha);
  assert.equal(print.consent.person, 'Kim Park');

  // Their page: how it stands, the consent, each sample with its meeting; never the voice itself.
  await service.remember({ source: { ...src, transcript_sha256: sha }, label: 'Speaker 1' }).catch(() => {});
  const detail = await service.detail('STK-0002');
  assert.equal(detail.voice?.name, 'Kim Park');
  assert.equal(detail.voice?.consent?.person, 'Kim Park');
  assert.deepEqual(detail.samples.map((s) => [s.meeting, s.title, s.label, s.kind]), [[id, 'Fictional weekly sync', 'Speaker 1', 'queue']]);
  assert.doesNotMatch(JSON.stringify(detail), /embedding|centroid/, 'no voice data leaves the store');
  assert.equal((await service.detail('STK-0003')).voice, null, 'no voice remembered');
  await assert.rejects(service.detail('../x'), /Invalid person/);
  await assert.rejects(service.removeSample('STK-0002', 'nothex'), /Invalid sample/);
  await assert.rejects(service.removeSample('STK-0002', 'f'.repeat(16)), /No such sample/);
  // A second sample from another recording, then removing one keeps the voice; removing the last forgets it.
  await store.addSample(ws, { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, sample: sample('MQ-2026-0042'), consent: null, expect: await store.snapshot(ws, 'STK-0002'), stillConfirmed: async () => true });
  const two = await service.detail('STK-0002');
  assert.equal(two.samples.length, 2);
  assert.equal(two.samples[0]!.title, null, 'a meeting that is not here is listed without a title');
  assert.deepEqual(await service.removeSample('STK-0002', two.samples[0]!.key), { left: true });
  assert.deepEqual((await service.detail('STK-0002')).samples.map((s) => s.meeting), [id]);
  assert.deepEqual(await service.removeSample('STK-0002', two.samples[1]!.key), { left: false });
  assert.equal(await store.read(ws, 'STK-0002'), null, 'the last sample takes the voice and its consent');
  await service.remember({ source: src, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' });

  // Off in Settings: nothing is remembered.
  const off = new VoiceprintService(store, fakes(ws, { enabled: false }).engine, fakes(ws, { enabled: false }).models, queue, f.stakeholders, () => ws);
  await assert.rejects(off.remember({ source: src, label: 'Speaker 1' }), /Turn on Recognize known voices/);
  // A recording whose bytes changed is never read.
  await fsp.appendFile(path.join(await queue.meetingFolder(id), 'call.wav'), Buffer.alloc(2));
  await assert.rejects(service.remember({ source: src, label: 'Speaker 1' }), /recording changed/);
});

test('consent from an open dialog cannot enroll a speaker renamed to another person', async (t) => {
  const { ws, queue, id, sha } = await transcribedMeeting(t);
  const store = new VoiceprintStore(() => path.join(ws, '.private-voices'));
  const f = fakes(ws);
  const service = new VoiceprintService(store, f.engine, f.models, queue, f.stakeholders, () => ws);
  const transcription = new MeetingTranscriptionService(queue, f.models, {} as TranscriptionEngine);
  await transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Jo Lin', ref: 'STK-0003' } } });
  const request = { source: { kind: 'queue', meeting: id, file: 'call.wav', transcript_sha256: sha }, label: 'Speaker 1', consent: true };
  await assert.rejects(service.remember({ ...request, consent_ref: 'STK-0002' }), /name changed/);
  await assert.rejects(service.remember(request), /consent.*person/);
  assert.equal(f.calls.length, 0, 'stale or unbound consent never starts extraction');
  assert.deepEqual(await store.list(ws), []);
});

test('renaming a speaker drops the samples it gave; a later confirmation adds one; a deleted stakeholder is never suggested', async (t) => {
  const { ws, queue, id, sha } = await transcribedMeeting(t);
  const root = await tmp(t);
  const store = new VoiceprintStore(() => root);
  let people = [{ id: 'STK-0002', name: 'Kim Park' }, { id: 'STK-0003', name: 'Jo Lin' }];
  const f = fakes(ws);
  const stakeholders = { listStakeholders: async () => people } as unknown as StakeholderService;
  const service = new VoiceprintService(store, f.engine, f.models, queue, stakeholders, () => ws);
  const transcription = new MeetingTranscriptionService(queue, f.models, {} as TranscriptionEngine);
  const src = { kind: 'queue' as const, meeting: id, file: 'call.wav', transcript_sha256: sha };
  await transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } } });
  await service.remember({ source: src, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' });
  assert.equal((await store.read(ws, 'STK-0002'))!.samples.length, 1);

  // Kim's name taken back from Speaker 1: the sample it gave goes, and with it the print.
  await transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': null } });
  await service.afterNaming(src, ['Speaker 1'], []);
  assert.equal(await store.read(ws, 'STK-0002'), null);

  // Remembered again, then a later confirmation (naming Kim again on this transcript) adds by itself, without consent.
  await transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } } });
  await service.remember({ source: src, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' });
  const calls = f.calls.length;
  await service.afterNaming(src, ['Speaker 1'], [{ label: 'Speaker 1', name: 'Kim Park', ref: 'STK-0002' }]);
  assert.equal(f.calls.length, calls + 1, 'the confirmation was read again');
  assert.equal((await store.read(ws, 'STK-0002'))!.samples.length, 1, 'the same transcript replaces its sample, never doubles it');

  // A later confirmation of a speaker that does not sound like Kim adds nothing (a merged or misnamed speaker).
  let vectors: (number[] | null)[] = [voice(30)];
  const strict = new VoiceprintService(store, { embed: async () => vectors } as unknown as TranscriptionEngine, f.models, queue, stakeholders, () => ws);
  await assert.rejects(strict.remember({ source: src, label: 'Speaker 1' }), /does not sound like Kim Park/);
  vectors = [voice(1, 0.3)];
  await strict.remember({ source: src, label: 'Speaker 1' });

  // Print is long enough to suggest (fictional seconds), then the stakeholder file goes by hand: never suggested.
  const known = await service.known();
  assert.deepEqual(known.map((k) => k.ref), ['STK-0002']);
  people = people.filter((p) => p.id !== 'STK-0002');
  assert.deepEqual(await service.known(), [], 'reconciled before every comparison');
  assert.equal((await service.view()).prints[0]!.stakeholder, false, 'still listed, to be forgotten');
  await service.stakeholderDeleted('STK-0002');
  assert.deepEqual((await service.view()).prints, []);
});

test('suggestions: computed only for known voices, Use is refused when stale, Not them hides one', async (t) => {
  const { ws, queue, id, sha } = await transcribedMeeting(t);
  const f = fakes(ws);
  const transcription = new MeetingTranscriptionService(queue, f.models, {} as TranscriptionEngine);
  // A Use made with another speaker model, or for a suggestion no longer there, is refused.
  await assert.rejects(transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Jo Lin', ref: 'STK-0003' } } }, { label: 'Speaker 1', ref: 'STK-0003', model_sha256: VOICE_MODEL.sha256 }), /no longer there/);
  await assert.rejects(transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } } }, { label: 'Speaker 1', ref: 'STK-0002', model_sha256: 'c'.repeat(64) }), /no longer there/);
  const used = await transcription.nameSpeakers(id, 'call.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } } }, { label: 'Speaker 1', ref: 'STK-0002', model_sha256: VOICE_MODEL.sha256 });
  assert.deepEqual(used.files.find((f) => f.name === 'call.wav')!.recording!.speaker_names!.names, [{ label: 'Speaker 1', name: 'Kim Park', ref: 'STK-0002' }]);
  // Not them: the suggestion goes, nothing else changes.
  await assert.rejects(transcription.dismissSuggestion(id, 'call.wav', 'f'.repeat(64), 'Speaker 2'), /changed meanwhile/);
  const dismissed = await transcription.dismissSuggestion(id, 'call.wav', sha, 'Speaker 2');
  assert.deepEqual(dismissed.files.find((f) => f.name === 'call.wav')!.recording!.speaker_suggestions!.items.map((i) => i.label), ['Speaker 1']);
  await assert.rejects(transcription.dismissSuggestion(id, 'call.wav', sha, 'Speaker 2'), /no longer there/);

  // The service: no remembered voice, no suggestion; a stale print is never compared.
  const root = await tmp(t);
  const store = new VoiceprintStore(() => root);
  const service = new VoiceprintService(store, f.engine, f.models, queue, f.stakeholders, () => ws);
  const heard = [{ label: 'Speaker 1', intervals: [], seconds: 20, centroid: voice(1, 0.1) }];
  assert.equal(await service.suggest(heard, ['STK-0002']), undefined);
  await store.addSample(ws, { ref: 'STK-0002', name: 'Kim Park', model: { id: 'speaker-detection', sha256: 'c'.repeat(64) }, sample: sample(id), consent, expect: await store.snapshot(ws, 'STK-0002'), stillConfirmed: async () => true });
  assert.equal(await service.suggest(heard, ['STK-0002']), undefined, 'made with another model');
  await store.forget(ws, 'STK-0002');
  await store.addSample(ws, { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, sample: sample(id), consent, expect: await store.snapshot(ws, 'STK-0002'), stillConfirmed: async () => true });
  const found = await service.suggest(heard, ['STK-0002']);
  assert.equal(found?.model_sha256, VOICE_MODEL.sha256);
  assert.deepEqual(found?.items.map((i) => [i.label, i.ref]), [['Speaker 1', 'STK-0002']]);
  assert.ok(found!.items[0]!.score > 0.95);
});

test('a transcription with speakers stores where each speaks alone and its suggestions, never a voice', async (t) => {
  const { ws, queue } = await transcribedMeeting(t);
  const root = await tmp(t);
  // Kim's voice is remembered, Recognize known voices is on.
  const store = new VoiceprintStore(() => root);
  await store.addSample(ws, { ref: 'STK-0002', name: 'Kim Park', model: VOICE_MODEL, sample: sample('MQ-2026-0001'), consent, expect: await store.snapshot(ws, 'STK-0002'), stillConfirmed: async () => true });
  const m = await queue.createMeeting({ title: 'Fictional follow-up', meeting_date: '2026-11-03', participants: [{ name: 'Kim Park', ref: 'STK-0002' }] });
  await queue.addFile(m.id, 'next.wav', silentWav());
  await queue.queue(m.id);
  let identified: boolean | undefined;
  const engine = {
    transcribeWithSpeakers: async (_wav: string, o: { identify?: boolean; onSegment?: (s: unknown) => void }) => {
      identified = o.identify;
      const segments = [{ start: 0, end: 4, text: 'Fictional words.', speaker: 1 }, { start: 4, end: 8, text: 'Other fictional words.', speaker: 2 }];
      for (const s of segments) o.onSegment?.(s);
      return {
        segments, seconds: 8, load_ms: 1, speaker_note: null,
        voices: [
          { label: 'Speaker 1', intervals: [{ start: 0.2, end: 3.8 }], seconds: 20, centroid: voice(1, 0.05) },
          { label: 'Speaker 2', intervals: [{ start: 4.2, end: 7.8 }], seconds: 20, centroid: voice(40) },
        ],
      };
    },
  } as unknown as TranscriptionEngine;
  const models = {
    readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto', speakers: true, recognize_voices: true }),
    installedPath: async () => '/fictional/model',
  } as unknown as TranscriptionModelService;
  const f = fakes(ws);
  const transcription = new MeetingTranscriptionService(queue, models, engine, new VoiceprintService(store, f.engine, f.models, queue, f.stakeholders, () => ws));
  await transcription.tick();
  await MeetingTranscriptionService.settled();
  const r = (await queue.loadMeeting(m.id)).files.find((f) => f.name === 'next.wav')!.recording!;
  assert.equal(r.status, 'done');
  assert.equal(identified, true, 'voices were compared: one is remembered');
  assert.deepEqual(r.speaker_voices, { transcript_sha256: r.transcript_sha256, voices: [{ label: 'Speaker 1', intervals: [[0.2, 3.8]], seconds: 20 }, { label: 'Speaker 2', intervals: [[4.2, 7.8]], seconds: 20 }] });
  assert.deepEqual(r.speaker_suggestions?.items.map((i) => [i.label, i.ref]), [['Speaker 1', 'STK-0002']], 'Kim suggested; the unknown voice gets nothing');
  assert.equal(r.speaker_names, undefined, 'a suggestion is never a name');
  const manifest = await fsp.readFile(path.join(await queue.meetingFolder(m.id), 'meeting.md'), 'utf-8');
  assert.doesNotMatch(manifest, /centroid|embedding/, 'no voice is written to the workspace');
});

// ---- a kept meeting's Transcribe again version -----------------------------------------------------------------

test('a Transcribe again version keeps its own speakers, named through the meeting folder\'s lock, refusing stale clicks', async (t) => {
  const ws = await tmp(t, 'gtd-ws-');
  const id = 'MQ-2026-0042';
  const dir = path.join(ws, 'meetings', id);
  await fsp.mkdir(path.join(dir, 'v1'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'audio'), { recursive: true });
  const { createHash } = await import('node:crypto');
  const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
  const audio = silentWav();
  await fsp.writeFile(path.join(dir, 'audio', 'call.wav'), audio);
  await fsp.writeFile(path.join(dir, 'v1', 'call.transcript.md'), 'Reviewed fictional text.');
  await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify({
    schema: 1, id, update_id: 'CU-2026-0001', current: 'v1',
    versions: [{ id: 'v1', at: '2026-11-01T10:00:00.000Z', made_from: 'review', files: [{ name: 'call.transcript.md', sha256: hash('Reviewed fictional text.') }] }],
    audio: [{ name: 'call.wav', sha256: hash(audio) }],
  }));
  await requestTranscription(ws, id, { file: 'call.wav', transcript: 'call.transcript.md', model: 'whisper-large-v3-turbo', language: 'auto', speakers: true });
  const pending = (await readFolder(ws, id) as { manifest: { transcribe: Parameters<typeof import('../src/services/meetingVersions').requestIdentity>[0] } }).manifest.transcribe;
  const { requestIdentity } = await import('../src/services/meetingVersions');
  const job = { generation: '11111111-1111-4111-8111-111111111111', token: 'fictional-token' };
  assert.ok(await claimTranscription(ws, id, requestIdentity(pending), { ...job, model: 'whisper-large-v3-turbo', language: 'auto' }));
  const content = Buffer.from('[00:00:00 → 00:00:05] Speaker 1\n  Fictional.\n');
  const v2 = await publishTranscription(ws, id, job, {
    content, model: 'whisper-large-v3-turbo', language: 'auto',
    speakers: { voices: [{ label: 'Speaker 1', intervals: [[0.2, 4.8]], seconds: 4.6 }], suggestions: { model_sha256: VOICE_MODEL.sha256, items: [{ label: 'Speaker 1', ref: 'STK-0002', score: 0.9 }] } },
  });
  assert.equal(v2, 'v2');
  const folder = await readFolder(ws, id);
  assert.equal(folder.state, 'ok');
  const version = (folder as { manifest: { versions: { id: string; speakers?: { transcript_sha256: string } }[] } }).manifest.versions.find((v) => v.id === 'v2')!;
  assert.equal(version.speakers!.transcript_sha256, hash(content));
  const target = { version: 'v2', transcript_sha256: hash(content) };

  await assert.rejects(nameVersionSpeakers(ws, id, { ...target, transcript_sha256: 'f'.repeat(64) }, { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } }), /changed meanwhile/);
  await assert.rejects(nameVersionSpeakers(ws, id, { version: 'v1', transcript_sha256: target.transcript_sha256 }, {}), /not told apart/, 'the reviewed version keeps its record\'s names');
  await assert.rejects(nameVersionSpeakers(ws, id, target, { 'Speaker 7': { name: 'Kim Park' } }), /no Speaker 7/);
  await assert.rejects(nameVersionSpeakers(ws, id, target, { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } }, { label: 'Speaker 1', ref: 'STK-0002', model_sha256: 'c'.repeat(64) }), /no longer there/);
  const named = await nameVersionSpeakers(ws, id, target, { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } }, { label: 'Speaker 1', ref: 'STK-0002', model_sha256: VOICE_MODEL.sha256 });
  assert.deepEqual(named.after, [{ label: 'Speaker 1', name: 'Kim Park', ref: 'STK-0002' }]);
  assert.equal(named.manifest.current, 'v1', 'naming never switches the current version');
  await dismissVersionSuggestion(ws, id, target, 'Speaker 1');
  await assert.rejects(dismissVersionSuggestion(ws, id, target, 'Speaker 1'), /no longer there/);

  // A voice remembered from the version's kept recording is stored as readable as any other (found in the desktop app:
  // a folder sample without its file name made the whole print unreadable).
  const root = await tmp(t);
  const store = new VoiceprintStore(() => root);
  const f = fakes(ws);
  const service = new VoiceprintService(store, f.engine, f.models, new MeetingDigestService(), f.stakeholders, () => ws);
  const view = await service.remember({ source: { kind: 'folder', meeting: id, ...target }, label: 'Speaker 1', consent: true, consent_ref: 'STK-0002' });
  assert.equal(view.damaged, false);
  const print = await store.read(ws, 'STK-0002');
  assert.ok(print, 'the print can be read back');
  assert.deepEqual({ ...print!.samples[0]!.source }, { kind: 'folder', meeting: id, file: 'call.wav', version: 'v2', audio_sha256: hash(audio), transcript_sha256: target.transcript_sha256, label: 'Speaker 1' });
  assert.deepEqual(f.calls[0]!.intervals, [{ start: 0.2, end: 4.8 }]);
  // A damaged speakers entry is left out, never the meeting.
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'meeting.json'), 'utf-8'));
  raw.versions[1].speakers.transcript_sha256 = 'f'.repeat(64);
  await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify(raw));
  const reread = await readFolder(ws, id);
  assert.equal(reread.state, 'ok');
  assert.equal((reread as { manifest: { versions: { speakers?: unknown }[] } }).manifest.versions[1]!.speakers, undefined);
});

test('ids reach paths only rebuilt from their numbers', async () => {
  const { canonicalMeetingId } = await import('../src/services/meetingLibrary');
  assert.equal(canonicalMeetingId('MQ-2026-0001'), 'MQ-2026-0001');
  assert.equal(canonicalMeetingId('CU-2026-0003-M-01'), 'CU-2026-0003-M-01');
  assert.equal(canonicalMeetingId('CU-2026-0003'), 'CU-2026-0003');
  for (const bad of ['../MQ-2026-0001', 'MQ-2026-0001/..', 'MQ-26-1', 'CU-2026-0003-M-1', '', 7, null]) assert.equal(canonicalMeetingId(bad), null, String(bad));
  assert.equal(parseVoiceSource({ kind: 'folder', meeting: 'MQ-2026-0001', version: 'v0012', transcript_sha256: 'a'.repeat(64) }).kind === 'folder' && (parseVoiceSource({ kind: 'folder', meeting: 'MQ-2026-0001', version: 'v12', transcript_sha256: 'a'.repeat(64) }) as { version: string }).version, 'v12');
});

test('requests and stored data are checked before use', () => {
  assert.throws(() => parseVoiceSource({ kind: 'queue', meeting: '../x', file: 'a.wav', transcript_sha256: 'a'.repeat(64) }), /Invalid meeting/);
  assert.throws(() => parseVoiceSource({ kind: 'queue', meeting: 'MQ-2026-0001', file: '../a.wav', transcript_sha256: 'a'.repeat(64) }));
  assert.throws(() => parseVoiceSource({ kind: 'folder', meeting: 'MQ-2026-0001', version: 'v1/../..', transcript_sha256: 'a'.repeat(64) }), /Invalid version/);
  assert.throws(() => parseVoiceSource({ kind: 'other' }), /transcript_sha256/);
  assert.deepEqual(parseVoiceSource({ kind: 'folder', meeting: 'MQ-2026-0001', version: 'v2', transcript_sha256: 'a'.repeat(64) }), { kind: 'folder', meeting: 'MQ-2026-0001', version: 'v2', transcript_sha256: 'a'.repeat(64) });
  const sha = 'a'.repeat(64);
  assert.deepEqual(parseSpeakerVoices({ transcript_sha256: sha, voices: [{ label: 'Speaker 1', intervals: [[1, 2]], seconds: 1 }, { label: 'Speaker 1', intervals: [] }, { label: 'x', intervals: [] }, { label: 'Speaker 2', intervals: [[2, 1]] }] })?.voices,
    [{ label: 'Speaker 1', intervals: [[1, 2]], seconds: 1 }], 'each label once, only increasing stretches');
  assert.deepEqual(parseSpeakerSuggestions({ transcript_sha256: sha, model_sha256: sha, items: [{ label: 'Speaker 1', ref: 'STK-0002', score: 0.9 }, { label: 'Speaker 2', ref: 'GRP-0001', score: 0.9 }, { label: 'Speaker 3', ref: 'me', score: 2 }] })?.items,
    [{ label: 'Speaker 1', ref: 'STK-0002', score: 0.9 }]);
});

// ---- the real model (the CI job "Transcription (real model)" downloads SenseVoice, the speaker model and samples) ----

const realModels = process.env['STT_TEST_MODELS'];
const realAudio = process.env['STT_TEST_AUDIO'];
const realSkip = !realModels || !realAudio || !fs.existsSync(path.join(realModels, 'speaker-detection')) || !fs.existsSync(path.join(realModels, 'sensevoice-2024-07-17'))
  ? 'set STT_TEST_MODELS, with SenseVoice and the speaker model, and STT_TEST_AUDIO to run' : false;

test('real model: a remembered voice is suggested again, and a voice never remembered is not', { skip: realSkip }, async (t) => {
  const { TranscriptionEngine } = await import('../src/services/transcription/engine');
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = realModels;
  t.after(() => { if (previous === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = previous; });
  const dir = await tmp(t, 'gtd-voices-real-');
  // Two voices taking turns: the English sample, then the Japanese one, eight times. Long enough for many clean
  // stretches per voice, so the voices message is large (found in the desktop app: a large one was lost when the
  // worker ended before it was written, and the speakers job failed).
  const [en, ja] = await Promise.all(['en.wav', 'ja.wav'].map((n) => fsp.readFile(path.join(realAudio!, n))));
  const body = Buffer.concat(Array.from({ length: 8 }, () => [en!.subarray(44), ja!.subarray(44)]).flat());
  const head = Buffer.from(en!.subarray(0, 44));
  head.writeUInt32LE(36 + body.length, 4);
  head.writeUInt32LE(body.length, 40);
  const wav = path.join(dir, 'two.wav');
  await fsp.writeFile(wav, Buffer.concat([head, body]));

  const engine = new TranscriptionEngine();
  const result = await engine.transcribeWithSpeakers(wav, { model: 'sensevoice-2024-07-17', language: 'auto', identify: true });
  assert.equal(result.speaker_note, null, 'finding speakers and their voices did not fail');
  assert.ok(result.voices.every((v) => (v.samples?.length ?? 0) >= 5), `many samples per voice: ${result.voices.map((v) => v.samples?.length)}`);
  const labelOf = (text: RegExp) => `Speaker ${result.segments.find((s) => text.test(s.text))!.speaker}`;
  const english = result.voices.find((v) => v.label === labelOf(/tribal/i))!;
  const japanese = result.voices.find((v) => v.label === labelOf(/中学/))!;
  assert.ok(english && japanese && english !== japanese, 'both voices have a label');
  assert.ok(english.centroid && japanese.centroid && english.intervals.length > 0, 'each has clean speech and a mean');
  assert.equal(english.centroid!.length, 512);

  // Remember the English voice from its clean stretches, the way Remember voice does.
  const embeddings = await engine.embed(wav, english.intervals);
  assert.equal(embeddings.length, english.intervals.length);
  const print = centroid(embeddings.filter((e): e is number[] => e !== null))!;
  assert.ok(cosine(print, english.centroid!) > 0.9, 'the same speech gives the same voice');
  assert.equal(TranscriptionEngine.isBusy(), false, 'the embedding job never holds the slot');

  const heard = result.voices.map((v) => ({ label: v.label, centroid: v.centroid!, seconds: v.seconds }));
  const found = suggestSpeakers(heard, [{ ref: 'STK-0001', centroid: print, seconds: 30 }], new Set(['STK-0001']));
  assert.deepEqual(found.map((s) => [s.label, s.ref]), [[english.label, 'STK-0001']], 'the English voice, and only it');
  console.log(`[real model] remembered voice ${found[0]!.score}; voice never remembered ${cosine(print, japanese.centroid!).toFixed(2)}`);
});
