# Get Things Done user guide

[Back to the project overview](../README.md) · [HTTP API](api.md) · [Architecture](architecture.md)

Detailed setup, task execution, meeting recording, memory review and workspace reference.
This guide accompanies 0.9.0; see the [changelog](../CHANGELOG.md).

## Install

Requires **Node.js 20.19 or newer** (22 or 24 recommended).

```bash
npm install -g @bertonha/getthingsdone
```

This installs the `gtd` command globally. The application lives in your global
`node_modules`; your workspaces hold only your content.

Verify:

```bash
gtd --version
```

### Updating

**Settings > Updates** shows your version and whether a newer one is out; a banner at the top
says so once per version (**Later** hides it for that version), never while a recording, a
transcription or an AI tool run is going. For an npm install, it gives the commands to run:

```bash
npm install -g @bertonha/getthingsdone@<version>
gtd stop
gtd upgrade
gtd start
```

`gtd upgrade` refreshes the app's own files in your workspace (instructions, schemas); a file
you edited is kept, with the new version saved next to it as `.new`. A copy installed in a
project folder (not with `-g`) is updated there, and `npx` runs take the version in the command.
The desktop app updates itself and asks you to restart; an unsigned or preview build links to
the release page instead.

---

## Your first workspace

Create a folder and initialize it:

```bash
mkdir ~/work-memory
cd ~/work-memory
gtd init
```

`gtd init` asks five questions:

| Question | What it is used for |
|---|---|
| Workspace name | Shown in the dashboard header |
| Your name | Written into your work profile |
| Your role/title | Helps agents calibrate tone and altitude |
| Organization | Interpolated into agent instruction files |
| AI tools | Which assistant integrations to install |

Then start the dashboard:

```bash
gtd start
```

It opens <http://localhost:3001> in your browser and keeps running in the
background. Close the terminal; it stays up. `gtd stop` when you are done.

### Scripted setup

For dotfiles, containers or CI, skip the prompts entirely:

```bash
gtd init --yes \
  --name "Jane Doe" \
  --role "Chief Technology Officer" \
  --org "Acme Corp" \
  --workspace-name "Acme Work Memory" \
  --ai claude-code,codex
```

`--yes` also engages automatically when stdin is not a TTY.

---

## Core concepts

Five things make up the system. Get these right and the AI output gets dramatically
better.

### 1. Your profile — `profile/executive-profile.md`

Who you are and how you communicate. Every agent reads this before writing anything.
Fill in the sections honestly: **Responsibilities**, **Communication Style**,
**Decision Making**, **Language Preferences**, **Recurring Expectations**,
**Principles**.

This is the single highest-leverage file in the workspace. "Direct, no hedging, lead
with the ask, never use em dashes, Japanese business context so use -san" produces
visibly different output than an empty profile.

### 2. Stakeholders — `stakeholders/people/`

One file per person: their role, organization, influence level, and what actually
matters to them. Influence level drives how agents write to them:

| Influence | How agents adapt |
|---|---|
| `decision_maker` | Brief, direct, leads with the ask, one page |
| `influencer` | Acknowledges their perspective first, invites input |
| `informed` | Summary only, no unrequested detail |
| `executor` | Clear action, timeline, owner, no ambiguity |

**Org charts** (`stakeholders/org-charts/`) map who reports to whom inside a company or
organization. Build them in **Stakeholders → Org charts** by dragging people onto their
manager. Agents read the charts for every stakeholder on a task, so a deliverable is
pitched at the most senior person involved and names the right escalation path.

**Prepare meeting** on a person's page opens the New task form already filled in: the
person as stakeholder, a **Meeting brief** output and the `meeting-prep` agent (when the
workspace has them). Add the other attendees, the meeting date and your goal, then save.
Nothing runs until you start the task.

### 3. Context — `context/`

Your background knowledge library, filed by category: `company/`, `organization/`,
`strategy/`, `programs/`, `decisions/`, `risks/`, `glossary/`, `situation/`.

Agents scan the whole library, not just what a task lists. Put the strategy deck
summary, the risk register, the org chart, the acronyms your company invented. This
is the memory you stop having to repeat.

