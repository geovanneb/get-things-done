---
description: Apply one or more kaizen proposals by ID — reads each proposal, applies the change to your workspace, and marks it applied
---

You are applying kaizen proposal(s) $ARGUMENTS from this executive workspace.

`$ARGUMENTS` holds one or more proposal IDs separated by spaces (the dashboard's
"Apply all" button copies every open ID at once). Handle them one at a time, in
the order given, and finish one before starting the next.

Kaizen proposals capture improvements to how this workspace operates: the agent
instructions in `CLAUDE.md`, the slash commands in `.claude/commands/`, output
templates under `outputs/templates/`, or the structure of tasks and context notes.

For each ID:

1. Read `kaizen/<ID>.md`. If it does not exist, tell the user and move on to the next ID.
2. Check the `status` field in the frontmatter:
   - `applied` — tell the user it has already been applied and move on.
   - `rejected` — confirm with the user before going any further.
3. Read the `root_cause`, `proposed_fix`, and `files_affected` fields carefully.
4. Apply the change described in `proposed_fix` to the files listed in
   `files_affected`. Stay inside this workspace, and do not expand the scope
   beyond what the proposal describes.
5. If two proposals change the same file in conflicting ways, apply the first,
   then stop and ask the user how to handle the second instead of guessing.
6. If the proposal names a file outside this workspace, do not edit it. Report it
   to the user instead — that is a change to the application itself, not to the
   workspace, and belongs in an issue on the project repository.
7. Update `kaizen/<ID>.md`: set `status: applied` and `applied_at` to the
   current ISO 8601 timestamp.

When every ID is handled, report a brief summary per proposal: what changed, in
which files, and any ID you skipped and why.

Note: changes to `CLAUDE.md`, `.claude/`, and other app-provided files are
preserved across upgrades. `gtd upgrade` detects that you edited them and writes
the new stock version alongside as `<file>.new` rather than overwriting your work.
