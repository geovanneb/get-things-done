# {{organization}} Executive Workspace

This folder is your **Get Things Done** workspace. Everything in it is
yours: your tasks, stakeholders, context notes and deliverables. The application
itself lives elsewhere (installed via npm) and never stores your content.

## Running the dashboard

```bash
gtd start     # launch the web UI in the background
gtd open      # open it in your browser
gtd status    # check whether it is running, and on which port
gtd stop      # shut it down
```

## What lives where

```
profile/                Your executive profile — voice, style, preferences
stakeholders/people/    One file per person (STK-NNNN.md)
stakeholders/groups/    One file per group (GRP-NNNN.md)
stakeholders/org-charts/ Reporting lines, one file per company or organization (ORG-NNNN.md)
tasks/active/           One folder per task
  TASK-YYYY-NNNN/
    task.md             The task definition
    deliverables/       Finished output files
    executions/         Agent execution logs
    attachments/        Source material you attach
tasks/archive/          Completed tasks moved out of the way
context/                Background knowledge, by category
  company/ organization/ strategy/ programs/
  decisions/ risks/ glossary/ situation/
outputs/templates/      Output templates: required sections + style guides
context-updates/        Imported material (transcripts, slides...) and the
                        record of what it changed in the context
kaizen/                 Kaizen notes: why a task needed rework (each opens a context update)
routines/               Schedules that create recurring tasks (RT-NNNN.md)
workflows/              Reserved for multi-step workflow definitions
```

## Routines

Routines put recurring tasks on your backlog by themselves (Routines in the
dashboard). They are checked whenever the dashboard is running, and when it starts
again they catch up on runs missed while the computer was off. To run them without
the dashboard, call `gtd routines run` (for example from your system scheduler).
Schedules use the server machine's local time. Run the scheduler on only one machine
if you synchronize the workspace: file sync does not coordinate simultaneous runs.
The "all" catch-up policy creates at most the latest 12 missed tasks per check.
Keep `.situation-board/routines/state.json`: it records check times and reserves deleted
routine IDs so their existing tasks stay associated with the original routine.
Keep `.situation-board/routines/receipts.jsonl` too: it records every task a routine
created, so a task you delete is not created again.

A task title can use `{{date}}` (the scheduled run date) and `{{due_date}}`, both written
as YYYY-MM-DD. The due date counts from the scheduled run, even when the run is caught up
later. The objective is copied into each task as written, @-mentions included. To skip a
long absence, set "Pause until" on the routine: runs before that day are not created.

## App-provided vs. yours

Some files are provided by the application and refreshed when you upgrade:

- `CLAUDE.md`, `.claude/` (agents, skills, commands, settings)
- `.schemas/`, `.gitignore`, this `README.md`

Everything else is yours and is never touched.

If you edit an app-provided file, your version is kept. On `gtd upgrade` the new
stock version is written beside it as `<file>.new` so you can merge by hand. The
record of what the app installed lives in `.situation-board/app-manifest.json`.

## Version control

This workspace is a plain folder of Markdown files, so it works well with git:

```bash
git init && git add . && git commit -m "Initial workspace"
```

A `.gitignore` is already in place for caches, logs and the trash folder.

Bear in mind that stakeholder notes and deliverables are often confidential — use
a private repository.
