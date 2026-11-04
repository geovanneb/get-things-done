#!/usr/bin/env node
/**
 * Calibrates Recognize known voices (docs/voiceprints.md) on real meetings, locally, and prints only score
 * distributions: never names, file paths, audio or embeddings. Run `npm run build` first.
 *
 *   node scripts/voiceprint-calibration.mjs manifest.json [--model <embedding.onnx>]
 *
 * manifest.json (keep it private; person ids can be anything, such as "p1"):
 *   {
 *     "enroll": [ { "person": "p1", "wav": "/path/a.wav", "start": 12.0, "end": 14.5 }, ... ],
 *     "test":   [ { "person": "p1", "wav": "/path/b.wav", "start": 3.1, "end": 9.8, "expected": true }, ... ]
 *   }
 *
 * - `enroll`: stretches of one person speaking alone, as many as you like; each person's are averaged into a voice,
 *   the way the app does. Use speech only from people who agreed.
 * - `test`: stretches from other recordings. `person` is who really speaks (or a person never enrolled, to test the
 *   open set), `expected` whether the meeting expected them. Several stretches of one speaker in one recording can
 *   share a `group` id: they are averaged first, as one diarized speaker is. A group mixing two people (a `person`
 *   of the first stretch, other people's stretches added) tests what the app does with a speaker diarization merged.
 * WAV files only, 16 kHz mono preferred (others are resampled). Share the printed output, nothing else.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith('--'));
if (!manifestPath) {
  console.error('Usage: node scripts/voiceprint-calibration.mjs manifest.json [--model <embedding.onnx>]');
  process.exit(2);
}
const modelArg = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
const modelsDir = process.env.ESB_MODELS_PATH || path.join(os.homedir(), '.gtd', 'models');
const model = modelArg || path.join(modelsDir, 'speaker-detection', 'embedding.onnx');
if (!fs.existsSync(model)) {
  console.error(`No speaker model at ${model}: download Speaker detection in Settings > Transcription, or pass --model.`);
  process.exit(2);
}
let voices;
let matching;
try {
  voices = require(path.join(root, 'dist/server/services/transcription/voices.js'));
  matching = require(path.join(root, 'dist/server/services/voiceprints/matching.js'));
} catch {
  console.error('Run `npm run build` first: the script uses the app\'s own rules.');
  process.exit(2);
}
const sherpa = require('sherpa-onnx-node');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: Math.max(1, Math.min(4, os.availableParallelism() - 1)), debug: 0 });

const waves = new Map();
function slice(file, start, end) {
  if (!waves.has(file)) waves.set(file, sherpa.readWave(file));
  const w = waves.get(file);
  return { sampleRate: w.sampleRate, samples: w.samples.subarray(Math.max(0, Math.round(start * w.sampleRate)), Math.round(end * w.sampleRate)) };
}
function embed(entry) {
  if (!(entry.end - entry.start >= voices.MIN_SAMPLE_SECONDS)) return null;
  const s = slice(entry.wav, entry.start, entry.end);
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: s.sampleRate, samples: Float32Array.from(s.samples) });
  stream.inputFinished();
  return extractor.isReady(stream) ? Array.from(extractor.compute(stream, false)) : null;
}

// Enrolled voices: each person's stretches averaged.
const enrolled = new Map();
for (const e of manifest.enroll ?? []) {
  const v = embed(e);
  if (!v) continue;
  const p = enrolled.get(e.person) ?? { vectors: [], seconds: 0 };
  p.vectors.push(v);
  p.seconds += e.end - e.start;
  enrolled.set(e.person, p);
}
const known = [...enrolled].map(([ref, p]) => ({ ref, centroid: voices.centroid(p.vectors), seconds: p.seconds })).filter((k) => k.centroid);

// Test speakers: stretches of one group averaged, like one diarized speaker.
const groups = new Map();
(manifest.test ?? []).forEach((t, i) => {
  const key = t.group ?? `#${i}`;
  const g = groups.get(key) ?? { person: t.person, expected: t.expected === true, vectors: [], samples: [], seconds: 0 };
  const v = embed(t);
  if (v) { g.vectors.push(v); g.samples.push({ seconds: t.end - t.start, embedding: v }); g.seconds += t.end - t.start; }
  groups.set(key, g);
});

const same = [];
const wrongBest = [];
const unknownBest = [];
const margins = [];
const outcome = { right: 0, wrong: 0, none_known: 0, none_unknown: 0, skipped: 0 };
for (const [label, g] of groups) {
  const c = voices.centroid(g.vectors);
  if (!c) { outcome.skipped++; continue; }
  const scored = known.map((k) => ({ ref: k.ref, score: voices.cosine(c, k.centroid) })).sort((a, b) => b.score - a.score);
  const isKnown = known.some((k) => k.ref === g.person);
  const own = scored.find((s) => s.ref === g.person);
  if (own) same.push(own.score);
  const bestOther = scored.find((s) => s.ref !== g.person);
  if (bestOther) (isKnown ? wrongBest : unknownBest).push(bestOther.score);
  if (scored.length > 1) margins.push(scored[0].score - scored[1].score);
  const expected = new Set(g.expected ? [g.person] : []);
  const [s] = matching.suggestSpeakers([{ label, centroid: c, seconds: g.seconds, samples: g.samples }], known, expected);
  if (!s) outcome[isKnown ? 'none_known' : 'none_unknown']++;
  else if (s.ref === g.person) outcome.right++;
  else outcome.wrong++;
}

const pct = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))].toFixed(2) : '-');
const line = (name, xs) => `${name.padEnd(34)} n=${String(xs.length).padStart(3)}  min ${pct(xs, 0)}  p10 ${pct(xs, 0.1)}  median ${pct(xs, 0.5)}  p90 ${pct(xs, 0.9)}  max ${pct(xs, 0.999)}`;
const bins = (xs) => {
  const counts = new Array(10).fill(0);
  for (const x of xs) counts[Math.max(0, Math.min(9, Math.floor(x * 10)))]++;
  return counts.map((n, i) => `${(i / 10).toFixed(1)}:${n}`).join(' ');
};
console.log(`Voices enrolled: ${known.length}; speakers tested: ${groups.size}`);
const r = matching.MATCH_RULES;
console.log(`Rules: score ${r.score}, margin ${r.margin}, not expected ${r.unexpected}, print ${r.printSeconds} s, voice ${r.voiceSeconds} s, samples ${r.sampleScore} for ${r.consistency * 100}% of the speech`);
console.log(line('Same person', same));
console.log(line('Best other enrolled person', wrongBest));
console.log(line('Never enrolled: best enrolled', unknownBest));
console.log(line('Lead of the best over the second', margins));
console.log(`Histogram same person:     ${bins(same)}`);
console.log(`Histogram other / unknown: ${bins([...wrongBest, ...unknownBest])}`);
console.log(`With the rules: right ${outcome.right}, WRONG ${outcome.wrong}, no suggestion for an enrolled person ${outcome.none_known}, no suggestion for someone never enrolled ${outcome.none_unknown}, too short ${outcome.skipped}`);
