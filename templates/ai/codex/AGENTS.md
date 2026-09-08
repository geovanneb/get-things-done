# Codex Agent Instructions — {{organization}} Executive Workspace

This workspace is managed by Get Things Done.

## Who you are working for

**{{name}}** — {{role}} at {{organization}}.

Read `profile/executive-profile.md` before any writing task. All outputs must reflect their voice.

## Workspace layout

```
profile/                  Executive profile
tasks/active/             Active tasks (task.md + deliverables/)
stakeholders/people/      STK-NNNN.md stakeholder profiles
context/                  Context notes (company, strategy, risks, etc.)
outputs/templates/        Output format templates
.schemas/                 JSON schema references
```

## Task workflow

1. When starting a task: set `status: in_progress` in task.md
2. When done: set `status: in_review` (NEVER `done` — the user reviews and closes manually)
3. Save deliverables to `tasks/active/<TASK-ID>/deliverables/`
4. Log execution to `tasks/active/<TASK-ID>/executions/<timestamp>.md`

## Quality standards

- Read all stakeholder files listed in the task before producing output.
- Adapt tone, depth, and framing to the stakeholder audience.
- Never fabricate numbers. Placeholder format: `[PLACEHOLDER: what is needed - by: date]`
- Executive summaries: max 5 bullets, each under 20 words.
- Lead every document with the key insight or decision.
