import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { RoutineService } from '../src/services/routineService';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { DIGEST_KIND, DIGEST_ORIGIN, MeetingDigestService, parseSettings } from '../src/services/meetingDigestService';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-digest-'));
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

const vtt = (speaker: string, words: string) => Buffer.from(`WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v ${speaker}>${words}</v>\n`);

/** Queues a fictional meeting with the given files and returns its id. */
async function queueMeeting(service: MeetingDigestService, title: string, date: string, files: [string, Buffer][]): Promise<string> {
  const m = await service.createMeeting({ title, meeting_date: date });
  for (const [name, data] of files) await service.addFile(m.id, name, data);
  await service.queue(m.id);
  return m.id;
}

const updates = new ContextUpdateService();
const batchFile = (ws: string) => path.join(ws, '.situation-board', 'routines', 'meeting-digest-batch.json');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** A batch file as an interrupted run leaves it: each meeting with the saved names and hashes the digest must hold. */
const batch = (expected: [string, [string, string][]][], updateId: string | null, published = false) => JSON.stringify({
  meetings: expected.map(([id]) => id),
  expected: expected.map(([id, files]) => ({ id, files: files.map(([file, content]) => ({ file, sha256: hash(content) })) })),
  update_id: updateId, published, started_at: '2026-10-28T18:00:00Z',
});

