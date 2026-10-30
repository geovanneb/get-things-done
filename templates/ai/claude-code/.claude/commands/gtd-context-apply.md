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

Skip proposals with `action: remove`: do not delete or edit their target, and do not
set their `outcome`. The dashboard moves those files to the trash once the update is
done, and only when no other accepted change failed.

1. Check the `target` is a workspace-relative path under `context/<category>/` or
   `stakeholders/people/`, `stakeholders/groups/` or `stakeholders/org-charts/`, ending
   in `.md`. For a Kaizen (`kind: kaizen`), `CLAUDE.md`, `AGENTS.md`,
   `.github/copilot-instructions.md` and `outputs/templates/<slug>/output.md` are
   allowed too. If not, do not write it: set
   `outcome: failed` with the reason.
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
   write, when the file has that field. Never change a note's `id` or `created_at`.
   `CLAUDE.md` and `AGENTS.md` steer every later run: write exactly the reviewed
   change there, nothing around it. An app update may have changed one of them since
   the analysis; then merge as above.
6. Set `outcome: applied` (or `merged`, `failed`) on the proposal in `update.md`, and
   `outcome_note` when there is something to say. Do this after each proposal, so a
   rerun can pick up where this one stopped.

Do not edit anything that was not accepted, and do not add improvements of your own.
Never change `meeting_records`: the executive confirmed them in the dashboard, and they
need no file.
If you notice something else that should change, mention it in your reply.

## Step 3: Close the update

When every accepted proposal other than a `remove` has an outcome:

1. In `update.md`, set `status: done`, `applied_at` to the current ISO 8601 timestamp
   and `updated_at`. Give each rejected proposal `outcome: skipped`. Keep everything
   else: the summary, the `materials` list and the proposals are the record of what
   happened.
2. Delete `context-updates/$ARGUMENTS/proposals/`. Delete
   `context-updates/$ARGUMENTS/materials/` too, unless `update.md` has
   `keep_materials: true`: then the executive chose to keep the original files, so
   leave that folder alone. The record stays; the drafts (and usually the raw
   material) go, so the workspace does not grow over time. Delete nothing else, and
   never change `keep_materials`. If you are not allowed to delete folders, leave
   them: the dashboard removes them the next time it opens a finished update.
3. Read `update.md` back and confirm the frontmatter parses.

## Step 4: Report

List each file you changed or created, with its outcome, plus anything that failed or
was merged. Keep it short.
