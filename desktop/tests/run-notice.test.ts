import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, noticeFromServer, noticeMemory, parseRunNoticeRequest, runNoticeWords } from '../src/run-notice';

const req = { update_id: 'CU-2026-0001', workspace: '/w/northwind', started_at: '2026-11-04T09:00:00.000Z' };
const run = { command: 'analyze', status: 'succeeded', started_at: req.started_at };
const update = { title: 'Weekly sync', proposals: [{}, {}] };

test('the page only names a run; anything else it sends is not used', () => {
  assert.deepEqual(parseRunNoticeRequest({ ...req, title: 'Security update required', outcome: 'applied' }), req);
  for (const bad of [null, 'text', {}, { ...req, update_id: '../x' }, { ...req, workspace: '' }, { ...req, started_at: 'now' }]) {
    assert.equal(parseRunNoticeRequest(bad), null, JSON.stringify(bad));
  }
});

test('a notice is said only when the server confirms that run ended, in its words', () => {
  const answer = { notice: { outcome: 'review', title: 'Weekly sync', proposals: 2 } };
  assert.deepEqual(runNoticeWords(noticeFromServer(req, answer)!), { title: 'CU-2026-0001 is ready for your review', body: 'Weekly sync: the analysis proposed 2 changes.' });
  for (const none of [null, {}, { notice: null }, { notice: { outcome: 'install' } }]) assert.equal(noticeFromServer(req, none), null, JSON.stringify(none));
  assert.equal(runNoticeWords(noticeFromServer(req, { notice: { outcome: 'review', title: '', proposals: null } })!).body, 'the analysis finished. Open it to review.', 'unknown is never "no changes"');
  assert.equal(noticeFromServer(req, { notice: { outcome: 'review', title: 'a\u202Eb', proposals: 1 } })?.title, 'a b', 'cleaned again here');
});

test('a title is cleaned for the system: one line, no control or direction characters, at most 80 characters', () => {
  assert.equal(cleanTitle('Weekly\nsync\t‮evil⁦؜x'), 'Weekly sync evil x');
  assert.equal(cleanTitle('x'.repeat(300)).length, 80);
  assert.equal(cleanTitle(5), '');
});

test('each run is said once, and only counts as said once its notice showed', () => {
  const memory = noticeMemory(2);
  assert.equal(memory.said(req), false);
  // A notice the system refused is not remembered: the run can still be said later.
  assert.equal(memory.said(req), false);
  memory.remember(req);
  assert.equal(memory.said(req), true);
  assert.equal(memory.said({ ...req, started_at: '2026-11-04T10:00:00.000Z' }), false, 'a new run of the same update');
  assert.equal(memory.said({ ...req, workspace: '/w/other' }), false, 'the same id in another workspace');
});