test('queued meetings become one digest with their files, readable copies and a durable record', async (t) => {
  const ws = await workspace(t);
  const service = new MeetingDigestService();
  const a = await queueMeeting(service, 'Weekly sync', '2026-10-28', [['transcript.vtt', vtt('Jane Doe', 'Budget next week.')], ['notes.md', Buffer.from('Notes A')]]);
  const b = await queueMeeting(service, 'Pilot review "draft" ```x```', '2026-10-27', [['transcript.vtt', vtt('Taro Yamada', 'Pilot on track.')]]);
  const draft = await service.createMeeting({ title: 'Not finished', meeting_date: '2026-10-26' });

  const result = await service.runNow(new Date('2026-10-28T18:00:00'));
  assert.equal(result.status, 'ok', result.message);
  const update = await updates.get(result.context_update!);
  assert.deepEqual([update.origin, update.kind, update.status], [DIGEST_ORIGIN, DIGEST_KIND, 'ready']);
  assert.equal(update.title, 'Meeting digest 2026-10-27 – 2026-10-28 (catch-up, 2 meetings)');
  assert.equal(update.source_date, '2026-10-27', 'the earliest meeting');
  assert.deepEqual(update.digest_meetings.map((m) => [m.id, m.meeting_date]), [[b, '2026-10-27'], [a, '2026-10-28']], 'oldest first');
  // Two meetings with a file of the same name keep both, each under its own meeting.
  const names = update.material_files.map((f) => f.name).sort();
  assert.deepEqual(names, [`${a}-notes.md`, `${a}-transcript.transcript.md`, `${a}-transcript.vtt`, `${b}-transcript.transcript.md`, `${b}-transcript.vtt`, 'meetings.md'].sort());
  assert.equal(update.transcripts.length, 2);
  assert.ok(!update.notes.includes('Pilot review') && !update.notes.includes('Weekly sync'), 'titles never reach the brief');
  const list = await fsp.readFile(path.join(ws, 'context-updates', update.id, 'materials', 'meetings.md'), 'utf-8');
  assert.ok(list.includes(`title: ${JSON.stringify('Pilot review "draft" ```x```')}`) && list.includes('date: 2026-10-27'));
  assert.match(list, /````yaml/, 'the fence is longer than any backtick run');

  // The queue keeps the draft only; receipts say where each meeting went.
  const queue = await service.readQueue();
  assert.deepEqual(queue.meetings.map((m) => m.id), [draft.id]);
  const receipts = (await fsp.readFile(path.join(ws, '.situation-board', 'routines', 'meeting-digest-receipts.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(receipts.map((r) => [r.meeting, r.update_id]).sort(), [[a, update.id], [b, update.id]].sort());
  await assert.rejects(fsp.access(batchFile(ws)));
  // A removed queue id is never handed out again.
  const next = await service.createMeeting({ title: 'Later', meeting_date: '2026-10-29' });
  assert.ok(next.id > b && next.id > a && next.id !== draft.id);
});

test('one digest at a time: later meetings wait in the queue, and a digest holds at most max_meetings', async (t) => {
  await workspace(t);
  const service = new MeetingDigestService();
  await service.update({ max_meetings: 2 });
  for (let i = 1; i <= 3; i++) await queueMeeting(service, `Meeting ${i}`, `2026-10-2${i}`, [[`m${i}.md`, Buffer.from(`Meeting ${i}`)]]);
  const first = await service.runNow(new Date('2026-10-23T18:00:00'));
  assert.match(first.message, /from 2 meetings.*1 more wait/);
  assert.equal((await service.readQueue()).meetings.length, 1);

  const held = await service.runNow(new Date('2026-10-24T18:00:00'));
  assert.match(held.message, new RegExp(`Digest ${first.context_update} is not done yet.*1 meeting wait`));
  assert.equal(held.context_update, undefined);

  // Once the open digest is done, the next run takes what waited.
  const file = path.join(process.env.ESB_WORKSPACE_PATH!, 'context-updates', first.context_update!, 'update.md');
  await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('status: ready', 'status: done'));
  const second = await service.runNow(new Date('2026-10-26T18:00:00'));
  assert.match(second.message, /from 1 meeting/);
  assert.equal((await updates.get(second.context_update!)).title, 'Meeting digest 2026-10-23');

  const empty = await service.runNow(new Date('2026-10-27T18:00:00'));
  assert.equal(empty.did_something, false);
  assert.throws(() => parseSettings({ max_meetings: 21 }), /1 to 20/);
});

test('an interrupted digest is discarded before publishing and finished after it, never lost or doubled', async (t) => {
  const ws = await workspace(t);
  const service = new MeetingDigestService();
  const a = await queueMeeting(service, 'Sync', '2026-10-28', [['a.md', Buffer.from('A')]]);

  // Crash after the id was reserved and some files written, before update.md: discarded, the meeting stays queued.
  await fsp.mkdir(path.join(ws, 'context-updates', 'CU-2026-0007', 'materials'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0007', 'materials', 'half.md'), 'x');
  await fsp.writeFile(batchFile(ws), batch([[a, [[`${a}-a.md`, 'A']]]], 'CU-2026-0007'));
  await assert.rejects(service.removeMeeting(a), /being made/, 'a meeting in a digest being made cannot be removed');
  const view = await service.view();
  assert.equal(view.queue[0]!.in_digest, true);
  const recovered = await service.runNow(new Date('2026-10-28T18:05:00'));
  assert.match(recovered.message, /Discarded a digest that was interrupted.*Made digest/);
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', 'CU-2026-0007')));
  const made = await updates.get(recovered.context_update!);
  assert.deepEqual(made.digest_meetings.map((m) => m.id), [a]);

  // Crash after publishing, before the queue was emptied: finished, with no second digest.
  const b = await queueMeeting(service, 'Review', '2026-10-29', [['b.md', Buffer.from('B')]]);
  await fsp.writeFile(path.join(ws, 'context-updates', made.id, 'update.md'),
    (await fsp.readFile(path.join(ws, 'context-updates', made.id, 'update.md'), 'utf-8')).replace(`id: ${a}`, `id: ${b}`));
  await fsp.writeFile(batchFile(ws), batch([[b, [[`${a}-a.md`, 'A']]]], made.id, true));
  const before = (await updates.list()).length;
  const routine = new RoutineService();
  await routine.runDue('manual', new Date('2026-10-29T18:01:00'));
  assert.equal((await updates.list()).length, before, 'no second digest');
  assert.deepEqual((await service.readQueue()).meetings, []);
  await assert.rejects(fsp.access(batchFile(ws)));
});

test('a changed or missing file keeps its meeting in the queue; drafts and damaged batches are handled', async (t) => {
  const ws = await workspace(t);
  const service = new MeetingDigestService();
  const bad = await queueMeeting(service, 'Changed', '2026-10-20', [['x.md', Buffer.from('original')]]);
  const good = await queueMeeting(service, 'Fine', '2026-10-21', [['y.md', Buffer.from('fine')]]);
  await fsp.writeFile(path.join(ws, 'context-updates', 'meeting-queue', bad, 'x.md'), 'edited');
  const result = await service.runNow(new Date('2026-10-21T18:00:00'));
  assert.equal(result.status, 'error');
  assert.match(result.message, new RegExp(`Made digest .* ${bad} was left in the queue`));
  assert.deepEqual((await updates.get(result.context_update!)).digest_meetings.map((m) => m.id), [good]);

  // A draft cannot be queued without files, takes no files once queued, and is removed after a day untouched.
  const empty = await service.createMeeting({ title: 'Empty', meeting_date: '2026-10-22' });
  await assert.rejects(service.queue(empty.id), /at least one file/);
  await assert.rejects(service.addFile(bad, 'z.md', Buffer.from('z')), /before the meeting is queued/);
  await assert.rejects(service.createMeeting({ meeting_date: '2026-13-01' }), /meeting_date/);
  const done = path.join(ws, 'context-updates', result.context_update!, 'update.md');
  await fsp.writeFile(done, (await fsp.readFile(done, 'utf-8')).replace('status: ready', 'status: done'));
  await service.runNow(new Date(Date.now() + 2 * 86_400_000));
  assert.deepEqual((await service.readQueue()).meetings.map((m) => m.id), [bad], 'the abandoned draft is gone, the changed meeting stays');

  // A damaged batch stops the job: no digest from the healthy meeting waiting, the batch is kept, and the error stays in the state.
  await fsp.writeFile(done, (await fsp.readFile(done, 'utf-8')).replace('status: ready', 'status: done'));
  const waiting = await queueMeeting(service, 'Waiting', '2026-10-23', [['w.md', Buffer.from('waiting')]]);
  await fsp.writeFile(batchFile(ws), 'BROKEN');
  const before = (await updates.list()).length;
  const damaged = await service.runNow(new Date());
  assert.equal(damaged.status, 'error');
  assert.match(damaged.message, /batch file is damaged/);
  assert.equal(damaged.context_update, undefined);
  assert.equal((await updates.list()).length, before, 'nothing new was made');
  assert.ok((await service.readQueue()).meetings.some((m) => m.id === waiting));
  assert.equal(await fsp.readFile(batchFile(ws), 'utf-8'), 'BROKEN', 'the batch file is kept');
  assert.deepEqual([(await service.readState()).last_status, (await service.readState()).last_message], ['error', damaged.message]);
  // A scheduled check that hits the same error again stays out of the history.
  assert.equal((await service.runIfDue(new Date()))?.did_something, false);
});

test('a meeting leaves the queue only when the published digest holds all its files, and the digest cannot change meanwhile', async (t) => {
  const ws = await workspace(t);
  const service = new MeetingDigestService();
  const a = await queueMeeting(service, 'Sync', '2026-10-28', [['notes.md', Buffer.from('notes')]]);
  const made = (await service.runNow(new Date('2026-10-28T18:00:00'))).context_update!;

  // A batch naming a meeting the digest does not hold (no record, or a file removed): the meeting stays queued.
  const c = await queueMeeting(service, 'Other', '2026-10-29', [['c.md', Buffer.from('C')]]);
  await fsp.writeFile(batchFile(ws), batch([[c, [[`${c}-c.md`, 'C']]]], made, true));
  await assert.rejects(updates.removeMaterial(made, `${a}-notes.md`), /still moving its meetings/, 'the digest is protected during the handoff');
  await assert.rejects(updates.remove(made), /still moving its meetings/);
  const result = await service.runNow(new Date('2026-10-29T18:00:00'));
  assert.equal(result.status, 'error');
  assert.match(result.message, new RegExp(`${c} stayed in the queue`));
  assert.deepEqual((await service.readQueue()).meetings.map((m) => m.id), [c], 'never deleted without a verified copy');
  await assert.rejects(fsp.access(batchFile(ws)));
  const receipts = await fsp.readFile(path.join(ws, '.situation-board', 'routines', 'meeting-digest-receipts.jsonl'), 'utf-8');
  assert.ok(!receipts.includes(c), 'no receipt for a meeting that stayed');

  // A digest that records the meeting but lost the file does not hold it either.
  const e = await queueMeeting(service, 'Third', '2026-10-30', [['e.md', Buffer.from('notes')]]);
  const file = path.join(ws, 'context-updates', made, 'update.md');
  await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace(`id: ${a}`, `id: ${e}`));
  await fsp.writeFile(batchFile(ws), batch([[e, [[`${a}-notes.md`, 'notes']]]], made, true));
  await fsp.rm(path.join(ws, 'context-updates', made, 'materials', `${a}-notes.md`));
  const again = await service.runNow(new Date('2026-10-29T18:01:00'));
  assert.match(again.message, new RegExp(`${e} stayed in the queue`));
  assert.ok((await service.readQueue()).meetings.some((m) => m.id === e));

  // A receipt alone is not enough: a crash after the receipt, then the file removed, still keeps the meeting.
  const receiptsFile = path.join(ws, '.situation-board', 'routines', 'meeting-digest-receipts.jsonl');
  await fsp.appendFile(receiptsFile, JSON.stringify({ meeting: e, update_id: made, files: [], at: '2026-10-29T18:02:00Z' }) + '\n');
  await fsp.writeFile(batchFile(ws), batch([[e, [[`${a}-notes.md`, 'notes']]]], made, true));
  const withReceipt = await service.runNow(new Date('2026-10-29T18:03:00'));
  assert.match(withReceipt.message, new RegExp(`${e} stayed in the queue`));
  assert.ok((await service.readQueue()).meetings.some((m) => m.id === e));
});

test('a published digest removed by hand before the handoff keeps its meetings on hold, never in a new digest by itself', async (t) => {
  const ws = await workspace(t);
  const service = new MeetingDigestService();
  const a = await queueMeeting(service, 'Sync', '2026-10-28', [['a.md', Buffer.from('A')]]);
  await fsp.writeFile(batchFile(ws), batch([[a, [[`${a}-a.md`, 'A']]]], 'CU-2026-0009', true));
  const result = await service.runNow(new Date('2026-10-28T18:00:00'));
  assert.equal(result.status, 'error');
  assert.match(result.message, /was removed before its meetings left the queue/);
  assert.equal((await updates.list()).length, 0);
  const [held] = (await service.readQueue()).meetings;
  assert.ok(held!.held, 'on hold');
  const nothing = await service.runNow(new Date('2026-10-28T18:05:00'));
  assert.match(nothing.message, /No meetings in the queue/);
  assert.equal((await updates.list()).length, 0);

  // Published, then the folder removed before the batch recorded it: the same, since a reserved folder never just disappears.
  const b = await queueMeeting(service, 'Review', '2026-10-28', [['b.md', Buffer.from('B')]]);
  await fsp.writeFile(batchFile(ws), batch([[b, [[`${b}-b.md`, 'B']]]], 'CU-2026-0010'));
  assert.match((await service.runNow(new Date('2026-10-28T18:06:00'))).message, /was removed before its meetings left the queue/);
  assert.ok((await service.readQueue()).meetings.find((m) => m.id === b)!.held);
  assert.equal((await updates.list()).length, 0);

  // Queued again by the user: the next run takes it.
  await service.queue(a);
  const made = await service.runNow(new Date('2026-10-28T18:10:00'));
  assert.match(made.message, /Made digest/);
});

test('a readable copy never replaces another original, whatever the upload order', async (t) => {
  await workspace(t);
  const service = new MeetingDigestService();
  const notes = Buffer.from('Notes that only look like a transcript copy.');
  for (const [order, files] of [
    ['transcript first', [['talk.vtt', vtt('Jane Doe', 'Hello.')], ['talk.transcript.md', notes]]],
    ['notes first', [['talk.transcript.md', notes], ['talk-2.transcript.md', Buffer.from('More notes.')], ['talk.vtt', vtt('Jane Doe', 'Hello.')]]],
  ] as [string, [string, Buffer][]][]) {
    await queueMeeting(service, 'Talk', '2026-10-28', files);
    const update = await updates.get((await service.runNow(new Date('2026-10-28T18:00:00'))).context_update!);
    assert.equal(update.transcripts.length, 1, order);
    const copy = update.transcripts[0]!;
    const content = await fsp.readFile(await updates.materialPath(update.id, copy.file));
    assert.equal(createHash('sha256').update(content).digest('hex'), copy.sha256, `${order}: the record matches its file`);
    assert.ok(content.includes('Hello.'), order);
    for (const [name, data] of files.filter(([n]) => !n.endsWith('.vtt'))) {
      const original = update.digest_meetings[0]!.files.find((f) => f.source === name)!;
      assert.deepEqual(await fsp.readFile(await updates.materialPath(update.id, original.file)), data, `${order}: ${name} is intact`);
    }
    const file = path.join(process.env.ESB_WORKSPACE_PATH!, 'context-updates', update.id, 'update.md');
    await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('status: ready', 'status: done'));
  }
});

test('a queue folder that is a symbolic link out of the workspace is refused, and nothing outside is written or removed', async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-digest-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.mkdir(path.join(outside, 'MQ-2026-0001'));
  await fsp.writeFile(path.join(outside, 'MQ-2026-0001', 'keep.txt'), 'sentinel');
  await fsp.symlink(outside, path.join(ws, 'context-updates', 'meeting-queue'));
  const service = new MeetingDigestService();
  await assert.rejects(service.createMeeting({ title: 'X', meeting_date: '2026-10-28' }), /symbolic link/);
  await assert.rejects(service.removeMeeting('MQ-2026-0001'), /symbolic link/);
  assert.deepEqual((await fsp.readdir(outside)).sort(), ['MQ-2026-0001']);
  assert.equal(await fsp.readFile(path.join(outside, 'MQ-2026-0001', 'keep.txt'), 'utf-8'), 'sentinel');
  assert.match((await service.view()).queue_problems[0]!.reason, /symbolic link/);
});

test('a receipts file that is a symbolic link out of the workspace is never written, and the meeting stays queued', async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-digest-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'sentinel.jsonl'), 'sentinel\n');
  await fsp.symlink(path.join(outside, 'sentinel.jsonl'), path.join(ws, '.situation-board', 'routines', 'meeting-digest-receipts.jsonl'));
  const service = new MeetingDigestService();
  const a = await queueMeeting(service, 'Sync', '2026-10-28', [['a.md', Buffer.from('A')]]);
  const result = await service.runNow(new Date('2026-10-28T18:00:00'));
  assert.equal(result.status, 'error');
  assert.match(result.message, /symbolic link/);
  assert.equal(await fsp.readFile(path.join(outside, 'sentinel.jsonl'), 'utf-8'), 'sentinel\n');
  assert.deepEqual((await service.readQueue()).meetings.map((m) => m.id), [a]);
});

