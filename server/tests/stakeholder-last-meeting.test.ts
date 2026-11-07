import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { stringifyMarkdown } from '../src/utils/markdown';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { StakeholderService } from '../src/services/stakeholderService';
import { lastMeetingInvolving } from '../src/services/stakeholderMeetings';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-last-meeting-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context-updates', '.situation-board/routines', '.situation-board/trash', 'context', 'stakeholders/people', 'stakeholders/groups']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A finished digest of one fictional meeting, its record listing `attendees`; confirmed unless said otherwise. */
async function meeting(ws: string, n: number, opts: { date: string; attendees: { name: string; ref?: string }[]; confirmed?: boolean }) {
  const id = `CU-2026-${String(n).padStart(4, '0')}`;
  const mq = `MQ-2026-${String(n).padStart(4, '0')}`;
  const dir = path.join(ws, 'context-updates', id);
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Fictional>Words ${n}.</v>\n`;
  await fsp.writeFile(path.join(dir, 'materials', `${mq}-a.vtt`), vtt);
  await fsp.writeFile(path.join(dir, 'materials', 'meetings.md'), '# Meetings');
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id, type: 'context-update', title: `Fictional digest ${n}`, status: 'done', source_date: opts.date || day(-30),
    origin: 'meetings', kind: 'daily-digest', keep_meeting_text: true,
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z', applied_at: '2026-10-28T09:00:00.000Z',
    materials: [{ name: `${mq}-a.vtt`, size: 1, type: 'text/vtt' }, { name: 'meetings.md', size: 1, type: 'text/markdown' }],
    digest_meetings: [{ id: mq, title: `Fictional meeting ${n}`, meeting_date: opts.date || day(-30), files: [{ source: 'a.vtt', file: `${mq}-a.vtt`, sha256: sha(vtt) }] }],
    meeting_records: [{ id: 'M-01', title: `Fictional meeting ${n}`, meeting_date: opts.date, meeting: mq, attendees: opts.attendees, decisions: [], open_questions: [], action_items: [], source: `${mq}-a.vtt`, confirmation: opts.confirmed === false ? null : 'confirmed' }],
  }));
  if (opts.confirmed !== false) {
    const revision = (await new ContextUpdateService().get(id)).meeting_records[0]!.revision;
    const file = path.join(dir, 'update.md');
    await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('confirmation: confirmed', `confirmation: confirmed\n    confirmed_hash: ${revision}`));
  }
  return mq;
}

test('the latest confirmed meeting that lists the person, and nothing that only mentions or expects them', async (t) => {
  const ws = await workspace(t);
  const person = await new StakeholderService().createStakeholder({ name: 'Priya Natarajan', influence: 'influencer' } as never);
  const other = await new StakeholderService().createStakeholder({ name: 'Marcus Webb', influence: 'decision_maker' } as never);

  assert.deepEqual(await lastMeetingInvolving(person.id), { last: null, undated: false }, 'none yet');

  const older = await meeting(ws, 1, { date: day(-20), attendees: [{ name: 'Priya Natarajan', ref: person.id }, { name: 'Me', ref: 'me' }] });
  const newer = await meeting(ws, 2, { date: day(-3), attendees: [{ name: 'Priya Natarajan', ref: person.id }] });
  await meeting(ws, 3, { date: day(-1), attendees: [{ name: 'Priya Natarajan', ref: person.id }], confirmed: false });
  await meeting(ws, 4, { date: day(-1), attendees: [{ name: 'Priya Natarajan' }] });
  await meeting(ws, 5, { date: day(5), attendees: [{ name: 'Priya Natarajan', ref: person.id }] });

  const result = await lastMeetingInvolving(person.id);
  assert.deepEqual(result.last, { id: newer, title: 'Fictional meeting 2', meeting_date: day(-3) },
    'not the unconfirmed one, not a name-only match, not a date in the future');
  assert.ok(older);

  // Someone listed only in another meeting: theirs alone.
  assert.equal((await lastMeetingInvolving(other.id)).last, null);
});

test('confirmed meetings without a known date say so, rather than "no meeting"', async (t) => {
  const ws = await workspace(t);
  const person = await new StakeholderService().createStakeholder({ name: 'Sofia Reyes', influence: 'influencer' } as never);
  await meeting(ws, 1, { date: '', attendees: [{ name: 'Sofia Reyes', ref: person.id }] });
  assert.deepEqual(await lastMeetingInvolving(person.id), { last: null, undated: true });
});

test('an invalid or unknown stakeholder is refused', async (t) => {
  await workspace(t);
  await assert.rejects(lastMeetingInvolving('../x'), (err: Error & { statusCode?: number }) => err.statusCode === 400);
  await assert.rejects(lastMeetingInvolving('STK-0999'), (err: Error & { statusCode?: number }) => err.statusCode === 404);
});
