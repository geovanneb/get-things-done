import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pileFor, isDone, isAwaitingReview, isOpen, type Pile } from '../src/services/taskStatus';

// Every status the app writes or reads, plus values it must not crash on.
const cases: Array<{ status: string; pile: Pile | null; done: boolean; review: boolean; open: boolean }> = [
  { status: 'backlog', pile: 'backlog', done: false, review: false, open: true },
  { status: 'ready', pile: 'backlog', done: false, review: false, open: true },
  { status: 'in_progress', pile: 'active', done: false, review: false, open: true },
  { status: 'blocked', pile: 'active', done: false, review: false, open: true },
  // `review` is an old in-progress spelling and stays on the Active column, not Needs Review.
  { status: 'review', pile: 'active', done: false, review: false, open: true },
  { status: 'in_review', pile: 'review', done: false, review: true, open: true },
  { status: 'done', pile: 'done', done: true, review: false, open: false },
  // Legacy spelling of Done that existing workspaces still carry.
  { status: 'approved', pile: 'done', done: true, review: false, open: false },
  // Archived tasks are off the board and no longer open, but not "done" either.
  { status: 'archived', pile: null, done: false, review: false, open: false },
  // Unknown values: no column, and treated as still open so they are not silently dropped.
  { status: 'someday', pile: null, done: false, review: false, open: true },
  { status: '', pile: null, done: false, review: false, open: true },
  { status: 'DONE', pile: null, done: false, review: false, open: true },
];

for (const c of cases) {
  test(`status "${c.status}"`, () => {
    assert.equal(pileFor(c.status), c.pile, 'pileFor');
    assert.equal(isDone(c.status), c.done, 'isDone');
    assert.equal(isAwaitingReview(c.status), c.review, 'isAwaitingReview');
    assert.equal(isOpen(c.status), c.open, 'isOpen');
  });
}
