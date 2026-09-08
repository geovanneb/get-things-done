# Executive Workspace - Claude Code Instructions

You are working in an executive workspace managed by Get Things Done. This workspace contains tasks, stakeholders, context notes, output templates, and the executive's personal profile. Your job is to help produce high-quality, audience-aware executive deliverables.

## Workspace structure

```
profile/                  Executive profile (read this first on every task)
stakeholders/people/      STK-NNNN.md files for each stakeholder
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
.schemas/                 JSON Schemas for all file types
```

## Before starting any task

Read files in this order:

1. **task.md** for the task you are working on (read the complete file, including all frontmatter fields)
2. **All stakeholder files** listed in the task's `stakeholders` field — these are the **intended audience** for the output you will produce. Read each file at `stakeholders/people/<ref>.md`. Understand who they are, their influence level, what matters to them, and how they communicate. Every output must be calibrated to this audience.
3. **Context library** — do not limit yourself to the task's `contexts` field. Proactively scan `context/` across all categories (company, organization, strategy, programs, decisions, risks, glossary, situation) and select any notes that are relevant to the task subject, title, and objective. Use the task's `contexts` field as a starting point if present, but always supplement it by searching the full library. The goal is to bring in everything that informs the work, not just what was explicitly listed.
4. **The executive profile** at `profile/executive-profile.md` — this defines the voice, communication style, and decision-making approach that all outputs must reflect.
5. **Output templates** for each deliverable listed in the task's `deliverables` field — find them at `outputs/templates/<template-slug>/output.md`. The template defines the expected format, required sections, and style guide for the output.

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
  - Add `file_path` pointing to the created file
  - Write the updated task.md back, preserving all other frontmatter exactly
- Log your execution to: `tasks/active/<TASK-ID>/executions/<timestamp>.md`
  - Include: what you created, key decisions made, sources used, caveats, any placeholders inserted

## Task status workflow

Follow this status progression strictly:

1. **backlog** — default when a task is created (do not change unless you are asked to work on it)
2. **in_progress** — set this as the very first action when you start working on a task
3. **in_review** — set this when your work is complete and the deliverable is saved; this signals the user to review

You must **never** set the status to `done`. Only the user moves tasks to Done manually after reviewing the output. There is no "Approved" step — the user goes directly from `in_review` to `done` on their own.

## Fields you must never modify in task.md

- `id`
- `created_at`
- `schema_version`

These are set at task creation and must not change.

## Output quality standards

- Follow the output template's `required_sections` list exactly - every section must be present
- Apply the `style_guide` rules from the output template
- Adapt tone and detail level to match each stakeholder's influence level and communication preferences
- Apply the executive's communication style from their profile
- Lead every document with the key insight or decision - never with background
- Always include a "Next steps" or "Decisions required" section
- Executive summaries: 5 bullets maximum, each under 20 words
- All financial claims must reference a source context note or be explicitly flagged as estimates
- Never fabricate figures. Use placeholders like: `[Q3 Revenue: INSERT FROM FINANCE - due 2026-09-05]`
- When a deliverable reports on or summarizes other tasks' deliverables, always resolve each deliverable's `template_ref` to the output template's `name` field (from `outputs/templates/<slug>/output.md`) for any "output type" or "template" display column. Never substitute the raw file format or file extension for the template name.

## Handling missing information

If required context or data is unavailable, create the deliverable with clearly marked placeholder sections. Do not block on missing data. A complete structure with marked gaps is more useful than a partial document.

Placeholder format: `[PLACEHOLDER: <description of what is needed> - responsible: <person/team> - by: <date>]`

## Confidentiality rules

- Never log sensitive content to the console or to execution logs
- Execution logs should reference what was created, not reproduce confidential content
- Check the task's `confidentiality` field before handling or outputting any information
- `confidential` and `restricted` tasks: do not include actual data in execution logs, only reference file paths

## Schema references

All frontmatter structures are documented in `.schemas/`. Refer to these when creating new files:

- Tasks: `.schemas/task.schema.json`
- Stakeholders: `.schemas/stakeholder.schema.json`
- Context notes: `.schemas/context.schema.json`
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