test('long meetings: a digest holds at most max_characters of readable text, and a longer meeting gets a digest of its own', async (t) => {
  const ws = await workspace(t);
  const service = new MeetingDigestService();
  await service.update({ max_characters: 50_000 });
  // About 80 minutes of fictional transcript: well over 50,000 characters in its readable copy.
  const at = (s: number) => new Date(s * 1000).toISOString().slice(11, 23);
  let long = 'WEBVTT\n\n';
  for (let i = 0; i < 1200; i++) long += `${at(i * 4)} --> ${at(i * 4 + 3)}\n<v Jane Doe>We agreed to move the pilot review to next week and check the budget first.</v>\n\n`;
  const a = await queueMeeting(service, 'Short sync', '2026-10-26', [['a.md', Buffer.from('Short notes.')]]);
  const b = await queueMeeting(service, 'Workshop', '2026-10-27', [['workshop.vtt', Buffer.from(long)]]);
  const c = await queueMeeting(service, 'Short review', '2026-10-28', [['c.md', Buffer.from('More notes.')]]);
  const close = async (id: string) => {
    const file = path.join(ws, 'context-updates', id, 'update.md');
    await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('status: ready', 'status: done'));
  };

  // The workshop does not fit next to the first meeting, and the one after it waits too: oldest first.
  const first = await service.runNow(new Date('2026-10-28T18:00:00'));
  assert.deepEqual((await updates.get(first.context_update!)).digest_meetings.map((m) => m.id), [a]);
  assert.match(first.message, /2 more wait for the next digest \(at most 10 meetings and 50,000 characters of text per digest\)/);
  await close(first.context_update!);
  const second = await service.runNow(new Date('2026-10-29T18:00:00'));
  assert.deepEqual((await updates.get(second.context_update!)).digest_meetings.map((m) => m.id), [b]);
  assert.match(second.message, new RegExp(`${b} is longer than the text per digest, so it has a digest of its own`));
  const list = await fsp.readFile(path.join(ws, 'context-updates', second.context_update!, 'materials', 'meetings.md'), 'utf-8');
  const size = Number(/text_characters: (\d+)/.exec(list)![1]);
  assert.ok(size > 50_000 && size < long.length, `counted by the readable copy: ${size}`);
  await close(second.context_update!);
  const third = await service.runNow(new Date('2026-10-30T18:00:00'));
  assert.deepEqual((await updates.get(third.context_update!)).digest_meetings.map((m) => m.id), [c]);

  assert.throws(() => parseSettings({ max_characters: 1000 }), /50000 to 4000000/);
  assert.equal(parseSettings({}).max_characters, 400_000);
});

test('the schedule: first check counts from now, missed runs collapse into one, switched off makes nothing', async (t) => {
  await workspace(t);
  const service = new MeetingDigestService();
  await queueMeeting(service, 'Sync', '2026-10-26', [['a.md', Buffer.from('A')]]);
  assert.equal(await service.runIfDue(new Date('2026-10-26T17:00:00')), null, 'first check');
  assert.equal(await service.runIfDue(new Date('2026-10-26T17:59:00')), null, 'not due yet');
  // Off from Monday evening to Thursday: one run, one digest.
  const caught = await service.runIfDue(new Date('2026-10-29T09:00:00'));
  assert.match(caught!.message, /Made digest/);
  assert.equal((await updates.list()).length, 1);
  await service.update({ enabled: false }, new Date('2026-10-29T10:00:00'));
  await queueMeeting(service, 'Later', '2026-10-29', [['b.md', Buffer.from('B')]]);
  assert.equal(await service.runIfDue(new Date('2026-10-30T19:00:00')), null);
  assert.equal((await service.view()).queue.length, 1);
});
