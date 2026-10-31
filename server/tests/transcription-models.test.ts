import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { CATALOG, TranscriptionModelService, downloadLimits, languageFor, languagesFor, parseTranscriptionSettings, transcriptionEvents, type CatalogModel } from '../src/services/transcriptionModels';
import { SENSEVOICE_LANGUAGES, WHISPER_LANGUAGES, languageAt, parseLanguageChanges, withLanguageChange } from '../src/services/transcription/languages';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Fictional model files served locally, with range requests; `cut` drops the first full response of one file after some bytes. */
async function fileServer(t: { after: (fn: () => Promise<void> | void) => void }, files: Record<string, Buffer>, options: { cut?: { file: string; bytes: number }; ignoreRange?: boolean } = {}) {
  const requests: { path: string; range: string | null }[] = [];
  let cutDone = false;
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    const data = files[name];
    requests.push({ path: name, range: req.headers.range ?? null });
    if (!data) { res.writeHead(404).end(); return; }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m && !options.ignoreRange) {
      const start = Number(m[1]);
      if (start >= data.length) { res.writeHead(416).end(); return; }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}`, 'Content-Length': data.length - start });
      res.end(data.subarray(start));
      return;
    }
    res.writeHead(200, { 'Content-Length': data.length });
    if (options.cut?.file === name && !cutDone) {
      cutDone = true;
      res.write(data.subarray(0, options.cut.bytes), () => res.destroy());
      return;
    }
    res.end(data);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requests };
}

async function modelsFolder(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-models-'));
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = dir;
  t.after(async () => {
    await TranscriptionModelService.settled();
    if (previous === undefined) delete process.env.ESB_MODELS_PATH;
    else process.env.ESB_MODELS_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const encoder = Buffer.alloc(300_000, 7);
const tokens = Buffer.from('fictional tokens\n'.repeat(100));
const vadBytes = Buffer.alloc(5_000, 3);

function catalog(base: string, overrides: Partial<Record<'encoder' | 'tokens', string>> = {}): { models: CatalogModel[]; vad: CatalogModel } {
  const model: CatalogModel = {
    id: 'fictional-model', name: 'Fictional model', summary: 'For tests.', languages: 'Any', pros: [], cons: [], memory_gb: 1,
    files: [
      { name: 'encoder.onnx', url: `${base}/encoder.onnx`, size: encoder.length, sha256: overrides.encoder ?? sha(encoder) },
      { name: 'tokens.txt', url: `${base}/tokens.txt`, size: tokens.length, sha256: overrides.tokens ?? sha(tokens) },
    ],
  };
  const vad: CatalogModel = { id: 'silero-vad', name: 'VAD', summary: '', languages: 'Any', pros: [], cons: [], memory_gb: 0, files: [{ name: 'vad.onnx', url: `${base}/vad.onnx`, size: vadBytes.length, sha256: sha(vadBytes) }] };
  return { models: [model], vad };
}

const files = { 'encoder.onnx': encoder, 'tokens.txt': tokens, 'vad.onnx': vadBytes };

test('the catalog: the accurate model is the default, every file is pinned, and settings are checked', () => {
  const settings = parseTranscriptionSettings({});
  assert.deepEqual([settings.model, settings.language], ['whisper-large-v3-turbo', 'auto']);
  for (const m of CATALOG) {
    assert.ok(m.pros.length && m.cons.length, `${m.id} has pluses and minuses`);
    for (const f of m.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.match(f.url, /^https:\/\/huggingface\.co\/csukuangfj\/[^/]+\/resolve\/[0-9a-f]{40}\//, 'pinned to a commit');
    }
  }
  assert.throws(() => parseTranscriptionSettings({ language: 'xx' }), /Invalid language/);
  assert.throws(() => parseTranscriptionSettings({ model: 'unknown' }), /Invalid model/);
});

test('a download fetches the voice-activity model with the first model, verifies every file, and installs it last', async (t) => {
  const dir = await modelsFolder(t);
  const { base } = await fileServer(t, files);
  const { models, vad } = catalog(base);
  const service = new TranscriptionModelService(models, vad);
  let events = 0;
  const count = () => { events++; };
  transcriptionEvents.on('change', count);
  t.after(() => { transcriptionEvents.off('change', count); });

  assert.equal((await service.view()).models[0]!.installed, false);
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  const view = await service.view();
  assert.equal(view.models[0]!.installed, true, JSON.stringify(view.models[0]!.download));
  assert.equal(view.vad_installed, true);
  assert.deepEqual(await fsp.readFile(path.join(dir, 'fictional-model', 'encoder.onnx')), encoder);
  assert.ok(events > 0, 'the dashboard hears about it');
  await assert.rejects(fsp.access(path.join(dir, 'download.lock')), 'the lock is released');
  assert.equal(await service.installedPath('fictional-model'), path.join(dir, 'fictional-model'));

  // A changed file on disk no longer counts as installed.
  await fsp.writeFile(path.join(dir, 'fictional-model', 'tokens.txt'), 'x');
  assert.equal(await service.installed('fictional-model'), false);
  await service.remove('fictional-model');
  await assert.rejects(fsp.access(path.join(dir, 'fictional-model')));
});

test('a file that does not match its checksum is removed and the model is not installed', async (t) => {
  await modelsFolder(t);
  const { base } = await fileServer(t, files);
  const { models, vad } = catalog(base, { tokens: '0'.repeat(64) });
  const service = new TranscriptionModelService(models, vad);
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  const model = (await service.view()).models[0]!;
  assert.equal(model.installed, false);
  assert.equal(model.download?.status, 'failed');
  assert.match(model.download!.message!, /does not match its checksum/);
});

test('an interrupted download continues from where it stopped, and a server that ignores the range starts the file over', async (t) => {
  const dir = await modelsFolder(t);
  const cut = await fileServer(t, files, { cut: { file: 'encoder.onnx', bytes: 100_000 } });
  const service = new TranscriptionModelService(catalog(cut.base).models, catalog(cut.base).vad);
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.equal(await service.installed('fictional-model'), true);
  assert.ok(cut.requests.some((r) => r.path === 'encoder.onnx' && r.range === 'bytes=100000-'), JSON.stringify(cut.requests));

  // A part left behind, and a server that answers a range with the whole file: the file is written from the start.
  await service.remove('fictional-model');
  await fsp.mkdir(path.join(dir, 'fictional-model'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'fictional-model', 'encoder.onnx.part'), encoder.subarray(0, 50_000));
  const plain = await fileServer(t, files, { ignoreRange: true });
  const again = new TranscriptionModelService(catalog(plain.base).models, catalog(plain.base).vad);
  assert.equal((await again.view()).models[0]!.partial, 50_000, 'what is on disk shows');
  await again.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.equal(await again.installed('fictional-model'), true);
  assert.deepEqual(await fsp.readFile(path.join(dir, 'fictional-model', 'encoder.onnx')), encoder);
});

test('cancel keeps what was downloaded; one download at a time, also across dashboards', async (t) => {
  const dir = await modelsFolder(t);
  // A server that sends the encoder slowly, so the download can be cancelled halfway.
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '/').slice(1);
    const data = (files as Record<string, Buffer>)[name]!;
    res.writeHead(200, { 'Content-Length': data.length });
    let i = 0;
    const send = () => {
      if (i >= data.length || res.destroyed) { res.end(); return; }
      res.write(data.subarray(i, i + 20_000));
      i += 20_000;
      setTimeout(send, 30);
    };
    send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const service = new TranscriptionModelService(catalog(base).models, catalog(base).vad);

  await service.download('fictional-model');
  await assert.rejects(service.download('fictional-model'), /already downloading/);
  await assert.rejects(service.remove('fictional-model'), /Cancel the download first/);
  // Cancelled once part of it has arrived and is on disk, however slow the machine is.
  for (const end = Date.now() + 10_000; Date.now() < end && !((await service.view()).models[0]!.partial > 0);) await new Promise((r) => setTimeout(r, 20));
  await service.cancel('fictional-model');
  await TranscriptionModelService.settled();
  const view = (await service.view()).models[0]!;
  assert.equal(view.download?.status, 'cancelled');
  assert.ok(view.partial > 0, 'the part is kept');

  // Another dashboard holds the lock: refused. A lock left by a process that is gone is taken over.
  await fsp.writeFile(path.join(dir, 'download.lock'), JSON.stringify({ pid: process.ppid, token: 'other' }));
  await assert.rejects(service.download('fictional-model'), /Another dashboard is downloading/);
  await fsp.writeFile(path.join(dir, 'download.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'gone' }));
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.equal(await service.installed('fictional-model'), true);
});

test('settings are saved outside the workspace and only known values are accepted', async (t) => {
  const dir = await modelsFolder(t);
  const service = new TranscriptionModelService();
  const view = await service.updateSettings({ model: 'sensevoice-2024-07-17', language: 'ja' });
  assert.deepEqual([view.settings.model, view.settings.language], ['sensevoice-2024-07-17', 'ja']);
  assert.equal(view.models_dir, dir);
  assert.match(await fsp.readFile(path.join(dir, 'settings.json'), 'utf-8'), /sensevoice-2024-07-17/);
  await assert.rejects(service.updateSettings({ language: 'xx' }), /Invalid language/);
  assert.equal(view.models.find((m) => m.id === 'whisper-large-v3-turbo')!.size, 674716297 + 361080764 + 816730);
});

test('safety: write errors end cleanly, links are never followed, and two starts or a stale lock cannot run twice', async (t) => {
  const dir = await modelsFolder(t);
  const { base, requests } = await fileServer(t, files);
  const service = new TranscriptionModelService(catalog(base).models, catalog(base).vad);
  const outcome = async () => (await service.view()).models[0]!.download;

  // A folder where the part should be: the download fails with a reason, the server keeps running, the lock is released.
  await fsp.mkdir(path.join(dir, 'fictional-model', 'encoder.onnx.part'), { recursive: true });
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.equal((await outcome())?.status, 'failed');
  assert.match((await outcome())!.message!, /not a plain file/);
  await assert.rejects(fsp.access(path.join(dir, 'download.lock')));
  await fsp.rm(path.join(dir, 'fictional-model', 'encoder.onnx.part'), { recursive: true });

  // A part that is a link to a file elsewhere: refused, and the file elsewhere is untouched.
  const elsewhere = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-elsewhere-')), 'keep.txt');
  t.after(() => fsp.rm(path.dirname(elsewhere), { recursive: true, force: true }));
  await fsp.writeFile(elsewhere, 'sentinel');
  await fsp.symlink(elsewhere, path.join(dir, 'fictional-model', 'encoder.onnx.part'));
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.match((await outcome())!.message!, /not a plain file/);
  assert.equal(await fsp.readFile(elsewhere, 'utf-8'), 'sentinel');
  await fsp.unlink(path.join(dir, 'fictional-model', 'encoder.onnx.part'));

  // A model folder that is a link: nothing is written through it, and removing it removes only the link.
  await fsp.rm(path.join(dir, 'fictional-model'), { recursive: true, force: true });
  await fsp.symlink(path.dirname(elsewhere), path.join(dir, 'fictional-model'));
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.match((await outcome())!.message!, /not a plain folder/);
  await service.remove('fictional-model');
  assert.equal(await fsp.readFile(elsewhere, 'utf-8'), 'sentinel');

  // Two starts at once: one runs, the other is refused.
  const both = await Promise.allSettled([service.download('fictional-model'), service.download('fictional-model')]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  await TranscriptionModelService.settled();
  assert.equal(await service.installed('fictional-model'), true);
  assert.equal(requests.filter((r) => r.path === 'encoder.onnx').length, 1, 'fetched once');
});

test('locks: an unfinished lock is taken over once old, another dashboard blocks downloads and removal', async (t) => {
  const dir = await modelsFolder(t);
  const { base } = await fileServer(t, files);
  const service = new TranscriptionModelService(catalog(base).models, catalog(base).vad);
  const lock = path.join(dir, 'download.lock');

  await fsp.writeFile(lock, '');
  await assert.rejects(service.download('fictional-model'), /starting a download/, 'a fresh, unfinished lock: someone is writing it');
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lock, old, old);
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.equal(await service.installed('fictional-model'), true, 'an old, unfinished lock is taken over');

  await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, token: 'other' }));
  assert.equal((await service.view()).downloading_elsewhere, true);
  await assert.rejects(service.remove('fictional-model'), /Another dashboard is downloading/);
  assert.equal(await service.installed('fictional-model'), true, 'nothing removed');
  assert.equal(await fsp.readFile(lock, 'utf-8'), JSON.stringify({ pid: process.ppid, token: 'other' }), 'the other lock is left alone');
});

test('a missing voice-activity model is downloaded alone, with progress counting only what is fetched', async (t) => {
  const dir = await modelsFolder(t);
  const { base, requests } = await fileServer(t, files);
  const service = new TranscriptionModelService(catalog(base).models, catalog(base).vad);
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  await fsp.rm(path.join(dir, 'silero-vad'), { recursive: true });
  assert.equal((await service.view()).vad_installed, false);
  const before = requests.length;
  const started = await service.download('fictional-model');
  assert.equal(started.models[0]!.download?.total, vadBytes.length, 'only the missing file counts');
  await TranscriptionModelService.settled();
  assert.deepEqual(requests.slice(before).map((r) => r.path), ['vad.onnx']);
  assert.equal((await service.view()).vad_installed, true);
});

test('a range answer for a different part of the file is refused', async (t) => {
  const dir = await modelsFolder(t);
  const server = http.createServer((req, res) => {
    const data = (files as Record<string, Buffer>)[(req.url ?? '/').slice(1)]!;
    if (req.headers.range) { res.writeHead(206, { 'Content-Range': `bytes 100000-100009/${data.length}` }); res.end(data.subarray(100000, 100010)); return; }
    res.writeHead(200).end(data);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fsp.mkdir(path.join(dir, 'fictional-model'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'fictional-model', 'encoder.onnx.part'), encoder.subarray(0, 100000));
  const service = new TranscriptionModelService(catalog(base).models, catalog(base).vad);
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  const d = (await service.view()).models[0]!.download;
  assert.equal(d?.status, 'failed');
  assert.match(d!.message!, /different part of the file/);
});

test('a writer that stops while the queue is full ends the download; a malformed old lock is taken over; a removal holds its turn', async (t) => {
  const dir = await modelsFolder(t);
  // A server that never stops sending: the file grows past its size, the writer stops with the queue full.
  const endless = (async () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => { c.enqueue(new Uint8Array(65_536)); } }), { status: 200 })) as unknown as typeof fetch;
  const previous = downloadLimits.maxQueuedBytes;
  downloadLimits.maxQueuedBytes = 128 * 1024;
  t.after(() => { downloadLimits.maxQueuedBytes = previous; });
  const { models, vad } = catalog('http://fictional.invalid');
  const flooded = new TranscriptionModelService(models, vad, endless);
  await flooded.download('fictional-model');
  await TranscriptionModelService.settled();
  const d = (await flooded.view()).models[0]!.download;
  assert.equal(d?.status, 'failed');
  assert.match(d!.message!, /larger than expected/);
  await assert.rejects(fsp.access(path.join(dir, 'download.lock')), 'the lock is released');
  downloadLimits.maxQueuedBytes = previous;

  // An old lock with a damaged holder is taken over.
  const { base } = await fileServer(t, files);
  const service = new TranscriptionModelService(catalog(base).models, catalog(base).vad);
  const lock = path.join(dir, 'download.lock');
  await fsp.writeFile(lock, JSON.stringify({ pid: 'bad', token: 'bad' }));
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lock, old, old);
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.equal(await service.installed('fictional-model'), true);

  // While this dashboard removes a model, a download in the same dashboard waits its turn.
  const removal = service.remove('fictional-model');
  await assert.rejects(service.download('fictional-model'), /being removed/);
  await removal;
  assert.equal(await service.installed('fictional-model'), false);
});

test('a takeover guard is cleared only when its holder is gone, never by age while it lives', async (t) => {
  const dir = await modelsFolder(t);
  const { base } = await fileServer(t, files);
  const service = new TranscriptionModelService(catalog(base).models, catalog(base).vad);
  const lock = path.join(dir, 'download.lock');
  const guard = `${lock}.takeover`;
  const old = new Date(Date.now() - 60_000);
  await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'gone' }));
  // A live dashboard paused in the middle of a takeover: its old guard stays, so nothing is taken over meanwhile.
  await fsp.writeFile(guard, JSON.stringify({ pid: process.ppid, token: 'paused' }));
  await fsp.utimes(guard, old, old);
  await assert.rejects(service.download('fictional-model'), /could not be taken/);
  assert.equal(await fsp.readFile(guard, 'utf-8'), JSON.stringify({ pid: process.ppid, token: 'paused' }));
  assert.match(await fsp.readFile(lock, 'utf-8'), /"gone"/);

  // Its holder gone: the guard is cleared, the stale lock taken over, and the download runs.
  await fsp.writeFile(guard, JSON.stringify({ pid: 2 ** 22 + 54321, token: 'crashed' }));
  await service.download('fictional-model');
  await TranscriptionModelService.settled();
  assert.equal(await service.installed('fictional-model'), true);
  await assert.rejects(fsp.access(guard));
});

test('each model offers the languages it has, and a language it lacks goes back to Auto', () => {
  assert.equal(WHISPER_LANGUAGES.length, 100);
  assert.equal(new Set(WHISPER_LANGUAGES.map((l) => l.id)).size, 100);
  assert.deepEqual(WHISPER_LANGUAGES.filter((l) => l.common).map((l) => l.label), ['English', 'Japanese', 'Korean', 'Vietnamese']);
  assert.deepEqual(SENSEVOICE_LANGUAGES.map((l) => l.id), ['en', 'ja', 'ko', 'yue', 'zh']);
  assert.equal(languageFor('sensevoice-2024-07-17', 'vi'), 'auto');
  assert.equal(languageFor('sensevoice-2024-07-17', 'ko'), 'ko');
  assert.equal(languageFor('whisper-large-v3-turbo', 'vi'), 'vi');
  const whisper = parseTranscriptionSettings({ model: 'whisper-large-v3-turbo', language: 'vi' });
  assert.equal(whisper.language, 'vi');
  assert.equal(parseTranscriptionSettings({ model: 'sensevoice-2024-07-17' }, whisper).language, 'auto', 'a saved language the model lacks would stop its engine');
  assert.equal(parseTranscriptionSettings({ model: 'sensevoice-2024-07-17', language: 'vi' }).language, 'auto');
});

test('a second download waits its turn, can be taken out of the queue, and goes on after one that failed', async (t) => {
  await modelsFolder(t);
  const server = http.createServer((req, res) => {
    const body = (files as Record<string, Buffer>)[(req.url ?? '/').slice(1)];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': body.length });
    // Slow, so the first download is still running when the others are asked for.
    setTimeout(() => res.end(body), 150);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { models: [first], vad } = catalog(base);
  const named = (id: string): CatalogModel => ({ ...first!, id, name: id });
  const broken: CatalogModel = { ...named('broken'), files: first!.files.map((f) => ({ ...f, url: `${base}/broken/${f.name}` })) };
  const service = new TranscriptionModelService([broken, named('second'), named('third')], vad);
  const status = async (id: string) => (await service.view()).models.find((m) => m.id === id)!.download?.status;

  await service.download('broken');
  await service.download('second');
  await service.download('second');
  await service.download('third');
  assert.equal(await status('second'), 'queued');
  assert.equal(await status('third'), 'queued');
  await service.cancel('third');
  assert.equal(await status('third'), undefined, 'out of the queue, nothing else stops');

  await TranscriptionModelService.settled();
  const view = await service.view();
  assert.equal(await status('broken'), 'failed');
  assert.equal(view.models.find((m) => m.id === 'second')!.installed, true, 'the one that waited went on after the failure');
  assert.equal(view.models.find((m) => m.id === 'third')!.installed, false);
});

test('models that wait still start when the download before them ends early, each with the service that took it', async (t) => {
  await modelsFolder(t);
  const { base } = await fileServer(t, files);
  const { models: [model], vad } = catalog(base);
  // The first download finds it has nothing to do, after the second was asked for.
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  class Installed extends TranscriptionModelService {
    override async installed(): Promise<boolean> { await gate; return true; }
  }
  const first = new Installed([{ ...model!, id: 'first', name: 'first' }], vad);
  const other = new TranscriptionModelService([{ ...model!, id: 'second', name: 'second' }], vad);
  const started = first.download('first');
  await other.download('second');
  assert.equal((await other.view()).models[0]!.download?.status, 'queued');
  open();
  await started;
  await TranscriptionModelService.settled();
  assert.equal((await other.view()).models[0]!.installed, true);
});

test('language changes: one at a moment, none that change nothing, and what a model lacks is Auto', () => {
  assert.equal(languageAt('auto', [{ at: 10, language: 'ja' }, { at: 20, language: 'en' }], 9.9), 'auto');
  assert.equal(languageAt('auto', [{ at: 10, language: 'ja' }, { at: 20, language: 'en' }], 10), 'ja');
  assert.deepEqual(withLanguageChange('auto', [{ at: 5, language: 'ja' }], { at: 5, language: 'en' }), [{ at: 5, language: 'en' }]);
  assert.deepEqual(withLanguageChange('auto', [{ at: 5, language: 'ja' }], { at: 7, language: 'ja' }), [{ at: 5, language: 'ja' }]);
  assert.deepEqual(withLanguageChange('ja', [{ at: 5, language: 'en' }], { at: 5, language: 'ja' }), []);
  assert.deepEqual(languagesFor('sensevoice-2024-07-17', 'vi', [{ at: 5, language: 'ja' }, { at: 9, language: 'vi' }, { at: 12, language: 'pl' }]), { language: 'auto', changes: [{ at: 5, language: 'ja' }, { at: 9, language: 'auto' }] });
  for (const bad of ['x', [{ at: -1, language: 'ja' }], [{ at: 1, language: 'xx' }], [{ at: 2, language: 'ja' }, { at: 2, language: 'en' }], Array.from({ length: 201 }, (_, i) => ({ at: i, language: 'ja' }))]) {
    assert.equal(parseLanguageChanges(bad), null);
  }
  assert.deepEqual(parseLanguageChanges([{ at: 0, language: 'auto' }]), [{ at: 0, language: 'auto' }]);
});
