---
description: Execute a task by ID (e.g. /gtd-task TASK-2026-0001)
---

You are executing task **$ARGUMENTS** on behalf of the executive. Before writing a single word of output, you must load the full context below. The quality of your work depends entirely on doing this step completely.

## Step 1 — Claim the task

Update `tasks/active/$ARGUMENTS/task.md` before doing anything else. The board reads
these fields to show a live progress indicator on the task card, so this is what tells
the executive that work has started and who is doing it.

- Change `status` to `in_progress`
- Set `preferred_agent` to the agent doing the work, using the routing list in
  CLAUDE.md (for example `executive-report-writer`). If the task already has a
  `preferred_agent`, keep that value and use that agent. If no specialist fits, leave
  the field out — the board then shows a generic working indicator.
- Update `updated_at` to the current ISO 8601 timestamp

This applies on every run, including a rerun. If the task is already `in_review`
because you finished it earlier and the executive has come back with feedback, set it
to `in_progress` again here. The status has to show that the task is being worked on
again, not that it is sitting in the review queue.

## Step 2 — Load the executive profile

Read `profile/executive-profile.md` in full. This is the foundation of everything you produce:

- **Voice and tone**: Write in the executive's voice, using their communication style — not generic AI prose.
- **Language preferences**: Apply the language rules (e.g. English vs Japanese, formality level) appropriate to the output and audience.
- **Decision-making style**: Structure your reasoning the way the executive thinks — evidence first, options framed, recommendation clear.
- **Recurring expectations**: Apply format rules (e.g. one-page summaries, YoY comparisons, "So what?" conclusions) to every deliverable.
- **Principles**: Let these guide judgment calls — clarity over comprehensiveness, lead with the ask, no surprises.

## Step 3 — Load the task

Read `tasks/active/$ARGUMENTS/task.md` completely, including all frontmatter fields. Note the objective, deliverables, stakeholders, preferred agent, and any files in the task folder.

### Explicit mentions

The executive can point at specific files by writing `@` mentions in the task body. They appear as Markdown links whose text starts with `@`, for example `[@Jane Doe](stakeholders/people/jane-doe.md)` or `[@FY26 Strategy](context/strategy/fy26/note.md)`. The link target is a path relative to the workspace root.

- Read every mentioned file in full. A mention is the executive saying "this one matters", so give it extra weight and make sure the deliverable reflects it.
- Mentions can point at stakeholders, context notes, output templates or other tasks (any status, including `tasks/archive/`).
- Mentions are **additive**. They never replace Steps 4 to 6: still load every stakeholder in the `stakeholders` field, still scan the full context library, still load the output templates. A task with no mentions is handled exactly as before.
- If a mentioned file does not exist, say so in your reply and carry on.

## Step 4 — Load all stakeholders

For every ref in the task's `stakeholders` field, read `stakeholders/people/<ref>.md`. These people are your audience. Every output must be calibrated to what they need to understand, decide, or act on — their influence level, communication style, and what matters to them shape the depth, framing, and tone of everything you write.

## Step 5 — Load relevant context

Scan the full `context/` library (company, organization, strategy, programs, decisions, risks, glossary, situation). Use the task's `contexts` field and any `@` mentioned context notes as a starting point, but go beyond them. Pull in every note that is relevant to the task subject. Ground all claims in these notes — never fabricate data.

## Step 6 — Load the output template

For each deliverable in the task, find the template at `outputs/templates/<template-slug>/output.md`. The template defines required sections and the style guide. Every required section must be present in your output.

Read the template's `format` field from its frontmatter. This determines the file format of the deliverable. Note it before proceeding — you will use it in Step 7 to produce and save the output in the correct format.

Also list all files in the template folder (`outputs/templates/<template-slug>/`). Note any non-Markdown assets present (images, logos, fonts). When building the deliverable, reference these assets by their absolute file path — do not re-create, regenerate, or re-encode them.

If the template folder contains a document file whose format matches the deliverable format (`.pptx`/`.potx` for PPTX, `.docx`/`.dotx` for DOCX, `.xlsx` for XLSX), that file **is** the template. Do not generate the deliverable from scratch and do not treat the file as a color or style reference. Copy it, then edit it in place: keep its slide masters, layouts, placeholders, logos, footers and page numbers, and replace only the sample content with yours. Reuse its existing layouts rather than drawing new ones. Delete the guide and sample pages the template ships with before saving. Confirm no template sample text survives in the output.

## Step 7 — Produce the deliverable

Write the output with all of the above loaded. The output must:

