import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import express from 'express';
import { readdirSync } from 'node:fs';
import { MeetingDigestService, type QueuedMeeting } from '../src/services/meetingDigestService';
import { MeetingRecordingService, wavHeader } from '../src/services/meetingRecording';
import { readWavFormat } from '../src/services/transcription/wav';
import meetingQueueRoutes from '../src/routes/meetingQueue';
import { errorHandler } from '../src/middleware/errorHandler';

const TOKEN = 'fictional-writer-token-one';
const OTHER = 'fictional-writer-token-two';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-record-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

const queue = new MeetingDigestService();
const service = new MeetingRecordingService(queue);
const samples = (n: number, value = 1) => Buffer.alloc(n * 2, value);
const draft = async (title = 'Workshop') => (await queue.createMeeting({ title, meeting_date: '2026-10-30' })).id;
const folder = (ws: string, id: string) => path.join(ws, 'context-updates', 'meeting-queue', id);
/** The meeting's hidden recording file, or a name that does not exist. */
const live = (ws: string, id: string) => path.join(folder(ws, id), readdirSync(folder(ws, id)).find((n) => n.startsWith('.live-recording-')) ?? '.none');
const wavHeaderFor = (bytes: number) => wavHeader(bytes);
const conflict = (err: { statusCode?: number; details?: { offset?: number } }, offset: number) => err.statusCode === 409 && err.details?.offset === offset;

test('a recording arrives in blocks, becomes a WAV the transcription reads, and waits to be queued', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  const { generation, offset } = await service.start(id, TOKEN);
  assert.equal(offset, 0);
  assert.equal(((await fsp.stat(live(ws, id))).mode & 0o777), 0o600);
  await assert.rejects(queue.queue(id), /recording in progress/);
  assert.deepEqual(await service.append(id, TOKEN, 0, samples(8000)), { offset: 16000 });
  assert.deepEqual(await service.append(id, TOKEN, 16000, samples(8000, 2)), { offset: 32000 });

  const finished = await service.finish(id, { token: TOKEN, offset: 32000 });
  assert.equal(finished.live, undefined);
  const file = finished.files[0]!;
  assert.match(file.name, /^recording-\d{8}-\d{4}\.wav$/);
  assert.equal(file.recording?.status, 'pending');
  assert.equal(file.capture, generation);
  const format = await readWavFormat(path.join(folder(ws, id), file.name));
  assert.deepEqual([format.sampleRate, format.channels, format.bitsPerSample, format.duration], [16000, 1, 16, 1]);
  await assert.rejects(fsp.access(live(ws, id)));
  assert.equal((await queue.queue(id)).status, 'queued');

  // The reply was lost: the same call says the same thing, and adds nothing.
  const again = await service.finish(id, { token: TOKEN, offset: 32000, generation });
  assert.equal(again.files.length, 1);
});

test('a block sent twice is stored once, a different one is refused, and a gap says where to go on', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(100));
  assert.deepEqual(await service.append(id, TOKEN, 0, samples(100)), { offset: 200 }, 'a retry changes nothing');
  assert.deepEqual(await service.append(id, TOKEN, 100, Buffer.concat([samples(50), samples(50, 3)])), { offset: 300 }, 'the overlap is skipped, the rest stored');
  assert.equal((await fsp.stat(live(ws, id))).size, 344);
  await assert.rejects(service.append(id, TOKEN, 0, samples(10, 9)), (e: never) => conflict(e, 300), 'different audio is never mixed in');
  await assert.rejects(service.append(id, TOKEN, 400, samples(10)), (e: never) => conflict(e, 300));
  await assert.rejects(service.append(id, TOKEN, 1, samples(10)), /Invalid offset/);
  await assert.rejects(service.append(id, TOKEN, 300, Buffer.alloc(3)), /whole 16-bit samples/);
  await assert.rejects(service.append(id, TOKEN, 300, Buffer.alloc(0)), /whole 16-bit samples/);
  await assert.rejects(service.append(id, OTHER, 300, samples(10)), /no longer holds/);
  assert.equal((await fsp.stat(live(ws, id))).size, 344, 'nothing refused was written');
});

