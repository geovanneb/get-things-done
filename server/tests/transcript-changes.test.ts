import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { applyChanges } from '../src/services/transcriptChanges';
import { checkTranscriptChanges, writeCorrectedVersion } from '../src/services/meetingVersions';
import { readFolder } from '../src/services/meetingFolder';
import { audioTranscriptMarkdown } from '../src/services/meetingTranscription';
import { copyTurns, parseWebVtt, transcriptMarkdown } from '../src/utils/transcript';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
/** Receipts as a correction makes them: a hash of what it finishes. */
const R1 = sha('finishing CU-2026-0007');
const R2 = sha('finishing CU-2026-0008');

/** A fictional Teams export: Jane's two cues form one turn, with markup and an entity, in Windows line breaks. */
const VTT = [
  'WEBVTT', '',
  '1', '00:00:01.000 --> 00:00:04.000', '<v Jane Doe>Good morning, everyone.</v>', '',
  '2', '00:00:04.500 --> 00:00:08.000', '<v Jane Doe>Ask Dual Line about the pilot &amp; the budget.</v>', '',
  '3', '00:00:09.000 --> 00:00:12.000', '<v Taro Yamada>Dual Line sent a quote last week.</v>', '',
].join('\r\n');
const copyOf = (vtt: string, name = 'sync.vtt') => transcriptMarkdown(name, sha(vtt), parseWebVtt(vtt)!);
const RECORDING = audioTranscriptMarkdown('call.wav', 'a'.repeat(64), 'whisper-large-v3', 'auto', 10, [
  { start: 0, end: 3, text: 'We call Dual Line on Monday.' },
  { start: 4, end: 7, text: 'Dual Line, then the budget.' },
], true);
const files = (map: Record<string, string>) => async (name: string) => map[name] ?? null;