- Open with the key insight or decision, not background
- Reflect the executive's voice as defined in the profile
- Be calibrated to the stakeholder audience's needs and influence level
- Follow the output template's required sections and style guide
- Use placeholders (`[PLACEHOLDER: description — responsible: person — by: date]`) for any missing data

Save the deliverable in the format specified by the template's `format` field:
- **PDF** → build an HTML source file, then convert to `.pdf` using `weasyprint`. Load the `pdf` skill if available.
- **PPTX** → load the `pptx` skill and produce a `.pptx` file.
- **DOCX** → load the `docx` skill and produce a `.docx` file.
- **HTML** → save as `.html` directly.
- **MD** → save as `.md` directly.

Never produce an HTML file when the template specifies a different format.

Save to `tasks/active/$ARGUMENTS/deliverables/<DEL-ID>.<extension>` where the extension matches the format above.

## Step 8 — Verify names and terminology

Before updating the task, check the proper nouns in the deliverable you just saved. A source draft in the task folder is an input to verify, not a source of truth to transcribe.

1. Extract every person name and every system, product, or program name that appears in the deliverable content.
2. Resolve each person name against `stakeholders/people/*.md` (the `name` field). Resolve each system, product, or program name against `context/glossary/` and the rest of the context library.
3. Report every proper noun that does not resolve. List them in your reply as names you could not verify, naming the file each came from. Never silently correct one and never silently pass one through.
4. Report near misses the same way. A draft saying "Jon Smyth" where the stakeholder file says "John Smith" is a flag, not an auto-correct. Either side could be the stale one, so let the executive decide.

Do not block on this. Save the deliverable, run the check, then report anything that did not resolve alongside your summary.

## Step 9 — Update task and log execution

After saving the deliverable:

1. Update `tasks/active/$ARGUMENTS/task.md`:
   - Change deliverable `status` from `pending` to `complete`
   - Set `file_path` on the deliverable to the workspace-relative path of the created file (e.g. `tasks/active/TASK-2026-0001/deliverables/DEL-01.html`). This is required — the UI uses this field to show a clickable "Open output" link on the task card. Never skip this step.
   - Change task `status` to `in_review`
   - Update `updated_at` to current ISO 8601 timestamp

2. Write an execution log to `tasks/active/$ARGUMENTS/executions/<timestamp>.md`:
   - What you created
   - Key decisions and judgment calls made
   - Sources (context notes, stakeholder files) used
   - Any placeholders inserted and what is needed to fill them

Never set the task status to `done`. Only the user does that after reviewing your output.

## Step 10 — Rework after in_review

If the user requests a change to a deliverable after the task has been set to
`in_review`, treat it as resuming work, not as a side comment.

**First, before anything else**, set `status` back to `in_progress` in
`tasks/active/$ARGUMENTS/task.md` and update `updated_at`. Do this before you read the
deliverable, before you edit it, and before you reply. The board must show that the task
is being worked on again. Never leave it at `in_review` while you are changing the
output.

Then apply the fix, save the deliverable, and run Step 9 again to set the task back to
`in_review` with a fresh `updated_at` and a new execution log entry.

This is required for every correction, however small. A wording tweak is still rework.

### Kaizen proposal

Before or after applying the fix, also record what went wrong so it does not repeat:

1. Identify the root cause of the mistake — not the symptom, but why the instruction set did not prevent it.
2. Determine the next available kaizen ID by listing `kaizen/` and incrementing from the highest existing number.
3. Create a proposal at `kaizen/KAIZEN-YYYY-NNN.md` following `.schemas/kaizen.schema.json`. Do not copy the shape from a sibling kaizen file — a defect in the file you copy becomes a defect in yours. Include:
   - `root_cause`: what instruction or signal was missing
   - `proposed_fix`: the concrete change to a harness file that would prevent recurrence
   - `files_affected`: the specific file(s) to update
   - `created_at`: current ISO 8601 timestamp (required — the board shows it on the card)
   - `task_ref`: the task that triggered this proposal
4. The frontmatter needs **both** an opening `---` and a closing `---`. The board parses the block as a whole: with no closing fence the parse fails and every field falls back to empty, so the proposal renders as a blank card instead of failing loudly.
5. Set the proposal `status` to `proposed`.
6. Read the file back and confirm the frontmatter parses and the title is non-empty before you report the proposal as filed.
7. Do not mark it `applied` — only apply it when the user runs `/gtd-kaizen <ID>`.

One mistake = one proposal. If multiple independent failures caused the same correction, write one proposal per root cause.
