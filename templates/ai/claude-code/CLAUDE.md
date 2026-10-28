# Executive Workspace - Claude Code Instructions

You are working in an executive workspace managed by Get Things Done. This workspace contains tasks, stakeholders, context notes, output templates, and the executive's personal profile. Your job is to help produce high-quality, audience-aware executive deliverables.

## Workspace structure

```
profile/                  Executive profile (read this first on every task)
stakeholders/people/      STK-NNNN.md files for each stakeholder
stakeholders/groups/      GRP-NNNN.md files for stakeholder groups
stakeholders/org-charts/  ORG-NNNN.md reporting lines for one company or organization
tasks/active/             One directory per active task
  TASK-YYYY-NNNN/
    task.md               Task definition (frontmatter + body)
    deliverables/         Output files you create go here
    executions/           Log your execution here after completing work
context/                  Context notes — each note in its own subfolder
  company/<slug>/note.md
  strategy/<slug>/note.md
  organization/<slug>/note.md
  programs/<slug>/note.md
  decisions/<slug>/note.md
  risks/<slug>/note.md
outputs/templates/        Output templates (required sections + style guides)
context-updates/          Raw material waiting to be distilled into context (not context itself)
  CU-YYYY-NNNN/
    update.md             Status, proposals and the executive's decisions
    materials/            Uploaded files (deleted when the update is done, unless kept)
    proposals/P-NN.md     Proposed content of one context or stakeholder file
routines/                 RT-NNNN.md schedules that create recurring tasks
.schemas/                 JSON Schemas for all file types
```

`context-updates/` holds unreviewed raw material. Never use it as a source for a task:
only `context/` and `stakeholders/` are the reviewed truth.

Tasks with `routine_ref` were created by a routine (`routines/RT-NNNN.md`, a schedule plus a task
template). Work on them like any other task, and never change `routine_ref` or `routine_occurrence`:
they stop the routine creating the same task twice. Create or edit a routine only when the user asks,
following `.schemas/routine.schema.json`; the dashboard picks up the change on its next check.
In a routine's task title, `{{date}}` is the scheduled run date and `{{due_date}}` the due date
(both YYYY-MM-DD); the routine body is copied into each task as written.

## Before starting any task

Read files in this order:

1. **task.md** for the task you are working on (read the complete file, including all frontmatter fields)
2. **All stakeholder files** listed in the task's `stakeholders` field — these are the **intended audience** for the output you will produce. Read each file at `stakeholders/people/<ref>.md`. Understand who they are, their influence level, what matters to them, and how they communicate. Every output must be calibrated to this audience.
   - **Org charts** at `stakeholders/org-charts/` — read every chart whose `members` include a task stakeholder. `reports_to` holds the manager's stakeholder id; no `reports_to` means top of the chart. Use each stakeholder's organization, manager, peers and direct reports to decide who really approves, what level to pitch at, the right escalation path, and who else should be kept informed. Treat the chart as the source of truth for reporting lines and flag any conflict with a stakeholder's title. A member's optional `title` is their title in that chart; it overrides the stakeholder file's `role` for that organization only. Optional `units` group people into departments or teams (`unit` on a member, `parent` for nesting, `head` for who leads it). A unit is membership only: its head is not everyone's manager, and approval authority still comes from `reports_to`. A member whose `ref` starts with `P-` is a placeholder (someone who is not a stakeholder yet, or a vacant role) described by its `name`: treat it as unconfirmed and never present it as a named person.
3. **Context library** — do not limit yourself to the task's `contexts` field. Proactively scan `context/` across all categories (company, organization, strategy, programs, decisions, risks, glossary, situation) and select any notes that are relevant to the task subject, title, and objective. Use the task's `contexts` field as a starting point if present, but always supplement it by searching the full library. The goal is to bring in everything that informs the work, not just what was explicitly listed.
4. **The executive profile** at `profile/executive-profile.md` — this defines the voice, communication style, and decision-making approach that all outputs must reflect.
5. **Output templates** for each deliverable listed in the task's `deliverables` field — find them at `outputs/templates/<template-slug>/output.md`. The template defines the expected format, required sections, and style guide for the output.

**@-mentions in the Objective** — links whose text starts with `@`, for example `[@Jane Doe](/stakeholders/people/stk-0001.md)`, are files the executive explicitly pointed at. Always read every mentioned file, on top of the reads above: a mention adds to the normal context scan, it never replaces or narrows it. Paths start at the workspace root. A mentioned task that is no longer under `tasks/active/` is in `tasks/archive/<TASK-ID>/`. For an output template, read its `output.md` (not the binary template file) unless the task says otherwise.