test('one writer: a second page is refused, and a late block after finishing is too', async (t) => {
  await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await assert.rejects(service.start(id, OTHER), /already has a recording/);
  assert.deepEqual((await service.start(id, TOKEN)).offset, 0, 'the same page may ask again');
  await service.append(id, TOKEN, 0, samples(10));
  await assert.rejects(service.finish(id, { token: TOKEN, offset: 0 }), (e: never) => conflict(e, 20));
  await assert.rejects(service.finish(id, { token: OTHER, offset: 20 }), /no longer holds/);

  // A second meeting cannot record while the first is open, however quiet it has been...
  const other = await draft('Other');
  await assert.rejects(service.start(other, OTHER), /Another recording is open \("Workshop"\)/);
  await service.finish(id, { token: TOKEN, offset: 20 });
  await assert.rejects(service.append(id, TOKEN, 20, samples(10)), /no longer holds/);
  // ...and can once it is not.
  assert.equal((await service.start(other, OTHER)).offset, 0);
});

test('an interrupted recording is never cleaned up; Finish saves it, also with half a sample, and shuts out the old page', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(4000));
  await fsp.appendFile(live(ws, id), Buffer.from([7])); // a write cut off half way through a sample

  // Far later, the digest's clean-up comes by, and so does the transcription's.
  const later = new Date(Date.now() + 60 * 86_400_000);
  await queue.runNow(later);
  await queue.withQueue(async () => { await queue.dropUnrecorded(await queue.loadMeeting(id), folder(ws, id)); });
  await fsp.access(live(ws, id));
  assert.ok((await queue.readQueue()).meetings.some((m) => m.id === id && m.live?.state === 'recording'));

  // The same page comes back and goes on, from the last whole sample.
  assert.equal((await service.start(id, TOKEN)).offset, 8000);
  await service.append(id, TOKEN, 8000, samples(4000));

  const { generation } = await service.start(id, TOKEN);
  await assert.rejects(service.finish(id, { recover: true }), /needs its generation/);
  await assert.rejects(service.finish(id, { recover: true, generation: 'an-older-recording' }), /different recording/);
  const finished = await service.finish(id, { recover: true, generation });
  assert.equal(finished.files[0]!.size, 44 + 16000);
  assert.equal((await readWavFormat(path.join(folder(ws, id), finished.files[0]!.name))).duration, 0.5);
  await assert.rejects(service.append(id, TOKEN, 16000, samples(10)), /no longer holds/);
});

test('finishing survives a stop at every step, and never deletes the audio', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(1000));
  const seal = async (m: QueuedMeeting) => { m.live = { ...m.live!, state: 'finalizing', sealed_bytes: 2000 }; await queue.saveMeeting(m); };

  // Stopped right after sealing: no page may add to it, and Finish goes on.
  await queue.withQueue(async () => seal(await queue.loadMeeting(id)));
  await assert.rejects(service.append(id, TOKEN, 2000, samples(10)), /no longer holds/);
  const { name, generation } = (await queue.loadMeeting(id)).live!;

  // Stopped right after the rename: the file has its final name, and no record of it yet.
  const sealedFile = await fsp.open(live(ws, id), 'r+');
  await sealedFile.write(wavHeader(2000), 0, 44, 0);
  await sealedFile.close();
  await fsp.rename(live(ws, id), path.join(folder(ws, id), name));
  await queue.withQueue(async () => { await queue.dropUnrecorded(await queue.loadMeeting(id), folder(ws, id)); });
  await fsp.access(path.join(folder(ws, id), name));
  const done = await service.finish(id, { recover: true, generation });
  assert.deepEqual(done.files.map((f) => f.name), [name]);
  assert.equal(done.live, undefined);
  assert.equal((await readWavFormat(path.join(folder(ws, id), name))).duration, 0.0625);

  // The manifest cannot be written after the rename: the file goes back and Finish can be tried again.
  const second = await draft('Second');
  await service.start(second, TOKEN);
  await service.append(second, TOKEN, 0, samples(1000));
  const internals = queue as unknown as { writeMeeting: (m: QueuedMeeting) => Promise<void> };
  const write = internals.writeMeeting;
  let failed = false;
  internals.writeMeeting = async function (this: unknown, m: QueuedMeeting) {
    if (!m.live && !failed) { failed = true; throw new Error('disk trouble'); }
    return write.call(this, m);
  };
  t.after(() => { internals.writeMeeting = write; });
  const secondGeneration = (await queue.loadMeeting(second)).live!.generation;
  await assert.rejects(service.finish(second, { recover: true, generation: secondGeneration }), /disk trouble/);
  await fsp.access(live(ws, second));
  assert.equal((await queue.loadMeeting(second)).live?.state, 'finalizing');
  assert.equal((await service.finish(second, { recover: true, generation: secondGeneration })).files.length, 1);
});