test('turns are numbered in new copies, and an old copy without numbers is read the same way', () => {
  const copy = copyOf(VTT);
  assert.match(copy, /^#1 \[00:00:01 → 00:00:08\] Jane Doe$/m);
  assert.match(copy, /^#2 \[00:00:09 → 00:00:12\] Taro Yamada$/m);
  const old = copy.replace(/^#\d+ /gm, '');
  assert.deepEqual(copyTurns(old)!.turns.map((t) => [t.number, t.lines]), copyTurns(copy)!.turns.map((t) => [t.number, t.lines]));
  // A printed number out of place is not trusted.
  assert.equal(copyTurns(copy.replace('#2 [', '#5 [')), null);
});

test('a recording\'s copy changes in that one line of that turn', async () => {
  const { files: out, problems } = await applyChanges([{ file: 'call.transcript.md', turn: 2, before: 'Dual Line', after: 'Dual Lane' }], files({ 'call.transcript.md': RECORDING }));
  assert.deepEqual(problems, [null]);
  const changed = out.get('call.transcript.md')!;
  assert.deepEqual(copyTurns(changed)!.turns.map((t) => t.lines[0]), ['We call Dual Line on Monday.', 'Dual Lane, then the budget.'], 'turn 1 untouched');
  assert.equal(changed.split('\n').filter((l, i) => l !== RECORDING.split('\n')[i]).length, 1, 'one line differs');
});

test('a WebVTT original changes in its one cue, everything else as written, and its copy is made again from it', async () => {
  const before = { 'sync.vtt': VTT, 'sync.transcript.md': copyOf(VTT) };
  const { files: out, problems } = await applyChanges([{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }], files(before));
  assert.deepEqual(problems, [null]);
  const vtt = out.get('sync.vtt')!;
  assert.equal(vtt, VTT.replace('Ask Dual Line', 'Ask Dual Lane'), 'only that cue, Windows line breaks and markup kept');
  assert.ok(vtt.includes('Dual Line sent a quote'), 'Taro\'s cue keeps its words');
  assert.equal(out.get('sync.transcript.md'), copyOf(vtt), 'the copy is the copy of the new original');
  // A copy made before numbering is changed the same way.
  const old = { ...before, 'sync.transcript.md': before['sync.transcript.md'].replace(/^#\d+ /gm, '') };
  assert.deepEqual((await applyChanges([{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }], files(old))).problems, [null]);
});

test('a change that cannot be placed for certain is refused with its reason, never guessed', async () => {
  const map = files({ 'sync.vtt': VTT, 'sync.transcript.md': copyOf(VTT), 'call.transcript.md': RECORDING, 'notes.md': '# Notes\n\nDual Line.', 'deck.text.md': 'Text of a deck' });
  const one = async (change: Record<string, unknown>) => (await applyChanges([change], map)).problems[0];
  assert.match(await one({ file: 'call.transcript.md', turn: 3, before: 'x', after: 'y' }) ?? '', /no turn 3/);
  assert.match(await one({ file: 'call.transcript.md', turn: 1, before: 'Dual Lane', after: 'x' }) ?? '', /is not in turn 1/);
  assert.match(await one({ file: 'sync.transcript.md', turn: 2, before: 'e', after: 'E' }) ?? '', /more than once/);
  assert.match(await one({ file: 'sync.transcript.md', turn: 1, before: 'everyone. Ask', after: 'x' }) ?? '', /is not in turn 1/, 'across two cues: never split');
  assert.match(await one({ file: 'sync.transcript.md', turn: 1, before: 'pilot & the', after: 'pilot and the' }) ?? '', /written differently/, 'markup in the original: refused');
  assert.match(await one({ file: 'call.transcript.md', turn: 1, before: 'Dual Line', after: 'Dual\nLane' }) ?? '', /one line/);
  assert.match(await one({ file: 'call.transcript.md', turn: 1, before: 'Dual Line', after: 'Dual `Lane`' }) ?? '', /backtick/);
  assert.match(await one({ file: 'call.transcript.md', turn: 1, before: 'Dual Line', after: 'Dual Line' }) ?? '', /same/);
  assert.match(await one({ file: 'notes.md', turn: 1, before: 'Dual Line', after: 'Dual Lane' }) ?? '', /not a readable transcript/);
  assert.match(await one({ file: 'missing.md', turn: 1, before: 'a', after: 'b' }) ?? '', /not a file of this version/);
  assert.match(await one({ file: '../update.md', turn: 1, before: 'a', after: 'b' }) ?? '', /does not name a file/);
  // The copy's original missing from the version: the two could not change together.
  assert.match((await applyChanges([{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'x' }], files({ 'sync.transcript.md': copyOf(VTT) }))).problems[0] ?? '', /cannot change together/);
});

/** A meeting folder by hand: v1 holds an imported WebVTT, its copy, and notes. */
async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-changes-'));
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  const dir = path.join(ws, 'meetings', 'CU-2026-0001-M-01');
  await fsp.mkdir(path.join(dir, 'v1'), { recursive: true });
  const v1 = { 'sync.vtt': VTT, 'sync.transcript.md': copyOf(VTT), 'notes.md': 'Fictional notes' };
  for (const [name, text] of Object.entries(v1)) await fsp.writeFile(path.join(dir, 'v1', name), text);
  await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify({
    schema: 1, id: 'CU-2026-0001-M-01', update_id: 'CU-2026-0001', current: 'v1', audio: [],
    versions: [{ id: 'v1', at: '2026-10-28T00:00:00.000Z', made_from: 'review', files: Object.entries(v1).map(([name, text]) => ({ name, sha256: sha(text) })) }],
  }));
  return ws;
}

test('a finished correction writes the next version with the original and its copy changed, and makes it current', async (t) => {
  const ws = await folder(t);
  const changes = [{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }, { file: 'sync.transcript.md', turn: 2, before: 'Dual Line sent', after: 'Dual Lane sent' }];
  assert.deepEqual(await checkTranscriptChanges(ws, 'CU-2026-0001-M-01', 'v1', changes), [null, null]);
  assert.equal(await writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes, receipt: R1 }), 'v2');
  const f = await readFolder(ws, 'CU-2026-0001-M-01');
  assert.ok(f.state === 'ok');
  assert.equal(f.manifest.current, 'v2', 'approving the correction is the choice');
  const v2 = f.manifest.versions[1]!;
  assert.deepEqual([v2.made_from, v2.correction, v2.base], ['correction', 'CU-2026-0007', 'v1']);
  const vtt = await fsp.readFile(path.join(f.dir, 'v2', 'sync.vtt'), 'utf-8');
  assert.equal(vtt, VTT.replace('Ask Dual Line', 'Ask Dual Lane').replace('Dual Line sent', 'Dual Lane sent'));
  assert.equal(await fsp.readFile(path.join(f.dir, 'v2', 'sync.transcript.md'), 'utf-8'), copyOf(vtt));
  assert.equal(v2.files.find((x) => x.name === 'sync.vtt')!.sha256, sha(vtt));
  assert.equal(await fsp.readFile(path.join(f.dir, 'v1', 'sync.vtt'), 'utf-8'), VTT, 'the reviewed version stays as it was');
  assert.notEqual((await fsp.stat(path.join(f.dir, 'v2', 'notes.md'))).ino, (await fsp.stat(path.join(f.dir, 'v1', 'notes.md'))).ino, 'unchanged files are copied, never shared with the version before');
});

test('a correction is refused, with nothing written, when the text moved on or a change no longer fits', async (t) => {
  const ws = await folder(t);
  const ok = [{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }];
  const conflict = (err: { statusCode?: number }) => err.statusCode === 409;
  await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', receipt: R1, changes: [...ok, { file: 'sync.transcript.md', turn: 9, before: 'a', after: 'b' }] }), (err: Error & { statusCode?: number }) => conflict(err) && /change 2: this transcript has no turn 9/.test(err.message));
  await writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 });
  // A second correction started from v1: v2 is in use now, so it is stale.
  await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0008', changes: ok, receipt: R2 }), conflict);
  await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v2', correction: 'not-an-id', changes: ok, receipt: R2 }), (err: { statusCode?: number }) => err.statusCode === 400);
  const f = await readFolder(ws, 'CU-2026-0001-M-01');
  assert.ok(f.state === 'ok' && f.manifest.versions.length === 2);
  assert.deepEqual((await fsp.readdir(f.dir)).sort(), ['meeting.json', 'v1', 'v2'], 'no third version, no draft left behind');
});

