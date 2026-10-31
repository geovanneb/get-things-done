import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { readSpeeds, runSpeedTest, SPEED_SAMPLES } from '../src/services/transcription/speedTest';
import type { TranscriptionEngine } from '../src/services/transcription/engine';

async function modelsFolder(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-speed-'));
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_MODELS_PATH;
    else process.env.ESB_MODELS_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A fictional sample: a 44-byte header and a second of 16 kHz mono silence. */
const sample = Buffer.concat([Buffer.alloc(44), Buffer.alloc(32_000)]);
const list = [{ name: 'a.wav', url: 'https://example.invalid/a.wav', size: sample.length, sha256: createHash('sha256').update(sample).digest('hex') }];

function fakeFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return new Response(sample); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** An engine that takes `ms` to transcribe, plus a model load it reports. */
function fakeEngine(ms: number, loadMs = 0) {
  const seen: { wav: string; size: number }[] = [];
  const engine = {
    transcribe: async (wav: string) => {
      seen.push({ wav, size: (await fsp.stat(wav)).size });
      await new Promise((r) => setTimeout(r, ms + loadMs));
      return { segments: [{ start: 0, end: 1, text: 'Fictional speech.' }], seconds: 0, load_ms: loadMs };
    },
  } as unknown as TranscriptionEngine;
  return { engine, seen };
}

test('the speed test measures speech per second of work, without the model load, and keeps it for this computer', async (t) => {
  const dir = await modelsFolder(t);
  const { calls, fetchImpl } = fakeFetch();
  const { engine, seen } = fakeEngine(400, 300);
  const result = await runSpeedTest(engine, 'fictional-model', fetchImpl, list);
  // 4 repeats of a 1-second sample in about 0.4 s of work, the 0.3 s load not counted.
  assert.ok(result.realtime_x > 6 && result.realtime_x < 12, String(result.realtime_x));
  assert.equal(result.load_ms, 300);
  assert.equal(seen[0]!.size, 44 + 4 * 32_000, 'the sample repeated to make the test long enough');
  await assert.rejects(fsp.access(seen[0]!.wav), 'the test recording is removed');
  assert.deepEqual(Object.keys(await readSpeeds()), ['fictional-model']);

  // The sample is downloaded once.
  await runSpeedTest(fakeEngine(10).engine, 'other-model', fetchImpl, list);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(await readSpeeds()).sort(), ['fictional-model', 'other-model']);

  // A result measured on another computer (a synced home folder) is not shown.
  const file = path.join(dir, 'speed-test', 'fictional-model.json');
  await fsp.writeFile(file, JSON.stringify({ ...JSON.parse(await fsp.readFile(file, 'utf-8')), cpu: 'Another computer × 2' }));
  assert.deepEqual(Object.keys(await readSpeeds()), ['other-model']);

  // A damaged file is ignored, and testing again replaces it; an impossible speed is never shown.
  await fsp.writeFile(file, '{ damaged');
  assert.deepEqual(Object.keys(await readSpeeds()), ['other-model']);
  await runSpeedTest(fakeEngine(10).engine, 'fictional-model', fetchImpl, list);
  assert.deepEqual(Object.keys(await readSpeeds()).sort(), ['fictional-model', 'other-model']);
  await fsp.writeFile(path.join(dir, 'speed-test', 'other-model.json'), '{"realtime_x": 1e400, "cpu": "x"}');
  assert.deepEqual(Object.keys(await readSpeeds()), ['fictional-model']);
});

test('a sample that does not match its checksum is never used, and a damaged one on disk is fetched again', async (t) => {
  const dir = await modelsFolder(t);
  const wrong = (async () => new Response(Buffer.from('not the sample'))) as unknown as typeof fetch;
  await assert.rejects(runSpeedTest(fakeEngine(1).engine, 'm', wrong, list), /did not match its checksum/);
  const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(runSpeedTest(fakeEngine(1).engine, 'm', down, list), (e: { statusCode?: number; message: string }) => e.statusCode === 424 && /could not be downloaded \(503\)/.test(e.message));

  const { calls, fetchImpl } = fakeFetch();
  await runSpeedTest(fakeEngine(1).engine, 'm', fetchImpl, list);
  await fsp.writeFile(path.join(dir, 'speed-test', 'a.wav'), 'damaged');
  await runSpeedTest(fakeEngine(1).engine, 'm', fetchImpl, list);
  assert.equal(calls.length, 2);
});

test('the real samples are pinned by address, size and checksum', () => {
  assert.equal(SPEED_SAMPLES.length, 2);
  for (const s of SPEED_SAMPLES) {
    assert.match(s.url, /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/test_wavs\/(en|ja)\.wav$/);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.ok(s.size > 100_000);
  }
});

test('a sample download larger than expected is stopped as it arrives', async (t) => {
  await modelsFolder(t);
  let sent = 0;
  const endless = (async () => new Response(new ReadableStream({
    pull(controller) { sent += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)); },
  }))) as unknown as typeof fetch;
  await assert.rejects(runSpeedTest(fakeEngine(1).engine, 'm', endless, list), /did not match its checksum/);
  assert.ok(sent < 1024 * 1024, `stopped after ${sent} bytes`);
});

test('a speed test says why the engine failed, and a busy engine stays busy', async (t) => {
  await modelsFolder(t);
  const { fetchImpl } = fakeFetch();
  const failing = (err: Error) => ({ transcribe: async () => { throw err; } }) as unknown as TranscriptionEngine;
  await assert.rejects(runSpeedTest(failing(new Error('The transcription engine failed: fictional')), 'm', fetchImpl, list),
    (err: Error & { statusCode?: number }) => err.statusCode === 424 && err.message === 'The speed test failed: The transcription engine failed: fictional');
  const deaf = { transcribe: async () => ({ segments: [], seconds: 0, load_ms: 0 }) } as unknown as TranscriptionEngine;
  await assert.rejects(runSpeedTest(deaf, 'm', fetchImpl, list), (err: Error & { statusCode?: number }) => err.statusCode === 424 && /found no speech/.test(err.message));
  const busy = Object.assign(new Error('A transcription is already running'), { statusCode: 409 });
  await assert.rejects(runSpeedTest(failing(busy), 'm', fetchImpl, list), (err: Error & { statusCode?: number }) => err.statusCode === 409);
});