test('a name taken at the last moment is recorded before the rename, and a repeat of an old Finish touches nothing new', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  const first = await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(100));
  const name = (await queue.loadMeeting(id)).live!.name;
  await fsp.writeFile(path.join(folder(ws, id), name), 'a file that took the reserved name');

  // Stopped right after the rename: the manifest knows the name the audio really has.
  const internals = queue as unknown as { writeMeeting: (m: QueuedMeeting) => Promise<void> };
  const write = internals.writeMeeting;
  internals.writeMeeting = async function (this: unknown, m: QueuedMeeting) {
    if (!m.live) throw new Error('stopped here');
    return write.call(this, m);
  };
  const promises = createRequire(__filename)('fs/promises') as typeof fsp;
  const rename = promises.rename;
  const back = mock.method(promises, 'rename', async (from: string, to: string) => {
    if (path.basename(to).startsWith('.live-recording-')) throw new Error('no way back');
    return rename(from, to);
  });
  try {
    await assert.rejects(service.finish(id, { recover: true, generation: first.generation }), /stopped here/);
  } finally {
    back.mock.restore();
    internals.writeMeeting = write;
  }
  const moved = (await queue.loadMeeting(id)).live!.name;
  assert.notEqual(moved, name);
  await queue.withQueue(async () => { await queue.dropUnrecorded(await queue.loadMeeting(id), folder(ws, id)); });
  const done = await service.finish(id, { recover: true, generation: first.generation });
  assert.deepEqual(done.files.map((f) => [f.name, f.size]), [[moved, 244]]);

  // A later recording in the same meeting is not sealed by a retry of the first Finish.
  const next = await service.start(id, OTHER);
  await service.append(id, OTHER, 0, samples(10));
  assert.equal((await service.finish(id, { recover: true, generation: first.generation })).live?.generation, next.generation);
  assert.equal((await queue.loadMeeting(id)).live?.state, 'recording');
  assert.deepEqual(await service.append(id, OTHER, 20, samples(10)), { offset: 40 });
});

test('a sealed recording is only published as it was saved: a link or a shorter file stays out', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  const { generation } = await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(100));
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(id);
    m.live = { ...m.live!, state: 'finalizing', sealed_bytes: 200 };
    await queue.saveMeeting(m);
  });
  const { name } = (await queue.loadMeeting(id)).live!;
  const audio = await fsp.readFile(live(ws, id));
  await fsp.rm(live(ws, id));

  const elsewhere = path.join(ws, 'elsewhere.wav');
  await fsp.writeFile(elsewhere, audio);
  await fsp.symlink(elsewhere, path.join(folder(ws, id), name));
  await assert.rejects(service.finish(id, { recover: true, generation }));
  await fsp.rm(path.join(folder(ws, id), name));

  await fsp.writeFile(path.join(folder(ws, id), name), audio.subarray(0, 100));
  await assert.rejects(service.finish(id, { recover: true, generation }), /not the one that was saved/);
  assert.equal((await queue.loadMeeting(id)).files.length, 0);
  await fsp.access(path.join(folder(ws, id), name));

  await fsp.writeFile(path.join(folder(ws, id), name), Buffer.concat([wavHeaderFor(200), samples(100)]));
  assert.equal((await service.finish(id, { recover: true, generation })).files.length, 1);
});

