/**
 * Unit tests for the task panel's draft. Run with `npm run test:task-draft --workspace=ui`.
 */
import type { Task } from '../types';
import { canSave, emptyDraft, hasEdits, isArchived, taskDraftReducer as step, type TaskDraft, type TaskDraftAction } from './taskDraft';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const v1 = {
  id: 'TASK-2026-0001', title: 'Fictional launch plan', status: 'in_progress', priority: 'high',
  stakeholders: [], deliverables: [], body: 'Draft the plan.', updated_at: '2026-03-02T10:00:00.000Z',
} as unknown as Task;
// Changed in the background (an agent's update) while the panel is open.
const v2 = { ...v1, status: 'in_review', updated_at: '2026-03-02T10:05:00.000Z' } as Task;
const SAVED_AT = '2026-03-02T10:10:00.000Z';

const run = (...actions: TaskDraftAction[]) => actions.reduce(step, emptyDraft);
const edit = (field: string, value: unknown): TaskDraftAction => ({ type: 'edit', field, value });
const refresh = (task: Task): TaskDraftAction => ({ type: 'refresh', task });
const title = (s: TaskDraft) => s.draft?.title;

// Loading and refreshing a clean draft.
{
  const s = run(refresh(v1));
  check('the first copy is the draft and its baseline', s.draft === v1 && s.baseline === v1 && !hasEdits(s) && canSave(s));
  const r = step(s, refresh(v2));
  check('a refresh while there are no edits is taken', r.draft === v2 && r.baseline === v2 && !hasEdits(r));
}

// Editing, a background refresh, then undoing the edits.
{
  const edited = run(refresh(v1), edit('title', 'Fictional launch plan, revised'));
  check('an edit makes the draft dirty', hasEdits(edited));
  const refreshed = step(edited, refresh(v2));
  check('a refresh while editing keeps the draft', title(refreshed) === 'Fictional launch plan, revised' && refreshed.draft?.status === 'in_progress');
  check('a refresh while editing keeps the baseline the draft started from', refreshed.baseline === v1 && refreshed.latest === v2);
  check('still dirty after the refresh', hasEdits(refreshed));
  const undone = step(refreshed, edit('title', v1.title));
  check('undoing the edits after a refresh clears Save (compared with the baseline, not the refreshed task)', !hasEdits(undone));
  check('undoing the edits takes the newer copy', undone.draft === v2 && undone.baseline === v2);
  const undoneNoRefresh = step(edited, edit('title', v1.title));
  check('undoing the edits with no refresh is clean and keeps the version', !hasEdits(undoneNoRefresh) && undoneNoRefresh.draft?.updated_at === v1.updated_at);
}

// A successful save, then the refresh it triggers.
{
  const edited = run(refresh(v1), edit('title', 'Fictional title A'));
  const sent = edited.draft!;
  const saved = step(edited, { type: 'saved', sent, updatedAt: SAVED_AT });
  check('after a save with no further edits nothing is dirty', !hasEdits(saved) && canSave(saved));
  check('after a save the baseline is the saved version', saved.baseline?.title === 'Fictional title A' && saved.baseline?.updated_at === SAVED_AT);
  const after = { ...v1, title: 'Fictional title A', updated_at: SAVED_AT, start_date: '2026-03-02T10:10:00.000Z' } as Task;
  const confirmed = step(saved, refresh(after));
  check('the refresh after the save is taken as it is on disk', confirmed.draft === after && !hasEdits(confirmed));
}

// Save response first, then an older refresh (read before the save) arrives.
{
  const edited = run(refresh(v1), edit('title', 'Fictional title A'));
  const saved = step(edited, { type: 'saved', sent: edited.draft!, updatedAt: SAVED_AT });
  const sameObject = step(saved, refresh(v1));
  check('save then the pre-save copy again: the saved state is kept', title(sameObject) === 'Fictional title A' && sameObject.baseline?.updated_at === SAVED_AT);
  const olderRead = step(saved, refresh({ ...v1 }));
  check('save then a pre-save read (older updated_at): the saved state is kept', title(olderRead) === 'Fictional title A' && !hasEdits(olderRead));
  const undone = step(olderRead, edit('title', 'Fictional title B'));
  const back = step(undone, edit('title', 'Fictional title A'));
  check('undoing an edit after the save never brings back the pre-save copy', title(back) === 'Fictional title A' && back.baseline?.updated_at === SAVED_AT);
  const newer = { ...v1, title: 'Fictional title A', status: 'blocked', updated_at: '2026-03-02T10:20:00.000Z' } as Task;
  const later = step(olderRead, refresh(newer));
  check('a copy newer than the save is still taken', later.draft === newer);
  const afterNewer = step(later, refresh(v1));
  check('once a newer copy arrived, the guard against older reads is over', afterNewer.draft === v1);
}

// Refresh first (still the pre-save version, read during the save), then the save response.
{
  const edited = run(refresh(v1), edit('title', 'Fictional title A'));
  const sent = edited.draft!;
  const during = step(edited, refresh({ ...v1 }));
  check('a refresh during the save keeps the draft being saved', title(during) === 'Fictional title A' && hasEdits(during));
  const saved = step(during, { type: 'saved', sent, updatedAt: SAVED_AT });
  check('refresh then save: clean, on the saved version', !hasEdits(saved) && saved.baseline?.updated_at === SAVED_AT);
  const again = step(saved, refresh(during.latest!));
  check('refresh then save: that pre-save copy never comes back', title(again) === 'Fictional title A');
}