Do not skip any of these reads. The quality of your output depends on understanding the full picture before writing anything.

## The core production model

Every task follows this model:

- **Task body** = what needs to be done and why
- **Contexts** = the facts, background, and situational knowledge to draw from
- **Stakeholders** = the audience — adapt tone, depth, and framing to them
- **Deliverables** = the expected output format, defined by the linked output template

Produce outputs that are grounded in the contexts, written in the executive's voice, and calibrated to what the stakeholder audience needs to understand, decide, or act on.

## Output file management

- Save all deliverables to: `tasks/active/<TASK-ID>/deliverables/<DEL-ID>.<format>`
  - Example: `tasks/active/TASK-2026-0001/deliverables/DEL-01.pptx`
- After completing each deliverable, update the task's deliverable status:
  - Read task.md
  - Change the deliverable's `status` from `"pending"` to `"complete"`
  - Update the `updated_at` field to the current ISO 8601 timestamp
  - Add `file_path` as the workspace-relative path of the created file, e.g. `tasks/active/TASK-2026-0001/deliverables/DEL-01.pptx` (never relative to the task folder: the dashboard opens it from the workspace root)
  - Write the updated task.md back, preserving all other frontmatter exactly
- Log your execution to: `tasks/active/<TASK-ID>/executions/<timestamp>.md`
  - Include: what you created, key decisions made, sources used, caveats, any placeholders inserted

## Task status workflow

Follow this status progression strictly:

1. **backlog** — default when a task is created (do not change unless you are asked to work on it)
2. **in_progress** — set this as the very first action when you start working on a task
3. **in_review** — set this when your work is complete and the deliverable is saved; this signals the user to review

You must **never** set the status to `done`. Only the user moves tasks to Done manually after reviewing the output. There is no "Approved" step — the user goes directly from `in_review` to `done` on their own.

### Rework: always move back to in_progress first

The status must always reflect what is actually happening right now. A task you are
editing is not waiting for review, it is in progress.

Whenever you resume work on a task that is **not** already `in_progress`, your first
action is to set the status back to `in_progress` and update `updated_at`. Do this
before reading files, before editing the deliverable, and before replying to the user.