test('work on a finished session never touches the next one, and a recording in neither place keeps its session', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  const internals = service as unknown as { checkSealed: (id: string, l: unknown) => Promise<unknown> };
  const a = await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(10));
  const sealedA = { ...(await queue.loadMeeting(id)).live!, state: 'finalizing', sealed_bytes: 20 };
  await service.finish(id, { token: TOKEN, offset: 20 });
  assert.notEqual((await service.start(id, OTHER)).generation, a.generation);
  await service.append(id, OTHER, 0, samples(5000));
  const before = await fsp.readFile(live(ws, id));

  // A second Finish of the first recording wakes up late: its work reaches only the first recording's file.
  await internals.checkSealed(id, sealedA);
  assert.deepEqual(await fsp.readFile(live(ws, id)), before);

  // A recording found nowhere is not recorded: its session stays for another try.
  const generation = (await queue.loadMeeting(id)).live!.generation;
  const hidden = live(ws, id);
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(id);
    m.live = { ...m.live!, state: 'finalizing', sealed_bytes: 10000 };
    await queue.saveMeeting(m);
  });
  await queue.withQueue(async () => {
    await fsp.rename(hidden, `${hidden}.away`);
    await assert.rejects(queue.publishRecording(await queue.loadMeeting(id), { size: 10044, sha256: 'x' }), /not found where it should be/);
    await fsp.rename(`${hidden}.away`, hidden);
  });
  assert.equal((await queue.loadMeeting(id)).live?.generation, generation);
  assert.equal((await service.finish(id, { recover: true, generation })).files.length, 2);
});

test('two Finish calls without a generation both succeed, and a sealed recording counts toward the limit after its rename', async (t) => {
  await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(10));
  const both = await Promise.all([service.finish(id, { token: TOKEN, offset: 20 }), service.finish(id, { token: TOKEN, offset: 20 })]);
  assert.ok(both.every((m) => m.files.length === 1 && m.live === undefined));

  const big = await draft('Big');
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(big);
    m.live = { generation: '00000000-0000-4000-8000-000000000000', token_sha256: 'x', state: 'finalizing', started_at: '', name: 'recording.wav', sealed_bytes: 3_500_000_000 };
    await queue.saveMeeting(m);
  });
  await assert.rejects(queue.commitUpload(big, 'more.wav', { path: '/fictional', size: 1_000_000_000, sha256: 'y' }), /at most 4 GB/);
});

test('a recording in progress holds its place: uploads cannot crowd it out, and two Finish calls at once both succeed', async (t) => {
  await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(10));
  for (let i = 0; i < 9; i++) await queue.addFile(id, `note-${i}.md`, Buffer.from(`Fictional note ${i}`));
  await assert.rejects(queue.addFile(id, 'one-too-many.md', Buffer.from('x')), /at most 10 files/);
  const { generation } = (await queue.loadMeeting(id)).live!;
  const both = await Promise.all([service.finish(id, { token: TOKEN, offset: 20, generation }), service.finish(id, { token: TOKEN, offset: 20, generation })]);
  assert.ok(both.every((m) => m.files.length === 10 && m.live === undefined));
});

test('a disk that fills stops the recording and keeps what was saved; a damaged record keeps the file', async (t) => {
  const ws = await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(100));
  const statfs = mock.method(createRequire(__filename)('fs/promises'), 'statfs', async () => ({ bavail: 1_000_000, bsize: 1 }));
  t.after(() => statfs.mock.restore());
  await assert.rejects(service.append(id, TOKEN, 200, samples(100)), /nearly full.*saved is kept/);
  statfs.mock.restore();
  assert.equal((await fsp.stat(live(ws, id))).size, 244);

  // Nothing recorded: there is nothing to finish.
  const empty = await draft('Empty');
  await service.finish(id, { recover: true, generation: (await queue.loadMeeting(id)).live!.generation });
  await service.start(empty, OTHER);
  await assert.rejects(service.finish(empty, { token: OTHER, offset: 0 }), /Nothing was recorded/);

  // A hand-edited manifest: the audio stays, nothing finishes it, and removing the meeting is the way out.
  const manifest = path.join(folder(ws, empty), 'meeting.md');
  await fsp.writeFile(manifest, (await fsp.readFile(manifest, 'utf-8')).replace(/state: recording/, 'state: nonsense'));
  assert.equal((await queue.loadMeeting(empty)).live?.state, 'damaged');
  await queue.runNow(new Date(Date.now() + 60 * 86_400_000));
  await fsp.access(live(ws, empty));
  await assert.rejects(service.finish(empty, { recover: true, generation: 'x' }), /cannot be read/);
  await queue.removeMeeting(empty);
  await assert.rejects(fsp.access(folder(ws, empty)));
});