// Newer server state seen before a delayed save response: the response must not undo it.
{
  const start = run(refresh(v1), edit('title', 'Fictional title A'));
  const sent = start.draft!;
  const sending = step(start, { type: 'saving' });
  const saved = (s: TaskDraft) => step(s, { type: 'saved', sent, updatedAt: SAVED_AT });

  const archived = { ...v1, title: 'Fictional title A', status: 'archived', updated_at: '2026-03-02T10:12:00.000Z' } as Task;
  const a = saved(step(sending, refresh(archived)));
  check('archived before the delayed save response: still archived', isArchived(a) && !canSave(a));
  check('archived before the delayed save response: shows the archived copy, nothing unsaved', a.draft === archived && !hasEdits(a));
  const aTyping = saved(step(step(sending, edit('body', 'Typed while saving.')), refresh(archived)));
  check('archived before the response, with edits typed during the save: the edits stay, unsaved and read-only',
    hasEdits(aTyping) && aTyping.draft?.body === 'Typed while saving.' && isArchived(aTyping) && !canSave(aTyping));

  const d = saved(step(sending, { type: 'gone' }));
  check('deleted before the delayed save response: still deleted', d.gone && !canSave(d));
  const dTyping = saved(step(step(sending, edit('body', 'Typed while saving.')), { type: 'gone' }));
  check('deleted before the response, with edits typed during the save: the edits stay and say so', dTyping.gone && hasEdits(dTyping));
  const goneThenSent = saved(step(step(start, { type: 'gone' }), { type: 'saving' }));
  check('a deletion seen before the save was sent is over once the save succeeds', !goneThenSent.gone && canSave(goneThenSent));

  const other = { ...v1, title: 'Fictional title A', priority: 'low', updated_at: '2026-03-02T10:15:00.000Z' } as Task;
  const o = saved(step(sending, refresh(other)));
  check('a newer edit by someone else before the delayed save response is kept', o.draft === other && o.latest === other && !hasEdits(o) && canSave(o));
  check('and the save response never marks it stale', step(o, refresh(other)).draft === other);

  const own = { ...v1, title: 'Fictional title A', updated_at: SAVED_AT } as Task;
  const s = saved(step(sending, refresh(own)));
  check('the saved version read before its own response is taken as it is on disk', s.draft === own && !hasEdits(s));
}

// Edits typed while the save runs.
{
  const edited = run(refresh(v1), edit('title', 'Fictional title A'));
  const sent = edited.draft!;
  const typing = step(edited, edit('body', 'Typed while saving.'));
  const saved = step(typing, { type: 'saved', sent, updatedAt: SAVED_AT });
  check('edits typed during the save stay dirty', hasEdits(saved) && saved.draft?.body === 'Typed while saving.');
  check('edits typed during the save start from the saved version', saved.draft?.updated_at === SAVED_AT && saved.baseline?.body === v1.body);
  const confirmed = step(saved, refresh({ ...v1, title: 'Fictional title A', updated_at: SAVED_AT } as Task));
  check('the refresh after the save keeps the edits typed during it', confirmed.draft?.body === 'Typed while saving.' && hasEdits(confirmed));
  const undone = step(confirmed, edit('body', v1.body));
  check('undoing the edits typed during the save is clean', !hasEdits(undone));
}

// A failed save (no "saved" step) keeps everything, whichever comes first.
{
  const edited = run(refresh(v1), edit('title', 'Fictional title A'));
  const refreshed = step(edited, refresh(v2));
  check('a failed save keeps the draft dirty and its baseline', hasEdits(refreshed) && refreshed.baseline === v1 && title(refreshed) === 'Fictional title A');
}

// Archived elsewhere.
{
  const archived = { ...v2, status: 'archived' } as Task;
  const dirty = step(run(refresh(v1), edit('title', 'Fictional title A')), refresh(archived));
  check('archived elsewhere while editing: the edits are kept and still unsaved', hasEdits(dirty) && title(dirty) === 'Fictional title A');
  check('archived elsewhere: shown archived and cannot be saved', isArchived(dirty) && !canSave(dirty));
  check('archived elsewhere: no further edits are taken', step(dirty, edit('title', 'x')) === dirty);
  const clean = step(run(refresh(v1)), refresh(archived));
  check('archived elsewhere with no edits shows the archived task', clean.draft === archived && !hasEdits(clean) && !canSave(clean));
  const draftOnly = step(run(refresh(v1)), edit('status', 'archived'));
  check('choosing Archived in the draft is an edit that can still be saved', hasEdits(draftOnly) && !isArchived(draftOnly) && canSave(draftOnly));
}

// Deleted elsewhere.
{
  const dirty = step(run(refresh(v1), edit('title', 'Fictional title A')), { type: 'gone' });
  check('deleted elsewhere while editing: the draft is kept and still unsaved', hasEdits(dirty) && title(dirty) === 'Fictional title A' && dirty.gone);
  check('deleted elsewhere: cannot be saved or edited', !canSave(dirty) && step(dirty, edit('title', 'x')) === dirty);
  const back = step(dirty, refresh(v1));
  check('the task back again: saving is possible and the edits are kept', !back.gone && canSave(back) && title(back) === 'Fictional title A');
}

// Deleted from the panel itself.
{
  const deleted = step(run(refresh(v1), edit('title', 'Fictional title A')), { type: 'deleted' });
  check('deleting the task drops its draft: nothing unsaved is left', !hasEdits(deleted) && !canSave(deleted));
  check('after deleting, a 404 or a refresh changes nothing', step(deleted, { type: 'gone' }) === deleted && step(deleted, refresh(v2)) === deleted);
}

// Load latest after a conflict.
{
  const conflicted = step(run(refresh(v1), edit('title', 'Fictional title A')), refresh(v2));
  const reset = step(conflicted, { type: 'reset', task: v2 });
  check('loading the latest version drops the draft', reset.draft === v2 && reset.baseline === v2 && !hasEdits(reset));
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll task draft checks passed.');
