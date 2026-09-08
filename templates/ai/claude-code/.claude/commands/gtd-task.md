---
description: Execute a task by ID (e.g. /gtd-task TASK-2026-0001)
---

You are executing task **$ARGUMENTS** on behalf of the executive. Before writing a single word of output, you must load the full context below. The quality of your work depends entirely on doing this step completely.

## Step 1 — Set status to in_progress

Update `tasks/active/$ARGUMENTS/task.md`: change `status` to `in_progress` and update `updated_at` to the current ISO 8601 timestamp.

## Step 2 — Load the executive profile

Read `profile/executive-profile.md` in full. This is the foundation of everything you produce:

- **Voice and tone**: Write in the executive's voice, using their communication style — not generic AI prose.
- **Language preferences**: Apply the language rules (e.g. English vs Japanese, formality level) appropriate to the output and audience.
- **Decision-making style**: Structure your reasoning the way the executive thinks — evidence first, options framed, recommendation clear.
- **Recurring expectations**: Apply format rules (e.g. one-page summaries, YoY comparisons, "So what?" conclusions) to every deliverable.
- **Principles**: Let these guide judgment calls — clarity over comprehensiveness, lead with the ask, no surprises.

## Step 3 — Load the task

Read `tasks/active/$ARGUMENTS/task.md` completely, including all frontmatter fields. Note the objective, deliverables, stakeholders, preferred agent, and any files in the task folder.

## Step 4 — Load all stakeholders

For every ref in the task's `stakeholders` field, read `stakeholders/people/<ref>.md`. These people are your audience. Every output must be calibrated to what they need to understand, decide, or act on — their influence level, communication style, and what matters to them shape the depth, framing, and tone of everything you write.

## Step 5 — Load relevant context

Scan the full `context/` library (company, organization, strategy, programs, decisions, risks, glossary, situation). Use the task's `contexts` field as a starting point, but go beyond it. Pull in every note that is relevant to the task subject. Ground all claims in these notes — never fabricate data.

## Step 6 — Load the output template

For each deliverable in the task, find the template at `outputs/templates/<template-slug>/output.md`. The template defines required sections and the style guide. Every required section must be present in your output.

Read the template's `format` field from its frontmatter. This determines the file format of the deliverable. Note it before proceeding — you will use it in Step 7 to produce and save the output in the correct format.

Also list all files in the template folder (`outputs/templates/<template-slug>/`). Note any non-Markdown assets present (images, logos, fonts). When building the deliverable, reference these assets by their absolute file path — do not re-create, regenerate, or re-encode them.

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

## Step 8 — Update task and log execution

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

## Step 9 — Kaizen trigger (corrections after in_review)

If the user requests a change to a deliverable after the task has been set to `in_review`, before or after applying the fix:

1. Identify the root cause of the mistake — not the symptom, but why the instruction set did not prevent it.
2. Determine the next available kaizen ID by listing `kaizen/` and incrementing from the highest existing number.
3. Create a proposal at `kaizen/KAIZEN-YYYY-NNN.md` following the schema from existing kaizen files. Include:
   - `root_cause`: what instruction or signal was missing
   - `proposed_fix`: the concrete change to a harness file that would prevent recurrence
   - `files_affected`: the specific file(s) to update
   - `task_ref`: the task that triggered this proposal
4. Set the proposal `status` to `proposed`.
5. Do not mark it `applied` — only apply it when the user runs `/gtd-kaizen <ID>`.

One mistake = one proposal. If multiple independent failures caused the same correction, write one proposal per root cause.
