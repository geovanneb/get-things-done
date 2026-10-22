# GitHub Copilot Instructions — {{organization}} Executive Workspace

This workspace is managed by Get Things Done. When working in this directory:

## Workspace structure

- `profile/executive-profile.md` — executive identity, voice, and communication style. Read this for any writing task.
- `tasks/active/` — active tasks with `task.md` frontmatter and `deliverables/` folder.
- `stakeholders/people/` — STK-NNNN.md stakeholder profiles.
- `stakeholders/org-charts/` — ORG-NNNN.md reporting lines (`members` with `reports_to`) for one company or organization.
- `context/` — company, strategy, risks, decisions, and glossary notes.
- `outputs/templates/` — output format templates.

## Rules

- Never set task status to `done`. Set it to `in_review` when work is complete.
- When the user gives feedback on a task that is already `in_review`, set the status back
  to `in_progress` as your first action, before editing anything. Return it to `in_review`
  once the fix is saved. Every correction counts, however small.
- Save deliverables to `tasks/active/<TASK-ID>/deliverables/`.
- Read the executive profile before writing anything — adapt voice and tone to match.
- Adapt tone and detail to each stakeholder's profile.
- Read the org charts that include the task's stakeholders. Use their organization, manager, peers
  and direct reports to decide who approves, what level to pitch at, and who to keep informed.
  A member's optional `title` is their title in that chart and overrides their stakeholder `role` there.
  Optional `units` (departments, teams) are membership only; reporting still comes from `reports_to`.
  A `ref` starting with `P-` is a placeholder (not a stakeholder yet, or a vacant role); treat it as unconfirmed.
- Always read every file @-mentioned in the task's Objective (Markdown links whose text starts with `@`; paths start at the
  workspace root; a mentioned task no longer in `tasks/active/` is in `tasks/archive/`). Mentions add to the normal context
  scan, they never replace it.
- Never fabricate data. Use placeholders: `[PLACEHOLDER: description - by: date]`.
- The output template decides which sections exist; these rules decide how each one is written. Never
  add a top-level section the template does not define. If one seems missing, say so and let the user
  decide. When the task folder holds a source draft, its section list is the intended shape.
- When you write an executive summary, keep it to 5 bullets maximum, each under 20 words. Do not add one
  the output template does not ask for.
- Verify proper nouns before saving. Resolve every person name against `stakeholders/people/*.md`
  and every system, product, or program name against `context/glossary/`. A source draft in the
  task folder is an input to check, not a source of truth to copy.
- Report any name that does not resolve, and any near miss ("Jon Smyth" against a stakeholder
  file saying "John Smith"), rather than silently correcting it or passing it through.
