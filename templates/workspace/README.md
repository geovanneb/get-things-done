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
kaizen/                 Improvement proposals for this workspace
workflows/              Reserved for multi-step workflow definitions
```

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