test('a recording in progress is known to the server, and an interrupted one stops counting', async (t) => {
  const ws = await workspace(t);
  const id = await draft('Being recorded');
  assert.equal(await service.running(), null);
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(10));
  assert.equal(await service.running(), 'Being recorded');
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(live(ws, id), old, old);
  assert.equal(await service.running(), null, 'its page is gone: it must not block switching workspaces forever');
});

test('a recording stays in its workspace when another one is selected, however long the outage', async (t) => {
  const first = await workspace(t);
  const id = await draft();
  await service.start(id, TOKEN);
  await service.append(id, TOKEN, 0, samples(10));

  const second = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-record-other-'));
  t.after(() => fsp.rm(second, { recursive: true, force: true }));
  await fsp.mkdir(path.join(second, '.situation-board', 'routines'), { recursive: true });
  await fsp.mkdir(path.join(second, 'context-updates'), { recursive: true });
  process.env.ESB_WORKSPACE_PATH = second;

  assert.deepEqual(await service.append(id, TOKEN, 20, samples(10)), { offset: 40 });
  const done = await service.finish(id, { token: TOKEN, offset: 40, queue: true });
  assert.deepEqual([done.status, done.files.length], ['queued', 1]);
  await fsp.access(path.join(first, 'context-updates', 'meeting-queue', id, done.files[0]!.name));
  await assert.rejects(fsp.access(path.join(second, 'context-updates', 'meeting-queue', id)));
});

test('over HTTP: audio only as raw bytes, the token in a header, and Finish then queue', async (t) => {
  const ws = await workspace(t);
  const app = express();
  app.use(express.json());
  app.use('/api/meeting-queue', meetingQueueRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/meeting-queue`;
  const id = await draft();
  const post = (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const put = (offset: string, body: Buffer, headers: Record<string, string>) => fetch(`${base}/${id}/recording?offset=${offset}`, { method: 'PUT', headers, body });
  const audio = { 'Content-Type': 'application/octet-stream', 'X-Recording-Token': TOKEN };

  assert.equal((await post(`/${id}/recording`, { token: 'short' })).status, 400);
  assert.equal((await post(`/${id}/recording`, { token: TOKEN })).status, 201);
  assert.equal((await put('0', samples(10), { 'Content-Type': 'text/plain', 'X-Recording-Token': TOKEN })).status, 400, 'not raw audio');
  assert.equal((await put('nonsense', samples(10), audio)).status, 400);
  assert.equal((await put('0', samples(10), { 'Content-Type': 'application/octet-stream' })).status, 409, 'no token');
  assert.equal((await put('0', Buffer.alloc(2 * 1024 * 1024), audio)).status, 413, 'a block has a limit');
  assert.equal((await fsp.stat(live(ws, id))).size, 44, 'nothing refused reached the file');
  const stored = await put('0', samples(10), audio);
  assert.deepEqual(await stored.json(), { offset: 20 });
  const gap = await put('100', samples(10), audio);
  assert.equal(gap.status, 409);
  assert.equal(((await gap.json()) as { details: { offset: number } }).details.offset, 20);
  assert.equal((await post(`/${id}/recording/finish`, { token: TOKEN, offset: 20 })).status, 200);
  assert.equal((await post(`/${id}/queue`, {})).status, 200);
});