Context goes stale as things change. Instead of editing notes by hand after every
meeting, import the material and let an agent propose the updates for you to review.
See [Keeping context up to date](#keeping-context-up-to-date).

### 4. Output templates — `outputs/templates/`

What "finished" looks like. Each template declares a format, required sections and a
style guide. Four ship by default: **Plain text message**, **Executive document**,
**Executive deck** and **Meeting brief**. Create your own for the artifacts you produce over and over —
your weekly update, your steering committee pack, your board memo.

### 5. Tasks — `tasks/active/`

The unit of work. A task links the other four together:

```
tasks/active/TASK-2026-0001/
  task.md            objective, stakeholders, contexts, deliverables
  deliverables/      what the agent produces
  executions/        what it did, what it assumed, what it could not find
  attachments/       source material you provide
  notes/
```

Tasks move `backlog` → `in_progress` → `in_review` → `done`. Agents set
`in_progress` when they pick work up and `in_review` when they finish. **Only you set
`done`**, and only after reading the output.

---

## Running a task with an AI agent

Create a task in the dashboard, attach the stakeholders and contexts that matter,
pick an output template. Then from your workspace folder:

```bash
claude
```

Claude Code loads `CLAUDE.md` automatically. Run the task:

```
/gtd-task TASK-2026-0001
```

The agent will, in order:

1. Set the task to `in_progress`
2. Read your work profile
3. Read the task definition
4. Read every stakeholder listed on it
5. Scan the full context library for anything relevant
6. Read the output template for each deliverable
7. Produce the deliverable into `deliverables/`
8. Set the task to `in_review`
9. Write an execution log recording decisions, sources and any placeholders

Where data is missing, agents insert explicit placeholders rather than inventing
figures:

```
[PLACEHOLDER: Q3 revenue from Finance - owner: Sam Rivera - by: 2026-09-05]
```

A complete structure with marked gaps beats a partial document.

### Specialist agents

Four ship with the Claude Code integration and are selected via a task's
`preferred_agent` field:

| Agent | Use for |
|---|---|
| `executive-report-writer` | Reports, decks, memos, strategic documents |
| `stakeholder-advisor` | Sensitive comms, influence mapping, politics |
| `context-researcher` | Research and context notes (writes context, not deliverables) |
| `meeting-prep` | Briefs, talking points, likely questions, red lines |

### Skills

Five curated skills ship by default: `decision-brief`, `financial-analysis`,
`presentations`, `risk-analysis`, `stakeholder-communication`. More can be installed
from the Anthropic skills marketplace inside the dashboard's Agents view.

### Other assistants

Selecting `copilot` or `codex` at init writes `.github/copilot-instructions.md` or
`AGENTS.md` with equivalent guidance. Same files, same conventions.

---

## Keeping context up to date

Your context is only useful while it is true. A reorg announced in a meeting, a new
target on a slide, a decision made in a hallway: each one makes some note out of date,
and every task produced from that note gets a little worse.

**Context updates** turn that raw material into a few reviewed changes. You bring the
material, an agent does the reading and comparing, and you decide what goes in.

The rule behind the whole feature: **never change just to change.** The agent distils
the material into the few edits that keep your context true. One meeting usually
justifies one or two changes, and "nothing worth changing" is a normal result.

### How it works

| Step | Who | What happens |
|---|---|---|
| 1. Collect | You | Upload files or paste a transcript in the dashboard |
| 2. Analyze | Agent | `/gtd-context-analyze CU-…` reads the material against your whole context and proposes changes |
| 3. Review | You | Accept or reject each proposal, shown as a before and after diff |
| 4. Apply | Agent | `/gtd-context-apply CU-…` writes only what you accepted, then cleans up |

Nothing in `context/` or `stakeholders/` changes until step 4, and only for the
proposals you ticked.

### 1. Collect

Open **Context** and click **Import update** (or **Import & review** in the sidebar,
under the categories). Then add:

- **Files**, as many as you like, in any format: transcripts, slides, PDFs,
  spreadsheets, photos, screenshots. Up to 50 MB each.
- **Pasted text**, for a transcript copied from your meeting tool, notes or an email
  thread. It is saved as a file with the rest.

A **WebVTT transcript** (`.vtt`, the export of Teams, Zoom or Meet, uploaded or pasted)
also gets a readable copy next to it, `<name>.transcript.md`: each turn with its start
and end time and the speaker as the file labels it, every word kept. Anything the
dashboard cannot read is listed in the copy, which then says it is incomplete. The
original stays, and the update records which file is a copy of which, so the agent
reads the copy and removing an original removes its unchanged copy. If the original or
the copy is edited afterwards, the copy is marked outdated and the agent reads the
original. To make a copy
again, remove the original and add it again. The same file twice in one update is
refused.

A **Word document** (`.docx`, for example the Word export of a Teams transcript) gets a
readable text copy, `<name>.text.md`: the paragraphs of its body as written, speaker
names included as they appear. Tracked deletions and field instructions are left out
(a field shows its result), and headers, footers, comments and footnotes are not part
of the body. Only plain text is taken as complete: a document with tables, pictures,
embedded objects, text boxes, symbols, alternative or imported content, or anything
else the reader does not know gets a copy marked incomplete, naming what is missing,
so the agent reads the original as well. A damaged or ambiguous package or malformed
XML gets no copy, and an encrypted file (for example one with a sensitivity label) is
not read: either is saved alone, with the reason shown.
- **Date of the material**: when the meeting happened or the deck was shared, not
  today. The agent uses it to tell newer facts from older ones, so an old deck never
  overwrites something more recent.
- **Notes for the agent** (optional): what this is, who was there, what to trust or
  ignore. For example: "Budget figures are a first draft."

Save, and the update gets an ID such as `CU-2026-0001` and the command to run next.
Put everything about one event (the transcript, the deck and the follow-up email) in
one update, so the agent reads them together.

### 2. Analyze

From your workspace folder, start your agent and paste the command the dashboard
shows:

```
/gtd-context-analyze CU-2026-0001
```

The agent reads every file, then your whole context library, your stakeholders and
org charts, and your profile. A fact becomes a proposal only when it is:

- **Durable:** still true and useful in a few weeks. Meeting logistics and small talk
  are not.
- **Consequential:** a deliverable written next week would be wrong or weaker
  without it.
- **New or different:** not already in your context in substance. Rewording is not a
  change.
- **Grounded:** it can point to where the fact appears in the material. Rumours are
  skipped, or recorded clearly as unconfirmed.
- **Not older than what is there:** older material only fills real gaps.

It prefers updating an existing note to creating a new one, makes one proposal per
file, and keeps edits small: your structure, headings and wording stay. Every proposal
comes with a reason, evidence (for example "transcript.txt, around 00:14" or
"deck.pptx, slide 6") and a confidence level. Contradictions with your current
context are called out, never silently overwritten.

When the material is from meetings, it also drafts a short **meeting record** per
meeting: the date, who attended (linked to your stakeholders where it is sure, the
name as written otherwise), decisions, open questions and action items. A record is
not a context change, so it does not need a file.

It also lists what it **considered but did not propose**, with the reason, so you can
see the filter at work. Files it could not read (audio, video, encrypted files) are
listed too, instead of being guessed at.

The dashboard updates by itself while the agent works.

**Run it from the dashboard.** If Claude Code is installed and signed in with your
Claude account, a ready update's main action is **Run analysis**, and the command to copy
waits under **Or run it yourself** (for Codex or Copilot, or to watch it in your own
terminal). When the dashboard cannot run it, it says why, and copying the command is the
main action instead. The dashboard runs
the same command in the background, with your Claude Code and your Claude plan (no API
key), under this workspace's own permission rules, as when you run it yourself: with the
rules the app installs it can write into `context-updates/` and `tasks/`, never into
`context/`, `stakeholders/` or your profile. Your personal Claude Code settings, hooks
and MCP servers are left out of the run. Before it starts, the dashboard checks that
Claude Code is signed in with a Claude plan (not an API account), that the workspace sets
no API key, and that Claude Code trusts the workspace folder: the first time, open a
terminal in the workspace folder, run `claude` once and accept "trust this folder". One
analysis runs at a time, the update is locked while it runs, and **Stop** ends it with
everything it started.

### 3. Review

Open the update. Each proposal shows:

- the file it creates or changes, and whether it is a new file or an update
- why it matters, the evidence and the confidence
- a diff of the file as it is now and as it would become: **+ green** lines are
  added, **− red** lines are removed

Tick the proposals you accept. Your choices are saved as you go, so you can leave and
come back. If a proposal is almost right, accept it and add a **note for the agent**,
such as "keep the old title" or "say this is still a draft".

Meeting records are reviewed on their own: **Confirm** a record that is right, or
**Reject** it. A confirmation is for the exact text you saw: if the record changes
afterwards, it needs confirming again before you can approve or close. A record that
is malformed or too long to show in full says why, and can only be rejected until the
agent fixes it.

Once the update is done, each action item of a confirmed record has **Create task**: it
opens the New task form filled in from the item (title, where it comes from, the due
date, and the owner as stakeholder when the record's name is that stakeholder's name).
Nothing is created until you save. Saving creates the task and links the item to it in
one step, so the same item never becomes two tasks, even from two windows. Agents never
create tasks from action items themselves. You can confirm a meeting that changes nothing in your context, and an
update with only confirmed records finishes as soon as you approve it. Confirmed
records stay with the update after it is done, and System cleanup never removes an
update that has one. A record you did not confirm is rejected when you approve or
close.

When you are done, click **Approve N selected**. Anything left unticked is rejected and
your selection is locked. Changed your mind before applying? **Change my selection**
takes you back. If nothing is worth taking, **Close without changes** finishes the
update without touching any file.

If a file was edited after the analysis, the proposal says so. The diff is then shown
against the current version, and when applying the agent merges instead of
overwriting the newer edits.

### 4. Apply

Run the second command the dashboard shows:

```
/gtd-context-apply CU-2026-0001
```

The agent writes only the accepted proposals, following your notes, and records an
outcome for each one: applied, merged with newer edits, or failed with a reason. Then
the update is **Done**. Its record stays (the summary, the list of materials, every
proposal with your decision and its outcome), while the uploaded files and drafts are
deleted, so the workspace does not grow over time.

**Apply from the dashboard.** An approved update's main action is **Apply with Claude Code**: the
same command, run in the background with your Claude Code and your Claude plan. The
workspace asks before any write to `context/`, `stakeholders/` and `outputs/`, and the
dashboard answers for you, file by file: yes only for the files you accepted (and the
update's own folder), no for everything else it is asked about, including commands.
Writes the workspace allows without asking (with the rules the app installs:
`context-updates/` and `tasks/`) go through as usual. A file reached through a symlink is
always refused. The run's result checks every change you accepted against what the
agent recorded, and lists any write that was refused. An apply that stopped half way
can be continued with **Continue applying**.

### Statuses

| Status | Meaning | What you do |
|---|---|---|
| Run the analyze command | Material saved | Run `/gtd-context-analyze` |
| Agent is analyzing | The agent is reading | Wait; the page refreshes by itself |
| Ready for your review | Proposals are in | Tick what you accept, then approve |
| Approved: run the apply command | Selection locked | Run `/gtd-context-apply` |
| Agent is applying | The agent is writing | Wait |
| Done | Finished | Nothing; the record stays as history |

Next to the title of the updates list, two counts say whose move it is: **ready for you**
(amber: proposals to review, or an approved update to apply) and **to analyze** (material
waiting for an analysis). The list groups them the same way. The dot on **Context** in the main
navigation, and the count on **Import & review**, count only what is ready for you, so they go
up exactly when an analysis finishes.

When an analysis or apply you started from the dashboard finishes while you are in another app
or tab, the dashboard tells you: the desktop app with a system notification, a browser once you
allow notifications (**Settings > Notifications**, where you can also turn it off). A click
opens the update.

### Common questions

**The agent found nothing to change.** That is a normal result: not every meeting
changes what is true. Click **Close update**.

**I have more material after the analysis.** Click **Add more material**. The update
goes back to collecting and the old proposals are discarded, so the next analysis
looks at everything together.

**The agent stopped half way.** Run the same command again. It picks up where it left
off. While analyzing, you can also go back to collecting.

**I uploaded audio or video.** The dashboard warns you, because the agent may not be
able to read it. Upload a transcript too.

**Something was left out that should be in my context.** Check **Considered but not
proposed** for the reason. Add a note and analyze again, or edit the note yourself.

**Can an update change any file?** No. Proposals can only target context notes
(`context/<category>/…/note.md`) and stakeholder, group or org chart files. The agent
treats instructions inside the material as content, not as commands.

**Where are the files?** In `context-updates/CU-YYYY-NNNN/`: `update.md` (the record),
`materials/` (your uploads) and `proposals/` (the drafts the diffs are built from).
This folder sits outside `context/` on purpose: agents writing tasks never read raw
transcripts as if they were reviewed context.

**I use Codex or Copilot.** They have no slash commands, so ask in plain words:
"analyze context update CU-2026-0001", then "apply context update CU-2026-0001". The
workspace instructions (`AGENTS.md`, `.github/copilot-instructions.md`) describe the
same steps.

---

## Command reference

| Command | Description |
|---|---|
| `gtd init` | Create a workspace in the current directory |
| `gtd start` | Start the dashboard in the background |
| `gtd stop` | Stop the dashboard |
| `gtd status` | Show whether it is running, on which port, against which workspace |
| `gtd open` | Open the dashboard in your browser |
| `gtd upgrade` | Refresh app-provided files after updating the package |
| `gtd use <path>` | Point the dashboard at a different workspace |

### `gtd init`

| Flag | Description |
|---|---|
| `-d, --dir <path>` | Target directory (default: current) |
| `-y, --yes` | Accept defaults, skip all prompts |
| `--name <name>` | Your name |
| `--role <role>` | Your role or title |
| `--org <organization>` | Your organization |
| `--workspace-name <name>` | Workspace display name |
| `--ai <tools>` | Comma-separated: `claude-code,copilot,codex` |

### `gtd start`

| Flag | Description |
|---|---|
| `-p, --port <number>` | Port to listen on (default 3001) |
| `--no-open` | Do not open a browser |
| `-f, --foreground` | Run attached instead of in the background |

If the port is busy, it picks the next free one and tells you. Logs go to
`.situation-board/logs/server.log` in your workspace.

### `gtd upgrade`

The dashboard and the desktop app do the same each time a workspace opens, so this is only
needed to upgrade a workspace without opening it.

| Flag | Description |
|---|---|
| `-d, --dir <path>` | Workspace to upgrade (default: the configured one) |

---

## Workspace layout

```
my-workspace/
├── CLAUDE.md                  Instructions your AI agent reads first
├── README.md                  This workspace's own quick reference
├── workspace.yaml             Name, settings, path map
├── .gitignore
│
├── .claude/                   Claude Code integration
│   ├── agents/                4 specialist agents
│   ├── commands/              /gtd-task, /gtd-context-analyze, /gtd-context-apply
│   ├── skills/                5 curated skills
│   └── settings.json          Tool permissions (read-wide, write-narrow)
│
├── .schemas/                  JSON Schemas for every file type
├── .situation-board/          App state: cache, logs, trash, manifest
│
├── profile/
│   └── executive-profile.md   Your voice and preferences
│
├── stakeholders/
│   ├── people/                STK-NNNN.md
│   └── groups/                GRP-NNNN.md
│
├── tasks/
│   ├── active/                One folder per task
│   └── archive/
│
├── context/                   Your knowledge library
│   ├── company/  organization/  strategy/  programs/
│   └── decisions/  risks/  glossary/  situation/
├── context-updates/           Imported material and what it changed
│
├── outputs/templates/         What "finished" looks like
├── kaizen/                    Kaizen notes (each opens a context update)
└── workflows/                 Reserved for multi-step workflows
```

Deletes are soft. Removing a file in the dashboard moves it to
`.situation-board/trash/` with a timestamp, and every overwrite keeps the previous
version there too.

### Cleanup and retention

A built-in **System cleanup** routine (Routines page, settings in
`.situation-board/routines/system-cleanup.json`) keeps the workspace tidy. Out of the
box it runs every Monday at 09:00 and only suggests: it scans your context notes and
stakeholders for duplicates, empty and old notes, and opens a context update tagged
**System cleanup**. Run `/gtd-context-analyze` on it, and the agent proposes merges,
moves and removals for you to approve. Approved removals go to the trash.

It never archives, trashes or deletes a file until you turn a rule on. Per type
(finished tasks, archived tasks, finished context updates, closed kaizen proposals,
the trash itself) you choose the age in days and the action: archive, move to trash
or delete permanently. A preview shows exactly what a run would do before you save.
Tasks tagged `keep` are never touched, nor are context updates whose materials you kept
or that hold a confirmed meeting record, and a run handles at most 200 items.

### Meeting digest

For meetings, choose **Add to the meeting digest** in the Import dialog instead of
importing straight away: the transcript or notes go into a queue
(`context-updates/meeting-queue/`, raw material like every update). A built-in
**Meeting digest** routine (Routines page, settings in
`.situation-board/routines/meeting-digest.json`) turns the queued meetings into one
context update, tagged **Meeting digest**, every working day at 18:00 by default. Run
`/gtd-context-analyze` on it (or **Run analysis** on its page), and the agent drafts one
meeting record per meeting and proposes context changes, as for any update. No AI runs
by itself unless you switch on **Analyze each new digest automatically** in its
settings.

- A day without queued meetings makes nothing. Missed days (the computer was off) make
  one digest the next time the dashboard starts; a digest covering several days says
  so in its title.
- While a digest waits for your review, no new one starts: meetings wait in the queue
  instead of piling up as stale digests. **Make digest now** does not wait for the
  schedule.
- The oldest meetings go first, at most 10 per digest (up to 20) and 400,000 characters
  of readable text, about a day and a half of meetings (a full-day meeting is about
  250,000; changeable in Settings); the rest wait. One analysis reads the whole digest,
  so long days are spread over several digests, and a meeting longer than that on its
  own gets a digest of its own. The agent reads one meeting at a time, long transcripts
  in parts.
- **Right after each meeting** (off by default): next to the schedule, a digest is made
  within a minute of a meeting being queued, any day and time, when no digest waits for
  review. Meetings queued while one waits go into the next digest as soon as it is done.
  A digest that cannot be made (a queued file changed) is tried again only once the
  queue changes.
- **Automatic analysis** (off by default): as soon as a digest is made, the dashboard
  runs the analysis with your installed Claude Code on your own plan, so the proposals
  are ready the next morning. If another run is going, it starts after it. If it cannot
  start (Claude Code not installed, not signed in, or the folder not trusted), the card
  says why and nothing is retried by itself; a digest that already had a run is never
  started again automatically. While the routine is paused nothing starts on its own;
  **Make digest now** with automatic analysis on still analyzes the digest it makes.
  Nothing changes in your context until you approve.
- Each meeting keeps its own date, and the digest records which queued meeting each
  file came from. A meeting whose file changed since it was queued stays in the queue,
  with the reason.
- A meeting leaves the queue only once the digest holds all its files, checked by hash;
  until then the digest cannot be changed or deleted. If the dashboard stops halfway,
  the next run finishes or undoes the digest, so no meeting is lost or digested twice.
  A digest deleted by hand before its meetings left the queue puts them **on hold**:
  they stay, and go into a digest only after you choose **Queue again**.
- **Recordings** can go into the queue too, up to 4 GB: WAV, and on a Mac also M4A, MP3,
  AAC, FLAC or AIFF. Uploads stream to disk. A meeting with a recording waits in the
  queue for its transcript, made on this computer with the model chosen in **Settings >
  Transcription** (see below); the transcript then goes into the digest with the meeting.
- **Meetings**, in the left menu, is where recording, the live transcript, the queue and
  its transcripts are. The Meeting digest card in Routines keeps the schedule and settings.
- **Make digest now** on the Meetings page sends the queue to a digest without waiting for
  the schedule, which it shows beside the button.
- Starting a recording opens the Meetings page with its live text. After Stop the page
  shows the transcript, the live text first and the final one once it is ready, and
  **Read it** on any meeting opens its transcript there.
- **Record** in the top bar (or **Record a meeting** on the Meetings page, in ⌘K search,
  or in the desktop app's menu-bar menu) records the microphone, in the desktop app
  and in the browser (Chrome or Edge, with the dashboard opened at localhost). While it
  runs, the top bar shows the time and **Stop** on every page. Tell
  everyone first: the dialog asks each time. A banner shows on every page with what was
  captured and what is saved. In the desktop app it also records the computer's own
  sound, so the other people in a video call are recorded too, also when you wear
  headphones (Windows, and macOS 14.2 or later, which asks once for System Audio
  Recording). With speakers instead of headphones the microphone hears the call as
  well; headphones give the cleanest recording. In a browser only the microphone is
  recorded. Audio is saved as it arrives, about 115 MB an hour; what the page
  has not sent yet is lost if the page crashes, so the banner warns when the server stops
  answering. In the desktop app the recording keeps going with the window closed, and the
  computer stays awake. A recording whose page is gone is never cleaned up: it stays
  until you choose Finish or remove the meeting, and a new recording waits for that.
  Stay on one workspace while recording.
- Every change to the queue takes one lock for the workspace, so two dashboards on the
  same workspace never change it at the same time.
- A meeting removed from the queue, and drafts left half-uploaded for a day, are
  deleted with their files.

### Offline transcription

Meeting recordings are transcribed on your computer, offline: nothing is sent
anywhere. **Settings > Transcription** lists the speech-to-text models with their
pluses and minuses; download one once (it is shared by every workspace and kept in
`~/.gtd/models/`, outside the workspace).

- **Whisper large-v3-turbo** (the default): accurate, in English and Japanese alike,
  with full punctuation and 100 languages. It takes longer (about 4 times faster than
  real time, so an 8-hour meeting takes about 2 hours) and needs about 4 GB of memory
  while it transcribes.
- **Whisper large-v3**: the most accurate, also of short remarks, with the same
  languages. It is slow (about real time on continuous speech, so an 8-hour meeting
  can take up to 8 hours), needs about 5 GB of memory and is a 1.8 GB download.
- **SenseVoice**: very fast (about 80 times faster than real time, so an 8-hour meeting
  takes about 6 minutes) and light (under 1 GB), a little less accurate, in English, Japanese,
  Chinese, Korean and Cantonese.
- **Language**: Auto detects the language of each part of a meeting, so it suits a
  meeting that switches between English and Japanese, though it can pick the wrong
  language for a very short remark. For the most accurate transcript of a meeting in
  one language, choose that language.
- **Spoken language during a recording**: the recording banner, and in the desktop app
  the menu-bar menu, change the language from that moment on: the live transcript and
  the transcript made after the meeting both follow it. It applies from the audio saved
  so far, up to a few seconds before the click. Whisper then writes that language;
  SenseVoice takes it as a hint and still follows clear speech in another language.
- **Parts of a meeting**: a transcript made after a meeting cuts it at 2 seconds of
  silence, and a live transcript at half a second, so text keeps coming. Each part is
  given a moment of the audio around it, speech too long for the model is split at a
  quiet moment, and text a model repeated in a loop is marked `[repeated N times]`. A live
  transcript that is final at Stop keeps its shorter parts. These choices follow
  [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) (MIT).
- **Tell speakers apart** (optional, a 41 MB download): a transcript made after a meeting
  marks who spoke when, as Speaker 1 and Speaker 2. These are labels for that recording,
  not names. It runs on this computer, in a job of its own: if it fails, the transcript is
  still made, without them. A part that is not clearly one voice stays unmarked. With it
  on, a live transcript stays a draft until the transcript after the meeting is ready.
  Name the speakers right there on the Meetings page, with **Name** beside each one: a
  stakeholder or any name. The digest passes them on as named by you, and the analysis
  proposes names only for the speakers you left unnamed.
- Downloads show their progress, can be cancelled and continue where they stopped. Press
  Download on a second model while one runs and it waits its turn;
  every file is checked against its pinned checksum before it is used. On a computer
  with little memory, Settings suggests the lighter model.
- Behind a company proxy: downloads use Node's built-in `fetch`, which ignores the usual
  proxy variables unless told otherwise. Set `NODE_USE_ENV_PROXY=1` together with
  `HTTPS_PROXY` (Node 22.21 or later, or 24), and `NODE_EXTRA_CA_CERTS` for a company
  certificate, before starting the dashboard. Never turn certificate checks off.

**Test speed** on a downloaded model measures it on this computer, on about a minute of
sample speech (two short recordings from the SenseVoice model's repository, downloaded
once and checked): it estimates how long an hour of meeting takes, and, by rule of
thumb, whether there is room to transcribe while recording next to a video call. Once a model is tested, Settings recommends one
for this computer: the most accurate one that gets an hour done in 15 minutes.

Speeds were measured on an Apple Silicon Mac. **Check** on a downloaded model loads it
in the transcription engine, so you know it works on this computer. The engine
([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0) runs in its own
process for each job, so the model's memory and any crash stay out of the dashboard.

Recordings in the meeting queue are transcribed one at a time, oldest first, once a
model is downloaded; the Meetings page shows each one's progress.

- The transcript becomes a file of the meeting, `<recording>.transcript.md`: each part
  with speech, with its start and end time. Optional speaker detection labels the voices; you can name them in the dashboard.
- **Stop** ends a transcription and keeps nothing of it; the meeting waits until you
  choose **Try again** or remove it.
- A transcription that ends part way (the engine stopped, or no speech was found in more
  than a minute of audio) keeps what it found as a **partial** transcript: choose **Use
  this transcript** to let the digest take it as it is, or **Try again** to replace it.
- One transcription runs at a time across every dashboard on the workspace. If a
  dashboard stops in the middle, the recording goes back in line and starts again.
- **Live transcript:** choose a model under **Live transcript while recording** in
  Settings > Transcription (one much faster than real time, see **Test speed**), and the
  text appears on the Meetings page as people speak. If it covered the whole recording
  and is the chosen model, the transcript is ready at Stop. If it is another model, the
  chosen model transcribes the recording again after the meeting: the live text stays
  readable, the meeting waits, and **Use the live transcript** skips the wait. If a live
  transcript stops or falls behind, the recording is simply transcribed after the meeting.
- **Participants:** when recording or adding a meeting, list who you expect: stakeholders,
  or any other name. They stay with the meeting, the reminder to tell everyone names them,
  and the digest lists them as expected, not as proof of who came: the analysis names
  anyone who never appears. **Record this meeting** on a prepare-a-meeting task starts
  with its title and stakeholders.
- A recording stays in the queue until its meeting goes into a digest. Once the digest
  is checked to hold the complete transcript, the recording goes with the queue folder.
  **Keep recordings after transcription** in Settings retains the audio. From 0.9.0, newly reviewed meetings keep it in `meetings/<id>/audio/`; older retained
  digests keep their existing material layout. A partial transcript you chose to use
  keeps its recording until the digest is done.

---

## Meeting history and sources in 0.9.0

The Meetings page includes queued and reviewed meetings. Search titles, people or words in transcripts and notes, then open a meeting to read its transcript, record, action items or files. A record still under review is shown as provisional; confirmed records remain available even when retention has removed their transcripts.

### Recordings and versions

Enable **Keep recordings after transcription** if you want playback later. For newly reviewed meetings, retained audio is stored under `meetings/<id>/audio/` and text under version folders. Older retained meetings remain readable in their original layout. A transcript timestamp can jump into a retained recording.

From a reviewed meeting's **Files** tab, choose **Transcribe again** and a downloaded model. Queued recordings take priority. The new transcript is added as another version; choose **Use this version** explicitly to make it current. The confirmed meeting record does not automatically change when the transcript does.

### Correcting a record

Choose **Suggest corrections** from a confirmed, final meeting record. This creates a context update for analysis and review. Suggestions marked not sure leave the original value in place unless you choose to use them; you can take them back. Confirm and approve the correction before it becomes the current record.

A correction can also fix words the transcript misheard, for meetings whose text is kept in version folders. Its **Transcript** section shows each change in its line, before and after. Approving writes the fixed text as a new version, made from the version the correction started on; the version before stays. If approving stops part way, the page says so: approve again to finish it.

A follow-up can check the context for old values through the usual proposed-change workflow.

### Tasks that use meetings

Mention a meeting in a task objective, or select several meetings to create a deliverable. The dashboard pins selected sources and their hashes, alongside the record as it stood. The task shows when sources or the record have changed; refreshing the sources takes a new selection. Review those notices before running the task. Pinning documents the intended evidence; it does not sandbox the AI tool's filesystem access.

A task created from a meeting action also records where the action came from. Later corrections can flag changes to that action without silently rewriting the task.

### Retention and recovery

**Routines → System cleanup → Meetings** controls retention. **Keep this meeting** excludes an individual meeting from automatic cleanup. Deleting a meeting moves its retained files to trash while keeping its confirmed record; restore it from the deleted-meetings list while it is still in trash. Permanent deletion removes those files. Keep an independent backup, especially for recordings excluded from Git.

---

## What is yours and what is the app's

This is worth understanding, because it is what makes upgrades safe.

**App-provided** — ships with the package, refreshed on `gtd upgrade`:

```
CLAUDE.md    README.md    .gitignore    .schemas/
.claude/     (agents, commands, skills, settings)
outputs/templates/plain-text, executive-document, executive-deck, meeting-brief
```

**Yours** — created through the dashboard or by hand, never touched:

```
tasks/    stakeholders/    context/    context-updates/    kaizen/    workflows/
profile/executive-profile.md
outputs/templates/<anything you made>
.claude/skills/<anything you installed from the marketplace>
```

### How the app tells them apart

Not by folder — `outputs/templates/` and `.claude/skills/` legitimately hold both
kinds, and you may well want to edit `CLAUDE.md` yourself.

Instead the app records a SHA-256 of every file it installs in
`.situation-board/app-manifest.json`. On upgrade, for each app-provided file:

| Situation | What happens |
|---|---|
| File is missing | Installed |
| Hash still matches the manifest | You never touched it — replaced silently |
| Hash differs | **You edited it.** Yours is kept; the new version is written as `<file>.new` |

So customize `CLAUDE.md` freely. You will never lose your changes, and you will never
be stuck on an old version without knowing it. `gtd upgrade` prints exactly which
files fell into which bucket.

---

## Upgrading

```bash
npm update -g @bertonha/getthingsdone
gtd stop
gtd upgrade
gtd start
```

`gtd upgrade` operates on the configured workspace. If you keep several, run it in
each with `-d`:

```bash
gtd upgrade -d ~/work-workspace
gtd upgrade -d ~/board-workspace
```

---

## Version control and privacy

A workspace is a plain folder of Markdown, so git works well:

```bash
cd my-workspace
git init
git add .
git commit -m "Initial workspace"
```

The generated `.gitignore` excludes caches, logs, trash and private meeting folders.
Git is not a backup of ignored recordings; back up the workspace folder separately.

> **Use a private repository.** Stakeholder files contain real names, influence
> assessments and political notes. Context notes contain strategy and risk registers.
> Deliverables contain whatever you asked for. This is exactly the material that
> should not be public.

The dashboard server binds to `127.0.0.1`. Recording and transcription run locally
after the speech models are downloaded. Cloud AI tools receive the material they
read when you run analysis or tasks, including automatic digest analysis if enabled.
Model and sample downloads and marketplace access also use the network. Checking for
updates asks the npm registry, through your own npm and its settings (npm sends its version,
your system type and your registry login if you set one, as with any request), or, in the
desktop app, GitHub for the newest version number, once a day. Apart from the AI tool runs you
start or turn on, it is the only request the app makes on its own, and nothing from your
workspace goes with it; turn it off in **Settings > Updates**. The desktop app that updates
itself asks GitHub every six hours, on its own schedule. There is no Get Things Done cloud
account or telemetry service.

---

## Configuration

Global config lives at `~/.gtd/config.json`:

```json
{
  "workspace_path": "/Users/you/work-memory",
  "port": 3001
}
```

| Environment variable | Effect |
|---|---|
| `ESB_WORKSPACE_PATH` | Override the workspace path (takes precedence over config) |
| `PORT` | Override the port |

Switching between workspaces:

```bash
gtd use ~/other-workspace
gtd start
```

In the dashboard, click the workspace name at the top of the sidebar. It lists the
workspaces you opened on this machine (kept in `recent_workspaces` in the config file),
so switching back is one click. **Open another folder...** adds a new one. Removing an
entry from the list never touches the folder.

---

## Troubleshooting

**`gtd start` says the port is in use.**
It automatically moves to the next free port and prints which one. Pin it with
`-p 4000` if you prefer.

**The dashboard will not start.**
Check `.situation-board/logs/server.log` in your workspace — `gtd start` prints the
last lines on failure. `gtd status` shows whether a server is running and where.

**Search results look incomplete.**
Search uses the SQLite index built into Node 22.13 and newer (the desktop app has it
too). On Node 20 the app falls back to an in-memory scan automatically — everything
still works, ranking is just simpler. The log line starting `[search]` confirms it.

**I edited `CLAUDE.md` and now there is a `CLAUDE.md.new` next to it.**
Working as intended. A new version shipped, but your edits were kept. Diff the two
and merge whatever you want, then delete the `.new` file.

**I upgraded from the old `esb` command.**
`gtd` is the command now. `esb` still works as an alias, and your old `~/.esb/config.json`
is migrated to `~/.gtd/` automatically the first time you run it.

---

## Development

```bash
git clone https://github.com/geovanneb/get-things-done.git
cd get-things-done
npm install
npm run dev          # API on :3001, Vite UI on :5173
```

| Script | Purpose |
|---|---|
| `npm run build` | Build CLI, server and UI into `dist/` |
| `npm run dev` | Run server and UI in watch mode |
| `npm test` | Unit tests plus an end-to-end smoke test (needs `npm run build` first) |
| `npm run desktop` | Build, then open the desktop app from source (needs `npm install --prefix desktop` once) |
| `npm run seed:demo -- <url>` | Fill a running server with the fictional demo workspace |
| `npm pack` | Produce the exact tarball that would be published |

To get a populated dashboard for development or screenshots, create a throwaway
workspace and seed it. Never seed your real workspace.

```bash
node bin/gtd.js init -y -d /tmp/gtd-demo --name "Alex Morgan" --role COO --org "Northwind Labs"
cd /tmp/gtd-demo && node /path/to/get-things-done/bin/gtd.js start --no-open
npm run seed:demo -- http://127.0.0.1:3001
```

**Architecture.** See the [architecture and regression guide](architecture.md)
for module ownership, trust boundaries and testing rules. `src/cli/` is the CLI. `server/` is an Express API over the
workspace files, with a chokidar watcher pushing changes over SSE. `ui/` is React +
Vite, served statically by the server in production. `templates/` holds everything
scaffolded into a new workspace. `desktop/` is the Electron shell of the desktop app: it runs the
same server and dashboard, nothing is duplicated.

**HTTP API.** Agents and scripts can use the same local API as the dashboard. Every
route is listed, with examples, in the [API reference](api.md).

`server/src/services/scaffold.ts` is the single source of truth for creating and
upgrading workspaces. The CLI loads its compiled output at runtime so `gtd init` and
the server's `POST /api/workspace/init` can never disagree.

**Releases.** Maintainers push a `vX.Y.Z` tag. GitHub Actions builds, tests,
publishes to npm with provenance and creates the GitHub release from
[CHANGELOG.md](../CHANGELOG.md).

---

## Contributing

Contributions are welcome, from typo fixes to new features. Start with
[CONTRIBUTING.md](../CONTRIBUTING.md). Please read the [Code of Conduct](../CODE_OF_CONDUCT.md),
and report security issues privately as described in [SECURITY.md](../SECURITY.md).

---

## License

MIT — see [LICENSE](../LICENSE).
