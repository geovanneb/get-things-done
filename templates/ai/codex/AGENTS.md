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
stakeholders/org-charts/  ORG-NNNN.md reporting lines for one company or organization
context/                  Context notes (company, strategy, risks, etc.)
outputs/templates/        Output format templates
.schemas/                 JSON schema references
```

## Task workflow

1. When starting a task: set `status: in_progress` in task.md
2. When done: set `status: in_review` (NEVER `done` — the user reviews and closes manually)
3. On rework: if the user gives feedback on a task that is already `in_review`, set
   `status: in_progress` again as your very first action, before editing anything.
   Set it back to `in_review` when the fix is saved. This applies to every correction,
   however small.
4. Save deliverables to `tasks/active/<TASK-ID>/deliverables/`
5. Log execution to `tasks/active/<TASK-ID>/executions/<timestamp>.md`
6. The first time you set `in_progress`, also set `start_date` to the current UTC
   timestamp if it is missing. Leave it untouched afterwards — it marks when work
   first began. Never write `done_date`; the app sets that when the user moves the
   task to Done. Insights measures turnaround from these two fields.

## Quality standards

- Read all stakeholder files listed in the task before producing output.
- Also read every org chart in `stakeholders/org-charts/` that lists one of those stakeholders.
  `reports_to` is the manager's stakeholder id; no `reports_to` means top of the chart. Use each
  stakeholder's organization, manager, peers and direct reports to decide who approves, what level
  to pitch at, the escalation path, and who should be kept informed. The chart is the source of
  truth for reporting lines; flag any conflict with a stakeholder's title. A member's optional
  `title` is their title in that chart; it overrides the stakeholder file's `role` there only.
  Optional `units` group people into departments or teams (`unit` on a member, `parent` for
  nesting, `head` for who leads it). A unit is membership only: its head is not everyone's
  manager, and approval authority still comes from `reports_to`.
- Always read every file @-mentioned in the task's Objective (Markdown links whose text starts with `@`; paths start at
  the workspace root; a mentioned task no longer in `tasks/active/` is in `tasks/archive/`). Mentions add to the normal
  context scan, they never replace it.
- Adapt tone, depth, and framing to the stakeholder audience.
- Never fabricate numbers. Placeholder format: `[PLACEHOLDER: what is needed - by: date]`
- The output template decides which sections exist; these standards decide how each one is written.
  Never add a top-level section the template does not define. If one seems missing, say so and let the
  user decide.
- When the task folder contains a source draft, its section list is the intended shape. Reorganize
  within it as the task asks, but do not add top-level sections to it.
- When you write an executive summary, keep it to 5 bullets maximum, each under 20 words. Do not add
  one the output template does not ask for.
- Unless the output template specifies the opening, lead every document with the key insight or decision.
- Verify proper nouns before saving. A source draft in a task folder is an input to check,
  not a source of truth to copy. Resolve every person name against `stakeholders/people/*.md`
  and every system, product, or program name against `context/glossary/` and the context
  library. Report anything that does not resolve, and report near misses too (a draft saying
  "Jon Smyth" where the stakeholder file says "John Smith"). Never silently correct a name
  and never silently pass an unknown one through.