Any request to change a deliverable triggers this: feedback on the output, a fix, a
correction, a different tone, one more section, a reformat. It applies to every entry
point, not just `/gtd-task`. Feedback given in plain conversation (for example "this
section is too long" or "redo the summary in Japanese") counts as resuming work and
triggers the same rule.

Do not skip this because the change looks small. A one line edit is still rework.

When the rework is finished and saved, set the status back to `in_review`, exactly as
you would for a first pass.

### Timestamps: set start_date on the first run

The first time you move a task to `in_progress`, also set `start_date` to the current
UTC timestamp if the field is not already present. Leave it alone on every later run —
it marks when work first began, not when it last resumed.

You never set `done_date`. The app writes that itself when the user moves the task to
Done, and overwriting it would misreport when the work actually finished.

These two fields are what the Insights screen measures turnaround from. Without
`start_date` it has to guess from the execution logs.

## Fields you must never modify in task.md

- `id`
- `created_at`
- `done_date` (the app sets this when the user moves the task to Done)
- `schema_version`

These are set at task creation and must not change.

## Output quality standards

**The output template decides which sections exist. The standards below decide how each one is written.**

- Follow the output template's `required_sections` list exactly - every section must be present
- Apply the `style_guide` rules from the output template
- When the output template's `required_sections` or `style_guide` specifies the document structure, that structure is authoritative. The rules below govern how a section is written, never which sections exist.
- Do not add a top-level section the template does not define. This covers executive summaries, decision roll-ups, appendices, and anything else that looks helpful. If a section seems missing, say so in your reply and let the executive decide.
- When the task folder contains a source draft, its section list is the intended shape of the deliverable. Reorganize within it as the task asks, but do not add top-level sections to it.
- Adapt tone and detail level to match each stakeholder's influence level and communication preferences
- Apply the executive's communication style from their profile
- Unless the template already specifies the opening, lead every document with the key insight or decision - never with background
- Unless the template already defines the closing sections, include a "Next steps" or "Decisions required" section
- When you write an executive summary, keep it to 5 bullets maximum, each under 20 words. Do not add one the template does not ask for
- All financial claims must reference a source context note or be explicitly flagged as estimates
- Never fabricate figures. Use placeholders like: `[Q3 Revenue: INSERT FROM FINANCE - due 2026-09-05]`
- When a deliverable reports on or summarizes other tasks' deliverables, always resolve each deliverable's `template_ref` to the output template's `name` field (from `outputs/templates/<slug>/output.md`) for any "output type" or "template" display column. Never substitute the raw file format or file extension for the template name.
- When an output template folder ships a binary template document (`.pptx`, `.potx`, `.docx`, `.dotx`, `.xlsx`), the deliverable must be produced by editing a copy of that document. A from-scratch file that merely reuses the template's colors is not acceptable.

## Verifying names and terminology

A source draft in a task folder is an input to verify, not a source of truth to transcribe. Before saving a deliverable, check the proper nouns in it.

1. Extract every person name and every system, product, or program name that appears in the deliverable content.
2. Resolve each person name against `stakeholders/people/*.md` (the `name` field). Resolve each system, product, or program name against `context/glossary/` and the rest of the context library.
3. Report every proper noun that does not resolve. List them in your reply as names you could not verify, naming the file each came from. Never silently correct one and never silently pass one through.
4. Report near misses the same way. If a draft says "Jon Smyth" and the stakeholder file says "John Smith", say so and let the executive decide which is right. Either side could be the stale one, so do not auto-correct.

This costs one pass over content that already exists, and it is the only thing standing between a wrong name in a draft and a wrong name in front of a stakeholder.

## Handling missing information

If required context or data is unavailable, create the deliverable with clearly marked placeholder sections. Do not block on missing data. A complete structure with marked gaps is more useful than a partial document.

Placeholder format: `[PLACEHOLDER: <description of what is needed> - responsible: <person/team> - by: <date>]`

## Confidentiality rules

- Never log sensitive content to the console or to execution logs
- Execution logs should reference what was created, not reproduce confidential content
- Check the task's `confidentiality` field before handling or outputting any information
- `confidential` and `restricted` tasks: do not include actual data in execution logs, only reference file paths

## Context updates

The executive imports material (transcripts, slides, photos, spreadsheets) under
**Context > Updates** in the dashboard. Two commands turn it into reviewed changes:

- `/gtd-context-analyze <CU-ID>`: read the material and the whole context, and propose
  only the changes that matter. Writes proposals; never touches context files.
- `/gtd-context-apply <CU-ID>`: apply only the proposals the executive accepted, then
  delete the drafts and keep the record. The materials go too, unless the executive set
  `keep_materials: true` in the dashboard.

Follow the command files in `.claude/commands/` exactly. The rule behind both: never
change just to change. Distil the material into the few edits that keep the context true.

An update with `origin: system-cleanup` and `kind: memory-review` was opened by the
dashboard's weekly System cleanup job. It has no new material: `/gtd-context-analyze`
reviews the existing memory for duplicates, misplaced and obsolete notes. Proposals
may then also `remove` a file; the dashboard does that after approval, never you.

## Schema references

All frontmatter structures are documented in `.schemas/`. Refer to these when creating new files:

- Tasks: `.schemas/task.schema.json`
- Stakeholders: `.schemas/stakeholder.schema.json`
- Org charts: `.schemas/org-chart.schema.json`
- Context notes: `.schemas/context.schema.json`
- Context updates: `.schemas/context-update.schema.json`
- Output templates: `.schemas/output-template.schema.json`
- Executive profile: `.schemas/profile.schema.json`
- Execution manifests: `.schemas/execution-manifest.schema.json`

## Available agents

Use the `preferred_agent` field in the task frontmatter to route work to the right specialist:

- `executive-report-writer`: quarterly reports, presentations, memos, strategic documents — primary production agent for finished deliverables
- `stakeholder-advisor`: stakeholder communication drafts, influence mapping, political considerations, sensitive situations
- `context-researcher`: market research, context note creation and updates, competitive intelligence — writes context only, not deliverables
- `meeting-prep`: meeting briefs, talking points, likely questions and red lines — use before any significant meeting

## Available skills

Load these when relevant to the task:

- `financial-analysis`: P&L summaries, variance analysis, financial narrative writing
- `presentations`: slide structure using the pyramid principle, chart selection, executive slide templates
- `stakeholder-communication`: communication frameworks, tone calibration by audience type, Japanese business conventions
- `decision-brief`: one-page decision brief structure, option framing, recommendation writing
- `risk-analysis`: risk identification, priority matrix, risk narrative for executive audiences, risk comparison across options
