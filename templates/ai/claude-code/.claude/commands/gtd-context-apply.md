---
description: Apply the approved proposals of a context update by ID (e.g. /gtd-context-apply CU-2026-0001)
---

You are applying context update **$ARGUMENTS**. The executive reviewed the proposals
in the dashboard and approved some of them. Apply exactly those, nothing more.

## Step 1: Check the update

Read `context-updates/$ARGUMENTS/update.md`. If it does not exist, tell the user and stop.

- `approved`: continue.
- `applying`: an earlier run stopped half way. Continue, and skip proposals whose
  `outcome` is already set.
- `in_review`: the executive has not approved yet. Tell them to review it under
  **Context > Updates** and stop.
- `ready` or `analyzing`: it has not been analyzed. Point them to
  `/gtd-context-analyze $ARGUMENTS` and stop.
- `done`: already applied. Stop.

Set `status: applying` and `updated_at` to the current ISO 8601 timestamp.

## Step 2: Apply each accepted proposal

For every proposal with `decision: accepted`, in order. Ignore every other proposal.

1. Check the `target` is a workspace-relative path under `context/<category>/` or
   `stakeholders/people/`, `stakeholders/groups/` or `stakeholders/org-charts/`, ending
   in `.md`. If not, do not write it: set `outcome: failed` with the reason.
2. Read the proposed content in `context-updates/$ARGUMENTS/proposals/<id>.md`.
3. Decide how to write it:
   - **Unchanged target** (an `update` whose file was not modified after `analyzed_at`,
     or a `create` whose file still does not exist): write the proposed content as it
     is. This is what the executive reviewed.
   - **The target changed after the analysis** (someone edited it, or a `create` target
     now exists): do not overwrite the newer content. Apply the proposal's change on top
     of the current file, keeping the newer edits, and set `outcome: merged` with one
     line on what you kept.
   - **`reviewer_note` is set**: adjust the proposed content as the note asks, and
     only that. Mention it in `outcome_note`.
4. For a new stakeholder, group or org chart, check that its id and file name are still
   free. If another file took the number, use the next free one and update any reference
   to it in the other accepted proposals.
5. Keep frontmatter valid against `.schemas/`. Set `updated_at` on every file you
   write. Never change a note's `id` or `created_at`.
6. Set `outcome: applied` (or `merged`, `failed`) on the proposal in `update.md`, and
   `outcome_note` when there is something to say. Do this after each proposal, so a
   rerun can pick up where this one stopped.

Do not edit anything that was not accepted, and do not add improvements of your own.
If you notice something else that should change, mention it in your reply.

## Step 3: Close the update

When every accepted proposal has an outcome:

1. In `update.md`, set `status: done`, `applied_at` to the current ISO 8601 timestamp
   and `updated_at`. Give each rejected proposal `outcome: skipped`. Keep everything
   else: the summary, the `materials` list and the proposals are the record of what
   happened.
2. Delete `context-updates/$ARGUMENTS/materials/` and
   `context-updates/$ARGUMENTS/proposals/`. The record stays; the raw material and
   drafts go, so the workspace does not grow over time. Delete nothing else. If you
   are not allowed to delete folders, leave them: the dashboard removes them the next
   time it opens a finished update.
3. Read `update.md` back and confirm the frontmatter parses.

## Step 4: Report

List each file you changed or created, with its outcome, plus anything that failed or
was merged. Keep it short.
