# System cleanup: design notes

The built-in System cleanup routine reviews the memory (context notes and stakeholders)
and, only where the user opts in, removes old finished items. This note records why it
is built the way it is, what it could collide with, and what risk remains.

## Behaviour in one table

| Part | Default | What it does |
| --- | --- | --- |
| Schedule | Every Monday 09:00 | Same triggers and lock as routines. Missed weeks become one run, not several. |
| Memory review | On | Opens a context update tagged `origin: system-cleanup`, `kind: memory-review`, with a mechanical scan as its material. The agent proposes; the user approves. |
| Finished tasks | Off (30 days, archive) | Archive, trash or delete done tasks still on the board. |
| Archived tasks | Off (365 days, trash) | Trash or delete. |
| Finished context updates | Off (90 days, trash) | Only `done`; kept materials and pending removals are skipped. |
| Closed kaizen | Off (90 days, trash) | Only `applied` with `applied_at`, or `rejected` with `rejected_at`. Legacy records without a closing date stay untouched. |
| Trash | Off (30 days) | Permanently deletes entries the app named, by the time in the name. |

## UX decisions and where they come from

- **Suggest by default, act only on opt-in.** Products that remove data automatically
  (Slack retention, Google Vault) present it as an explicit policy with warnings that
  deletion is permanent. Note tools that handle stale notes well (Obsidian's triage
  plugins) build a review queue rather than deleting. So: memory changes always go
  through review, and file rules start off.
- **Recoverable over confirmable.** NN/g recommends undo over confirmation dialogs for
  reversible actions, and reserving specific confirmations for serious, irreversible
  ones. "Move to trash" is the default action; only a newly enabled "Delete permanently"
  asks, naming the type and the current count.
- **Per-item clocks.** Like the macOS "remove items from the Trash after 30 days"
  setting, each item ages from its own date (done date, archive time, applied date,
  time in the name), not from when the rule was switched on.
- **Show before doing.** The settings dialog has a dry-run preview of the draft
  settings, so the user sees exactly which items a run would touch.
- **One home for the settings.** The controls live with the routine that enforces
  them (Routines page). Settings has a short "Cleanup and retention" summary linking
  there, for people who look for retention under Settings. Advanced options (keep tag,
  per-run cap) sit behind a disclosure.
- **Where it came from.** Every update the job opens carries `origin: system-cleanup`
  and shows a **System cleanup** badge in the list and the detail page. Only the server
  sets it; a request body cannot.

## Collisions found in the current code, and how they are handled

| Area | Risk | Handling |
| --- | --- | --- |
| Task and update ids | Ids are "highest folder + 1". Removing the newest archived task would hand its id to the next task; mentions, routine receipts and run history would then point at the wrong one. | Ids are reserved in `.situation-board/reserved-ids.json` before removal. `generateTaskId` and the update `nextId` read it. Regression test included. |
| Routine receipts | Removing a routine-created task could make the routine create it again. | Not an issue: receipts outlive tasks. Verified, no change needed. |
| Insights | Insights counts archived tasks; removing them changes history. | Rules are opt-in, the archived-task default is 365 days, and the UI says Insights stop counting removed tasks. |
| Mentions | Links to a removed note or task break. | The analyze command must name inbound links in a removal's rationale; the UI warns that links stop working. |
| Agent permissions | Agents may not delete (`rm -rf` denied, Edit-only writes). | `remove` proposals are carried out by the dashboard, never by the apply command. |
| Merges | Update A (merge) fails, remove B succeeds: B's facts are lost. | Removals are held back unless every other accepted create/update was confirmed as applied or merged. |
| Context update flow | A removal-only approval would wait for an apply command with nothing to do. | Approving removals only finishes the update directly. |
| Concurrency | CLI and server could both run cleanup; settings could change mid-run. | Same lock as routines; settings writes take the lock too. Items are re-checked just before acting (a task reopened since the plan is skipped). |
| Watcher | Moving hundreds of files into the trash would flood SSE refreshes. | The watcher ignores `.situation-board/trash/`. |
| Git | The trash was not in the workspace `.gitignore`, though the README said so. | Added. |
| Bad dates and clocks | Missing, unparseable or future dates could make fresh items look old. | Such items are never cleaned. |
| Symlinks | A symlinked task folder could lead outside the workspace. | Symlinks are skipped, never followed or removed. |
| Settings file | A hand edit that does not validate could silently fall back to defaults. | The job refuses to run and the Routines page shows the error. |
| Mass deletion | A misconfiguration could remove a lot at once. | At most 200 items per run (configurable up to 1000). |

## Remaining risks

- **Kaizen ids** are chosen by agents from the files in `kaizen/`. Removing the newest
  closed proposal can let an agent reuse its id. Low impact (nothing links to kaizen ids
  by machine), not handled.
- **Synced workspaces:** like routines, run the scheduler on one machine. The lock is
  local.
- **Restoring from the trash** is manual (move the entry back and drop the timestamp
  prefix). There is no restore screen yet.
- **Deleting a task from the board** is still a hard delete (`fsp.rm`), unlike other
  dashboard deletes. Outside this change, worth its own fix.
- The memory scan is mechanical (titles, names, shared three-word phrases). Semantic
  duplicates and misplaced facts are left to the agent's analysis.
