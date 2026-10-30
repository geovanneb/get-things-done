import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { CATALOG, TranscriptionModelService, parseTranscriptionSettings, transcriptionEvents, type CatalogModel } from '../src/services/transcriptionModels';

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
  assert.throws(() => parseTranscriptionSettings({ language: 'fr' }), /auto, en or ja/);
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
  await new Promise((r) => setTimeout(r, 250));
  await service.cancel('fictional-model');
  await TranscriptionModelService.settled();
  const view = (await service.view()).models[0]!;
  assert.equal(view.download?.status, 'cancelled');
  assert.ok(view.partial > 0, 'the part is kept');

  // Another dashboard holds the lock: refused. A lock left by a process that is gone is taken over.
  await fsp.writeFile(path.join(dir, 'download.lock'), JSON.stringify({ pid: process.ppid }));
  await assert.rejects(service.download('fictional-model'), /Another dashboard is downloading/);
  await fsp.writeFile(path.join(dir, 'download.lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
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
  await assert.rejects(service.updateSettings({ language: 'de' }), /Invalid language/);
  assert.equal(view.models.find((m) => m.id === 'whisper-large-v3-turbo')!.size, 674716297 + 361080764 + 816730);
});
