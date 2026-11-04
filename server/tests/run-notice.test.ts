import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanNoticeTitle, runNoticeData } from '../src/services/runNotice';

const run = { command: 'analyze', status: 'succeeded', started_at: '2026-11-04T09:00:00.000Z' };
const update = { title: 'Weekly sync', proposals: [{}, {}] };
const expected = { workspace: '/w/northwind', started_at: run.started_at };

test('a run notice is given only for the expected workspace and that very run, once it ended (#246)', () => {
  assert.deepEqual(runNoticeData('/w/northwind', expected, run, update), { outcome: 'review', title: 'Weekly sync', proposals: 2 });
  assert.equal(runNoticeData('/w/other', expected, run, update), null, 'another workspace is open now');
  assert.equal(runNoticeData('/w/northwind', { ...expected, started_at: '2026-11-04T10:00:00.000Z' }, run, update), null, 'another run');
  assert.equal(runNoticeData('/w/northwind', expected, null, update), null, 'no run');
  assert.equal(runNoticeData('/w/northwind', expected, { ...run, status: 'running' }, update), null, 'still going');
  assert.equal(runNoticeData('/w/northwind', expected, { ...run, status: 'cancelled' }, update), null, 'stopped by the user');
  assert.equal(runNoticeData('/w/northwind', expected, run, null)?.proposals, null, 'the update not read: unknown, never none');
  assert.equal(runNoticeData('/w/northwind', expected, { ...run, command: 'apply', status: 'failed' }, update)?.outcome, 'apply-failed');
});

test('a title is cleaned for a system notice', () => {
  assert.equal(cleanNoticeTitle('Weekly\nsync‮؜ x'), 'Weekly sync x');
  assert.equal(cleanNoticeTitle('y'.repeat(300)).length, 80);
});
