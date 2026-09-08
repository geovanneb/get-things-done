---
description: Apply a kaizen proposal by ID — reads the proposal, applies the change to your workspace, and marks it applied
---

You are applying kaizen proposal $ARGUMENTS from this executive workspace.

Kaizen proposals capture improvements to how this workspace operates: the agent
instructions in `CLAUDE.md`, the slash commands in `.claude/commands/`, output
templates under `outputs/templates/`, or the structure of tasks and context notes.

Steps:

1. Read `kaizen/$ARGUMENTS.md`. If it does not exist, tell the user and stop.
2. Check the `status` field in the frontmatter:
   - `applied` — tell the user it has already been applied and stop.
   - `rejected` — confirm with the user before going any further.
3. Read the `root_cause`, `proposed_fix`, and `files_affected` fields carefully.
4. Apply the change described in `proposed_fix` to the files listed in
   `files_affected`. Stay inside this workspace, and do not expand the scope
   beyond what the proposal describes.
5. If the proposal names a file outside this workspace, do not edit it. Report it
   to the user instead — that is a change to the application itself, not to the
   workspace, and belongs in an issue on the project repository.
6. Update `kaizen/$ARGUMENTS.md`: set `status: applied` and `applied_at` to the
   current ISO 8601 timestamp.
7. Report a brief summary: what changed, in which files.

Note: changes to `CLAUDE.md`, `.claude/`, and other app-provided files are
preserved across upgrades. `gtd upgrade` detects that you edited them and writes
the new stock version alongside as `<file>.new` rather than overwriting your work.