test('finishing again with the same receipt returns the version written, even after another was chosen; another receipt is refused', async (t) => {
  const ws = await folder(t);
  const ok = [{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }];
  assert.equal(await writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 }), 'v2');
  // A crash before the correction was marked done: finishing again finds v2, writes nothing.
  assert.equal(await writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 }), 'v2');
  // The user chose v1 back meanwhile: still v2 found, and v1 stays current.
  const file = path.join(ws, 'meetings', 'CU-2026-0001-M-01', 'meeting.json');
  await fsp.writeFile(file, JSON.stringify({ ...JSON.parse(await fsp.readFile(file, 'utf-8')), current: 'v1' }));
  assert.equal(await writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 }), 'v2');
  // The same correction with something else to finish: refused, nothing written.
  await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: sha('another record') }),
    (err: Error & { statusCode?: number }) => err.statusCode === 409 && /already wrote v2/.test(err.message));
  await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: 'nope' }),
    (err: { statusCode?: number }) => err.statusCode === 400);
  const f = await readFolder(ws, 'CU-2026-0001-M-01');
  assert.ok(f.state === 'ok');
  assert.deepEqual([f.manifest.current, f.manifest.versions.map((v) => v.id), f.manifest.versions[1]!.receipt], ['v1', ['v1', 'v2'], R1]);
});

test('a file changed on disk since its version was kept is never corrected as that text', async (t) => {
  const ws = await folder(t);
  const dir = path.join(ws, 'meetings', 'CU-2026-0001-M-01');
  // Changed by something outside the dashboard, consistently, so the change would still fit.
  await fsp.writeFile(path.join(dir, 'v1', 'sync.transcript.md'), copyOf(VTT).replace('everyone', 'all'));
  const ok = [{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }];
  await assert.rejects(checkTranscriptChanges(ws, 'CU-2026-0001-M-01', 'v1', ok), (err: Error & { statusCode?: number }) => err.statusCode === 409 && /changed since it was kept/.test(err.message));
  await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 }), /changed since it was kept/);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['meeting.json', 'v1'], 'nothing written');
});

