import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { modelsDir } from '../transcriptionModels';
import { atomicWrite } from '../../utils/atomicWrite';
import type { TranscriptionEngine } from './engine';

/**
 * How fast each downloaded model transcribes on this computer, measured on a sample of speech.
 *
 * The sample is two short recordings that come with the SenseVoice model's repository (English and Japanese, 7 s each),
 * downloaded once from their pinned address and checked by SHA-256, then repeated to about a minute of continuous
 * speech, so loading the model weighs little. The result is kept per model, with the processor it was measured on: a
 * result from another computer (a synced home folder) is not shown.
 */

const SAMPLE_BASE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs';
export const SPEED_SAMPLES = [
  { name: 'en.wav', url: `${SAMPLE_BASE}/en.wav`, size: 228908, sha256: 'eb1eb008904465b74c304aad8342e8c7d3c6e61ffe9f66adcaca9cf0f76a93f4' },
  { name: 'ja.wav', url: `${SAMPLE_BASE}/ja.wav`, size: 230444, sha256: '460bd8dccb0d2a5f4e29c628f837be4082d13defc64c3fc21dd1b6bb0e119095' },
];
/** The samples are 16 kHz mono 16-bit, like a recording made in the dashboard. */
const HEADER = 44;
const BYTES_PER_SECOND = 32_000;
/** How many times the pair is repeated: about a minute. */
const REPEAT = 4;

export interface SpeedResult {
  /** Seconds of speech transcribed per second of work, not counting loading the model. */
  realtime_x: number;
  load_ms: number | null;
  measured_at: string;
  /** The computer it was measured on. */
  cpu: string;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** One file per model, so two dashboards testing different models never overwrite each other's result. */
const speedDir = () => path.join(modelsDir(), 'speed-test');
const speedFile = (id: string) => path.join(speedDir(), `${id}.json`);
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,80}$/;
const thisComputer = () => `${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}`;

/** One saved result, or null when it is missing or damaged. */
async function readResult(file: string): Promise<SpeedResult | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as SpeedResult;
  } catch {
    return null;
  }
}

/** Reads a response, stopping as soon as it is larger than expected: a sample is small, and anything else is refused. */
async function readAtMost(res: Response, limit: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) throw httpError(424, 'The speed test sample could not be downloaded: empty response');
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read().catch((err: Error) => { throw httpError(424, `The speed test sample could not be downloaded: ${err.message}`); });
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw httpError(424, 'The speed test sample did not match its checksum; it was not used');
    }
    chunks.push(Buffer.from(value));
  }
}

/** The results measured on this computer, by model id. */
export async function readSpeeds(): Promise<Record<string, SpeedResult>> {
  const here = thisComputer();
  const out: Record<string, SpeedResult> = {};
  for (const name of await fsp.readdir(speedDir()).catch(() => [] as string[])) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!MODEL_ID.test(id)) continue;
    // A damaged or edited file is ignored; testing again replaces it.
    const r = await readResult(path.join(speedDir(), name));
    if (r && r.cpu === here && Number.isFinite(r.realtime_x) && r.realtime_x > 0 && r.realtime_x < 10_000) out[id] = r;
  }
  return out;
}

/** The samples, downloaded once and checked; a file that does not match is fetched again. */
async function samples(fetchImpl: typeof fetch, list: typeof SPEED_SAMPLES): Promise<Buffer[]> {
  const dir = speedDir();
  await fsp.mkdir(dir, { recursive: true });
  const out: Buffer[] = [];
  for (const s of list) {
    const file = path.join(dir, s.name);
    let data: Buffer | null = await fsp.readFile(file).catch(() => null);
    if (!data || createHash('sha256').update(data).digest('hex') !== s.sha256) {
      // Shown to the user as they are (a 5xx message would be hidden), so 424: the test depends on this download.
      const res = await fetchImpl(s.url, { signal: AbortSignal.timeout(60_000) }).catch((err: Error) => { throw httpError(424, `The speed test sample could not be downloaded: ${err.message}`); });
      if (!res.ok) throw httpError(424, `The speed test sample could not be downloaded (${res.status})`);
      if (Number(res.headers.get('content-length') ?? s.size) > s.size) throw httpError(424, 'The speed test sample did not match its checksum; it was not used');
      data = await readAtMost(res, s.size);
      if (data.length !== s.size || createHash('sha256').update(data).digest('hex') !== s.sha256) throw httpError(424, 'The speed test sample did not match its checksum; it was not used');
      await atomicWrite(file, data);
    }
    out.push(data);
  }
  return out;
}

function wavHeader(bytes: number): Buffer {
  const h = Buffer.alloc(HEADER);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(BYTES_PER_SECOND, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(bytes, 40);
  return h;
}

/** Measures one downloaded model on this computer and keeps the result. One transcription at a time, as always. */
export async function runSpeedTest(engine: TranscriptionEngine, id: string, fetchImpl: typeof fetch = fetch, list = SPEED_SAMPLES): Promise<SpeedResult> {
  const audio = (await samples(fetchImpl, list)).map((b) => b.subarray(HEADER));
  const body = Buffer.concat(Array.from({ length: REPEAT }, () => audio).flat());
  if (!MODEL_ID.test(id)) throw httpError(400, 'Invalid model');
  const wav = path.join(os.tmpdir(), `gtd-speed-${randomUUID()}.wav`);
  try {
    await fsp.writeFile(wav, Buffer.concat([wavHeader(body.length), body]), { mode: 0o600 });
    const started = Date.now();
    // Shown to the user as it is, like the download's: a failed engine is what the test is there to find.
    const result = await engine.transcribe(wav, { model: id, language: 'auto' }).catch((err: Error & { statusCode?: number }) => {
      throw err.statusCode ? err : httpError(424, `The speed test failed: ${err.message}`);
    });
    // The sample is speech, so an engine that hears none is not working, however fast it was.
    if (result.segments.length === 0) throw httpError(424, 'The speed test failed: the model found no speech in the sample.');
    const work = (Date.now() - started - (result.load_ms ?? 0)) / 1000;
    const seconds = body.length / BYTES_PER_SECOND;
    const speed: SpeedResult = {
      realtime_x: Math.round((seconds / Math.max(work, 0.05)) * 10) / 10,
      load_ms: result.load_ms,
      measured_at: new Date().toISOString(),
      cpu: thisComputer(),
    };
    await atomicWrite(speedFile(id), JSON.stringify(speed, null, 2));
    return speed;
  } finally {
    fs.rmSync(wav, { force: true });
  }
}