test('receipts and crash leftovers: an unlisted folder never counts, a version without a receipt is never guessed, damaged receipts are refused', async (t) => {
  const ws = await folder(t);
  const dir = path.join(ws, 'meetings', 'CU-2026-0001-M-01');
  const file = path.join(dir, 'meeting.json');
  const ok = [{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }];
  // A crash after the new folder was renamed into place, before meeting.json listed it.
  await fsp.mkdir(path.join(dir, 'v2'));
  await fsp.writeFile(path.join(dir, 'v2', 'sync.transcript.md'), 'half written');
  assert.equal(await writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 }), 'v2');
  assert.notEqual(await fsp.readFile(path.join(dir, 'v2', 'sync.transcript.md'), 'utf-8'), 'half written', 'replaced by the real result');
  let f = await readFolder(ws, 'CU-2026-0001-M-01');
  assert.ok(f.state === 'ok' && f.manifest.versions.filter((v) => v.id === 'v2').length === 1 && f.manifest.versions[1]!.receipt === R1);

  // A correction version written before receipts: finishing it again is refused, never taken as the same; others go on.
  const m = JSON.parse(await fsp.readFile(file, 'utf-8'));
  delete m.versions[1].receipt;
  await fsp.writeFile(file, JSON.stringify(m));
  const before = await fsp.readFile(file, 'utf-8');
  await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 }),
    (err: { statusCode?: number }) => err.statusCode === 409);
  assert.equal(await fsp.readFile(file, 'utf-8'), before, 'nothing changed');
  const next = [{ file: 'sync.transcript.md', turn: 2, before: 'Dual Line sent', after: 'Dual Lane sent' }];
  assert.equal(await writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v2', correction: 'CU-2026-0008', changes: next, receipt: R2 }), 'v3');

  // A receipt in meeting.json that is not one: the folder is damaged, never read as if it had none.
  for (const bad of [null, 7, 'abc', 'g'.repeat(64)]) {
    const damaged = JSON.parse(await fsp.readFile(file, 'utf-8'));
    damaged.versions[2].receipt = bad;
    await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify(damaged));
    f = await readFolder(ws, 'CU-2026-0001-M-01');
    assert.equal(f.state, 'damaged', JSON.stringify(bad));
  }
});

test('an original changed on disk is refused too, also when it and its copy were changed together so the change still fits', async (t) => {
  const ok = [{ file: 'sync.transcript.md', turn: 1, before: 'Ask Dual Line', after: 'Ask Dual Lane' }];
  for (const [what, change] of [
    ['line endings only', async (dir: string) => fsp.writeFile(path.join(dir, 'v1', 'sync.vtt'), VTT.replace(/\r\n/g, '\n'))],
    ['both, consistently', async (dir: string) => {
      const other = VTT.replace('Good morning', 'Good afternoon');
      await fsp.writeFile(path.join(dir, 'v1', 'sync.vtt'), other);
      await fsp.writeFile(path.join(dir, 'v1', 'sync.transcript.md'), copyOf(other));
    }],
  ] as const) {
    const ws = await folder(t);
    const dir = path.join(ws, 'meetings', 'CU-2026-0001-M-01');
    await change(dir);
    const refused = (err: Error & { statusCode?: number }) => err.statusCode === 409 && /changed since it was kept/.test(err.message);
    await assert.rejects(checkTranscriptChanges(ws, 'CU-2026-0001-M-01', 'v1', ok), refused, what);
    await assert.rejects(writeCorrectedVersion(ws, 'CU-2026-0001-M-01', { from_version: 'v1', correction: 'CU-2026-0007', changes: ok, receipt: R1 }), refused, what);
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['meeting.json', 'v1'], `${what}: nothing written`);
  }
});
