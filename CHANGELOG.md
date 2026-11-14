# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/). While the version is `0.x`,
minor versions may include breaking changes.

## [Unreleased]

## [0.14.0] - 2026-11-14

**See who you are waiting on, and why a run stopped.** A stakeholder's page now lists the open
tasks **waiting on them**. When the dashboard runs Claude Code, it shows **which Claude account**
the runs use, and when Claude Code stops a run, for example at a usage limit, the dashboard
**quotes what it said**. The rest is fixes: a file written by hand or by an agent can no longer
blank a screen, a task due today is no longer overdue, Japanese search with several words works
again, and the dashboard keeps running on a folder it cannot read.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.14.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.14.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.14.0-unsigned-preview.exe`

The Mac apps installed from 0.8.0 or newer update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.14.0`, or **Update and restart** in Settings. No schema
or agent instruction changes, so your workspace needs no upgrade. If you run the dashboard from
source with `npm run dev`, nothing changes for you; an installed dashboard now accepts calls from
its own address only (see Security).

### Added

- **Waiting on them.** A stakeholder's page lists the open tasks whose waiting record names them:
  the task, what it waits for, since when, and the follow-up date, with due follow-ups first. It is
  read from the tasks each time, so **Set waiting** and **Resolve** on a task are the only places
  to change it. (#410)
- **Signed in as.** Next to the button that runs Claude Code on a context update, the dashboard
  shows the Claude account its runs use. A computer can have more than one Claude Code sign-in, and the dashboard's may not be
  the one your terminal uses. (#409)

### Changed

- **A run that Claude Code stops says why.** When Claude Code ends a run with an error of its own,
  such as "You've hit your weekly limit", the dashboard quotes it, and says plainly when the account
  has reached its plan's usage limit. Before, the run only said it had failed. (#409)

### Fixed

#### A file written by hand no longer takes a screen down

- **Hand-written files are read as what they mean.** A stakeholder or output template without a
  name, a context note with an unquoted date, or a task whose `tags`, `stakeholders` or
  `deliverables` were written as plain text made the Stakeholders, Output templates, Context,
  Situation or Insights screen fail for everything, and could leave the Board as a blank window.
  Now `tags: urgent` is one tag, `stakeholders: [STK-0001]` names a person, and a person without a
  name is listed under their id. (#412)
- **A page that cannot be drawn says so.** The dashboard used to go completely blank, sidebar
  included. Now the page shows a message with a reload button, and the rest of the dashboard keeps
  working. (#412)
- **Clearing a due date removes it.** The task page wrote `due_date: null`, which **Validate
  workspace** then reported as an error on that task. (#412)
- **A task cannot be saved with a status or priority the board does not know**, and text fields
  sent with another type are refused with a clear message instead of a server error. (#412)

#### Board, Situation and Insights

- **A task due today is not overdue.** Situation counted it as overdue from midnight UTC on its due
  day (from the evening before in New York) and left it out of Due soon. It now waits until the end
  of the day, as Insights already did. (#399)
- **The weekly chart on Insights keeps every week** across a daylight saving change. A week could
  go missing, and its tasks with it. (#400)
- **Opening another task while editing one opens it fresh.** Following an @-mention or a search
  result kept the first task's unsaved edits on the second task, and Save tried to send them
  there. (#401)
- **A count of one reads in the singular:** "1 task", not "1 tasks", on the board column badge, on
  meeting records and in the Insights turnaround tooltip. (#403)

#### Search, people, notes and files

- **Japanese search with several words finds results again.** 0.13.1 looked for the whole query as
  one exact piece of text, so `ノースウィンド　経営` found nothing. Each word is now looked for on its
  own, anywhere in the title or text. (#396)
- **Search shows a task's description once** when it is also the task's text. (#412)
- **Emptying a stakeholder's email or notes clears them.** The dialog closed as if it saved, but
  the old values stayed. (#402)
- **A context note cannot be saved in a category that does not exist.** A typo made a folder the
  dashboard never showed, and the note disappeared from Context. Asking for the notes of such a
  category no longer makes a folder either. (#406, #412)
- **Deleting an attachment that is already gone** (removed in another tab, by an agent or in
  Finder) says it is not found instead of showing a server error. (#398)

#### Meetings, git and the server

- **The dashboard keeps running on a folder it cannot read or a symlink loop** in the workspace.
  The server exited, again on every restart and on switching to that workspace. (#397)
- **A meeting from your iPhone that holds an empty file is delivered.** It was refused on every
  retry, so it never reached the queue. (#404)
- **An upload to the meeting queue whose name ends in a dot is kept.** It was saved under a name
  the queue hides, and the next upload deleted it. (#405)
- **The changes view names each changed file and counts its lines as git does.** It gave every file
  the first file's name and counted header lines as changes. (#407) Staging, committing, the log
  and the diff in a workspace that is not a git repository answer plainly instead of with a server
  error. (#412)
- **`gtd use` refuses a file**, and `gtd start --port` refuses a value that is not a port
  (`3001abc`, `0`, `70000`) with a message that says what to use. (#412)

### Security

- **An installed dashboard trusts only its own address.** Pages served on `localhost:3000`, `:5173`
  and `:4173` (the development ports) were also allowed to call the API, so another program serving
  a page there could read and change the workspace from the browser. Those ports are now trusted
  only when the server runs from source (`npm run dev`). (#412)

## [0.13.1] - 2026-11-10

**Ids stay put, text stays as written.** A fix release with no new features. A deleted task or
person never hands its id to the next new one, a context note keeps its subfolders when it moves,
saving an output template no longer erases its body, Japanese words are found inside unspaced text,
text with `$$` or `$&` is saved as typed, and `gtd stop` never signals a process that is not your
dashboard.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.13.1-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.13.1.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.13.1-unsigned-preview.exe`

The Mac apps installed from 0.8.0 or newer update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.13.1`, or **Update and restart** in Settings. No schema
or agent instruction changes, so your workspace needs no upgrade. If a dashboard from 0.13.0 or
older is still running when you update with `npm`, the new `gtd stop` cannot confirm it is the
dashboard and leaves it alone: quit it yourself once, or stop it before you update.

### Fixed

#### Ids that never come back

- **A deleted task's id is never handed out again.** Deleting the newest task gave its id to the
  next new task, so old mentions, routine receipts and run history pointed at the wrong one. (#368)
- **A deleted person's id is never handed out again either**, so tasks and @mentions that named
  them do not move to the next new stakeholder. (#369, #382)
- **Two people added at the same moment get two ids.** Before, the second could silently replace
  the first. (#370)
- **Deleting several items at once keeps every id reserved.** Two deletions at the same time could
  lose one of the reservations. (#382)

#### Context notes and output templates

- **A context note keeps its subfolders when it changes category.** Only the files at the top of
  the note's folder moved, and its subfolders were deleted. (#367)
- **A note title without Latin letters gets its own id.** A title in Japanese, for example, gave no
  id at all, or only its digits, which an unrelated title could share. Such a title now gets a
  short ASCII id of its own, and the same title always gets the same one. (#381)
- **Saving an output template keeps the body of `output.md`.** Agents read that body, and every
  save from the dashboard replaced it with the description. A body you wrote is now kept. (#372)
- **A new output template cannot replace an existing one.** A name that differed only in case or
  punctuation took over the other template and its files. It is now refused with a message that
  says to edit the existing template or choose another name. (#371)

#### Search and meetings

- **Search finds Japanese words inside unspaced text.** With the SQLite index, a word inside a
  longer run of kanji or kana, in a title or in the text, was never found. (#379, #382)
- **Meeting search matches only what was said.** The header of a transcript copy could match a
  search and show a result with nothing to point at. (#380)
- **Transcript corrections with `$$`, `$&` or `$'` are saved as written.** They were read as
  replacement patterns, so the saved text differed from what you reviewed. (#375)

#### Dates

- **An unquoted `due_date` reads as the day.** Written without quotes, by hand or by an agent, it
  broke validation and was saved back as a timestamp. One already saved that way reads as its day
  again. (#373)
- **"Days ago" counts calendar days.** Something from last night said "0 days ago", and so did
  tomorrow morning. (#374)

#### The `gtd` command

- **`gtd stop` never signals a process that is not your dashboard.** After a crash or a reboot, a
  leftover `gtd.pid` could name an unrelated process that got the same PID. `gtd` now checks that
  the dashboard on the recorded port reports that PID, and otherwise says so and leaves the process
  alone. (#377, #382)
- **A `gtd.pid` written by older versions is read again.** A file holding only a PID was not
  recognized. (#378)
- **`gtd init` keeps `$$` and `$&` in your name and organization**, and text that looks like a
  placeholder inside them is kept as typed. (#376, #382)

### Changed

- **Dependency updates:** Electron 45.2.3, dugite 3.3.2 (the bundled git in the desktop app),
  express-rate-limit 8.7.3, mdast-util-to-markdown and build tools. (#345, #346, #347, #348)

## [0.13.0] - 2026-11-08

**Share what is ready, keep the rest in.** Context notes now carry a **sharing label**, and only
notes labelled shareable can be **shared as one Markdown file** or feed a deliverable that leaves
your organization. **Board > Share pack** puts the files you choose from your tasks into **one ZIP
with a README**, a **names and terms check** catches a misspelled name or an unexplained
abbreviation before a deliverable goes out, and your **iPhone can send meetings** to this computer
over your local network.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.13.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.13.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.13.0-unsigned-preview.exe`

The Mac apps installed from 0.8.0 or newer update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.13.0`, or **Update and restart** in Settings from 0.11.0
on. The context note schema gains the optional `sensitivity` field, and the agent instructions for
Claude Code, Codex and Copilot learn to respect sharing labels. The dashboard brings these up to date
when it opens a workspace, or run `gtd upgrade`. The instruction changes only add lines, so if you
changed your instructions file, the new version in **Settings > Instruction updates** is pure
additions to merge. A note without a label counts as internal, so existing notes need no work.

### Added

#### Sharing

- **Sharing labels on context notes.** The note editor has a **Sharing** field: shareable, internal
  or personal, and note cards show the label. A note with no label counts as internal, and only you
  make a note shareable. A label typed by hand that is not one of the three shows as unknown, is
  kept, and never counts as shareable. (#327)
- **Share context notes as one Markdown file.** **Share** on the Context page lists the notes
  labelled shareable. Tick the ones you want, **Preview** the exact text, then **Download .md**. The
  file holds each note's title and body, without frontmatter, HTML, images, link targets,
  attachments, related notes or sources. If a note changes after the preview, the download is
  refused until you preview again. A label cannot catch a private sentence inside a shareable note,
  so the preview is where to check. (#329)
- **Agents respect sharing labels.** In a deliverable that leaves your organization (a `public`
  task, or a stakeholder from another organization), agents use only facts from shareable notes and
  say what they left out. A personal note is never quoted in anything someone else will see. A
  context update can make a label stricter but never looser: the review flags such a proposal, and
  accepting or approving it is refused. (#330)
- **Share pack.** **Board > Share pack** gathers deliverables and attached files from your tasks
  into one ZIP for a colleague. Choose the files, put them in reading order, **Preview** the final
  list, edit the README and **Download ZIP**. A task's own text, logs, sources, notes and backups
  never go in, and confidentiality is shown as information, not as permission. If a file changes
  after the preview, the download is refused until you preview again. The README starts in the
  dashboard's language. (#320, #337)

#### Before a deliverable goes out

- **Check names and terms.** Under a task's Deliverables, **Check names and terms** reads a
  Markdown, HTML or text deliverable and lists words close to a known stakeholder name ("Did you
  mean …?") and abbreviations that are neither in the glossary nor defined in the text, each with
  its line and a snippet. **Dismiss** what is fine, and the check remembers it for that deliverable.
  It is advisory and local: it changes nothing, blocks nothing, and uses no AI and no network.
  (#328)

#### Meetings and people

- **Receive meetings from your iPhone.** In **Settings > Devices**, choose **Connect an iPhone** and
  scan the code with Meetlaud. While Meetlaud is open, new meetings arrive in the meeting queue over
  your local network, encrypted, with no account and no cloud. It is off by default, the pairing
  code works once for five minutes, and the dashboard itself stays on this computer only. How it works: [docs/device-inbox.md](docs/device-inbox.md).
  (#331, #342)
- **The latest meeting with a person.** A person's page shows the newest confirmed meeting record
  that lists them as an attendee, with its date and a link. Meetings still in review, expected
  participants and names in a transcript do not count, and it is not proof that you attended. (#319)

### Changed

- **A context note's title must be new across all categories.** Creating a note whose title exists
  in the same category used to replace that note, and in another category it shared the other
  note's id, so saving, relabelling or deleting one changed the other. Both are now refused with a
  message that says where the existing note is. Workspaces that already have such a pair keep it;
  rename one note's folder to separate them. (#327, #333)
- **The Context folder download is now called "Download raw folder, unfiltered (.zip)"**, so it is
  not mistaken for Share. (#329)
- **A task's Files tab no longer lists hidden files** (names that start with a dot), as the folder
  ZIP and the share pack already did. (#328)

### Fixed

- **A save from an older version of a task no longer undoes Request changes.** A task page opened
  before someone used **Request changes**, or before an agent updated the task, saved its draft
  over the newer task and put it back in review with the feedback still open. The page now says the
  task changed, keeps your draft and offers **Load latest version**. Other failed saves are shown
  instead of being ignored. (#325)
- **A board drag from an out-of-date card no longer undoes Request changes.** A card that still
  showed In review could move a task you had just sent back to Done, with its feedback open. The
  board now says the task changed and leaves it where it is. (#334)
- **A task with an unquoted `updated_at` can be saved again.** Written without quotes, by hand or
  by an agent, the date never matched, so every save, **Request changes** and **Waiting for** said
  the task had changed. (#332)
- **A busy task keeps your draft.** When another writer held the task for a moment, the page said
  the task had changed and offered to drop your draft. It now says to save again in a moment.
  (#336)
- **An archived task opens read-only.** Opened from the board's Archive tab or a meeting's related
  work, it looked editable and every action failed with "Task not found". It now shows a notice and
  no editing controls, and its deliverables still open. (#336)
- **An archived task's deliverable links work.** Archiving moved the task's folder but kept the old
  path, so **Open** and the preview pointed at nothing. New archives update the path, and tasks
  archived before this show the right one without being rewritten. (#323)
- **Cleanup leaves a reopened task alone.** System cleanup could archive or delete a task that was
  reopened, or got **Request changes**, between its check and its action. (#324)
- **Search opens the context note you chose**, not just the Context page, also when the note was
  created after the page loaded. A note that no longer exists says so. (#321, #335)
- **A hand-written `__proto__` label no longer breaks the Context page.** It shows as an unknown
  label. (#335)
- **Dates and messages follow the dashboard's language.** The latest-meeting date and the
  change-request times used the computer's locale, and messages from **Request changes**, **Waiting
  for** and the share pack, like other server messages in error notices, were always in English.
  (#322, #337)
- **On macOS, a workspace path written as `/System/Volumes/Data/…` is no longer reported as not
  trusted.** That spelling and the short one are the same folder, and Claude Code files trust under
  the short one, so the dashboard refused every run of a trusted workspace and its advice to trust
  the folder could not help. The same goes for a git worktree whose bookkeeping uses the other
  spelling. (#339, #342)
- **Runs work when `ESB_WORKSPACE_PATH` is a relative path.** Claude Code runs inside the
  workspace, so the relative path the runner gave it for its settings file pointed inside the
  workspace a second time, and every run stopped at once with "The analysis did not finish". The
  server now resolves the workspace path to an absolute one, from the environment variable and from
  `~/.gtd/config.json`. (#338)

## [0.12.0] - 2026-11-07

**In your language, with your feedback on the record.** The dashboard now speaks **Japanese,
Portuguese and Spanish** as well as English. A task in review takes your **feedback right on the
task**, a task can say **what it is waiting for and when to follow up**, and after you correct a
meeting you can see **which work used it**.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.12.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.12.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.12.0-unsigned-preview.exe`

The Mac apps installed from 0.8.0 or newer update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.12.0`, or **Update and restart** in Settings from 0.11.0
on. The task schema gains the optional `change_requests` and `waiting` fields, and the agent
instructions for Claude Code, Codex and Copilot learn to work through change requests. The dashboard
brings these up to date when it opens a workspace, or run `gtd upgrade`. If you changed your
instructions file, it is kept: **Settings > Instruction updates** shows the new version to merge.
Existing tasks keep working as they are.

### Added

#### Your language

- **The dashboard in four languages.** Every screen, dialog and notice is available in English,
  Japanese, Brazilian Portuguese and Latin American Spanish. It follows the language of your system
  or browser, and **Settings** lets you pick one. Your choice applies across workspaces and takes
  effect without a restart. Some text can still appear in English, and the `gtd` command stays in
  English for now. (#305)
- **READMEs in Japanese, Portuguese and Spanish.** Each one is a short version of the English
  README. (#305)

#### Review and follow-up

- **Request changes on a task in review.** **Request changes** (Work tab) records your feedback in
  the task, with the date, and moves the task back to In progress in one step. It starts no agent.
  The next agent run reads every open request, addresses it and marks it addressed, so the feedback
  stays with the task instead of getting lost in a chat. (#315)
- **Say what a task is waiting for.** **Set waiting** records what the task waits for, from whom
  (a stakeholder or anyone else), since when, and an optional follow-up date separate from the due
  date. The board card shows **Waiting**. Once the follow-up date comes, the task appears under
  **Needs attention** on Situation as **FOLLOW UP**. It never changes the status, so other work can
  go on, and **Resolve** clears it. (#316)

#### After you correct a meeting

- **See the work that used a meeting.** A meeting's **Tasks** tab now has **Check related work**:
  every task, active or archived, that pinned the meeting, mentions it or was made from its action
  items, with how each one stands now (changes to review, an earlier version that is still valid,
  not pinned yet, and so on) and its complete deliverables. It changes nothing: open a task to
  look. (#312)

#### Instruction updates

- **See and settle new instructions in Settings.** When you changed an app file such as `CLAUDE.md`
  or `AGENTS.md` and the app ships a newer version, **Settings > Instruction updates** lists it.
  **Compare** shows yours against the app's. Once you have merged what you want, **I merged it**
  removes the `.new` file, and none comes back until a later release changes that file. (#314)

### Fixed

- **The dashboard warns before a run when Claude Code does not trust the workspace folder itself.**
  Claude Code applies a workspace's permission rules only when it trusts that folder (inside a git
  repository, the repository's root), not another folder further up. The dashboard also counted a
  trusted folder further up, so **Run analysis**, **Apply with Claude Code** and the meeting
  digest's analysis started and stopped within a second. It now shows the trust problem before the
  run, with the steps to fix it. (#306, #313)
- **Search finds words inside context notes.** Search only looked at a note's title and tags. No
  action needed: existing notes are found right away. (#307)
- **Enter opens the search result you highlighted.** With mixed result types it could open a
  different one. An older answer can no longer replace newer results, and a failed search now says
  so instead of showing "No results". (#308)
- **The `.new` copy stays current.** After the first conflict on a file you changed, the `.new`
  beside it was never refreshed, so you could be comparing against an old release. It now follows
  each release, and a `.new` you edited yourself is left alone. (#309)
- **A task's Files tab says when it could not load.** A failed request showed "No files attached",
  which looked like the files were gone. It now shows an error with **Try again**. (#310)
- **Validation flags a complete deliverable whose file won't open.** A wrong `file_path` passed
  silently and the dashboard showed a link that returned 404. It is now a warning that says what to
  fix, so a workspace that had this problem may show new warnings. (#311)

## [0.11.0] - 2026-11-05

Get Things Done now **updates itself from the app**, lets you **shape the Kanban board** the way
you work, and lets you **dictate into text fields**, transcribed offline on your computer.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.11.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.11.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.11.0-unsigned-preview.exe`

The Mac apps installed from 0.8.0 or newer update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.11.0` (or, from 0.11.0 on, **Update and restart** in
Settings). The workspace task schema gains an optional `board_column` field. The dashboard adds it
when it opens a workspace, or run `gtd upgrade`. Existing tasks and statuses keep working as they are.

### Added

#### Update from the app

- **Update and restart from Settings.** When Get Things Done was installed with `npm install -g`,
  **Settings > Updates** and the new version notice offer **Update and restart**: it installs the
  version it found, runs `gtd upgrade` and starts the dashboard again, and the page reconnects by
  itself. If npm fails, the version you had starts again and Settings says why. It works for a
  dashboard started with `gtd start`; elsewhere it says why not, and **How to update** still shows
  the commands to run yourself. (#296)
- **Restart to update in the desktop app.** A signed desktop app downloads a new version by itself,
  shows the progress in Settings > Updates, and offers **Restart to update** when it is ready. If
  the installer fails, **Restart to update** tries again. (#297)
- **It waits for what is running.** An update never restarts in the middle of a recording, a
  transcription, a dictation or an AI tool run. It waits until they finish, and new ones can't
  start once it begins. When the app can't tell whether something is running, it does not
  restart. (#296, #297)

#### Your board, your columns

- **Edit the board's columns.** **Edit columns…** on the Kanban board renames, adds, removes and
  reorders columns (drag a row, or use **Move up** and **Move down**). Each column says which
  status a task gets when you drop it there, so tasks, agents, Insights and the Agent Floor keep
  the statuses they know. (#301)
- **Two columns, one status.** "In Progress" and "Waiting on others" can both mean in progress: a
  task dropped in one remembers it in the new optional `board_column` field and stays there. (#301)
- **Nothing gets lost.** A new column only holds the tasks you drop in it. Removing a column never
  changes a task, and tasks no column shows stay in the List view ("N not in a column"). Columns
  are saved per workspace in `.situation-board/ui-preferences.json`, next to the sidebar order;
  **Reset to default** brings back the four columns. (#301)

#### Dictate instead of typing

- **Dictate into text fields.** **Dictate** (the microphone icon) under a field records your voice
  and adds the words when you press **Stop**: a new task's Objective, a context note's Content, the
  Notes for the agent of an imported context update, and a stakeholder's What matters and Notes.
  Up to five minutes at a time. While it records, the field shows the same red dot, time and
  **Stop** as a meeting recording. (#302)
- **Offline, on this computer.** It uses a transcription model you downloaded in **Settings >
  Transcription**, in the language set there (pick one next to the button when you have several;
  the choice is remembered in this browser). The clip goes to a private temporary file and is
  removed once it is transcribed. (#302)

### Fixed

- **The dashboard no longer opens as a blank page after a burst of requests.** The local request
  budget (3000 a minute, against runaway scripts) now counts the API only. It also counted the
  page's own scripts and styles, and a refused one left an empty page with no message. (#299)
- **Links from other websites open the dashboard.** A link to the dashboard from another
  site (a chat, a wiki) now opens it, while requests to the API from other sites stay blocked.
  (#299)
- **A run-finished notice opens the update in the right workspace.** When you switched workspaces
  after starting a run, a click on its notice now opens the update in the workspace where it ran.
  (#298)

## [0.10.0] - 2026-11-04

Get Things Done now **runs the next step for you and tells you when it is your move**. A context
update's analysis or apply starts from the dashboard with one button, shows what the agent is doing
while it goes, and sends you a notification when it is done. The app also **recognizes the voices of
people you know**, with their consent, and suggests their names in new transcripts. And it now
**says when a new version is out** and how to update.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.10.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.10.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.10.0-unsigned-preview.exe`

The Mac apps installed from 0.8.0 or 0.9.0 update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.10.0`. No workspace files changed in this release, so
`gtd upgrade` is not needed this time (running it does no harm).

### Added

#### Context updates that run themselves

- **Run the next step from the dashboard.** When Claude Code is installed and signed in, a ready
  update's main action is **Run analysis**, and an approved one's is **Apply with Claude Code**. The
  command to copy is still one click away under **Or run it yourself**, for Codex, Copilot or your
  own terminal. When the dashboard can't run it, it says why and copying becomes the main action.
  (#290)
- **See what the agent is doing.** While a run goes, the Next box shows how long it has been going
  and the step it is on ("Step 7 · Reading `context/…/note.md`"), with **Stop analysis**. **Show
  details** lists the last 50 steps. A step names only the tool and an existing file or folder in
  your workspace: never file contents, search terms, commands or tool output, and nothing is
  saved once the run ends. (#292)
- **Know whose move it is.** Next to the title of the updates list, **ready for you** (proposals to
  review, approved updates to apply) and **to analyze** each take you to their group. The dot on
  **Context** and the count on **Import & review** now count only what is ready for you, so they go up
  exactly when an analysis finishes. (#289)
- **Get told when a run finishes.** When an analysis or apply you started from the dashboard is done
  while you are in another app or tab, you get a notification: a system one in the desktop app, a
  browser one once you allow it. A click opens the update. Turn it off in **Settings >
  Notifications**. (#289)

#### Recognize known voices

- **"Sounds like Kim Park".** Once you name a speaker with a stakeholder, **Remember voice** asks for
  that person's consent, then remembers their voice on this computer. Later transcripts, and
  Transcribe again, suggest the name next to the speaker: **Use** names them, **Not them** hides the
  hint. It only suggests; nobody is named without your click. Off by default, in **Settings >
  Transcription > Recognize known voices**. (#293)
- **Your voices stay yours.** Voices are kept outside the workspace, in `~/.gtd/voiceprints/`, never
  in git, and only for the workspace they were recorded in. A stakeholder's page shows the consent
  (who recorded it and when) and every sample with the meeting it came from; remove one, or **Forget
  voice**. Deleting a stakeholder forgets their voice too. Details and privacy notes:
  [Recognize known voices](docs/voiceprints.md). (#293, #294)

#### Updates

- **Know when a new version is out.** **Settings > Updates** shows your version, whether a newer one
  is out, and exactly how to update this install (with a Copy button for the npm commands). A notice
  at the top says so once per version, never while a recording, a transcription or an AI tool run is
  going; **Later** hides it for that version. It asks the npm registry (or GitHub, in the desktop
  app) once a day, and nothing from your workspace goes with it; turn it off in the same place. The
  desktop app that updates itself keeps its own updater. (#288)

### Fixed

- **The GPU model says up front why it can't be chosen yet.** In Settings > Transcription, Whisper
  Turbo (GPU) shows a badge and the reason under its description ("Test speed to use it"), and the
  next step is the main button, instead of a radio that looked choosable and did nothing. (#285)

## [0.9.0] - 2026-11-03

Get Things Done now **keeps your meetings as a memory you can search, correct and build on**. Every
meeting, recorded or imported, has a page of its own: read and search what was said, play the
recording from any line, and see the record you confirmed. When the record or the transcript got
something wrong, suggest a correction and review it like any other change; the version before always
stays. Tasks can use one or several meetings as sources, and keep exactly the text they were given.

Meeting text is kept only if you choose to keep it, stays on your computer, and is left out of git.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.9.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.9.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.9.0-unsigned-preview.exe`

The Mac apps installed from 0.8.0 update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.9.0`.

### Added

#### Meeting history

- **Every meeting in one list.** The Meetings page lists queued and reviewed meetings together, newest
  first, with filters for what needs you, what is in progress and what is reviewed. Each meeting opens
  in its own dialog with **Transcript**, **Record**, **Tasks** and **Files** tabs and the steps it
  went through, from recorded to reviewed. A record still under review is shown as provisional. (#244)
- **Keep meeting transcripts and notes.** Until now a meeting's text was deleted once its review was
  done. You now choose: keep it, and System cleanup's new **Meetings** rule moves each meeting to the
  trash 180 days after it took place (change it in Routines > System cleanup). **Keep this meeting**
  keeps one longer, and you can delete one yourself at any time. The trash holds it 30 more days, so
  it can be restored. Confirmed records stay even when the text goes, and each record keeps the id of
  its meeting once its update is done, so links never move later. (#244, #247)
- **Find a meeting by what was said in it.** The Meetings search also looks inside transcripts and
  notes: every word, any case, full-width and half-width alike, Japanese included. Results show the
  best place with the words marked, and opening one goes straight to that line. (#253)
- **Play a recording from its transcript.** With **Keep recordings after transcription** on, the
  Transcript tab has a player: click a time to play from there, and the line being heard is marked.
  (#250)
- **Transcribe again.** A reviewed meeting whose recording is kept can be transcribed again with
  another downloaded model, from its **Files** tab. The result is added as a new version: the
  transcript you reviewed stays in use until you choose **Use this version**, and the confirmed record
  does not change by itself. Queued recordings always go first. (#269, #271)
- **Numbered turns.** Transcripts made from now on number each turn
  (`#12 [00:14:03 → 00:14:21] Speaker 2`), so a correction can point at exactly where a word changes.
  Older transcripts are read the same way. (#270)

#### Correcting what a meeting says

- **The analysis says what it is not sure of.** A meeting record can list its doubts: a name that
  sounds like a stakeholder's but is spelled differently, a term that may be in your glossary. The
  review shows a **Not sure** badge next to each, with the reason and a suggestion, before you
  confirm. (#248)
- **Suggest corrections** on a confirmed meeting record. It opens a correction for your AI tool to
  analyze, from the meeting's own pinned files, your stakeholders and glossary. You review it like any
  context update; approving it makes the corrected record the current one, and the original stays.
  (#249, #252)
- **Use a suggestion, or take it back.** Changes the analysis was not sure of are no longer only
  listed: use the right ones with **Use suggestion**, and **Undo** puts the old value back. (#266)
- **Fix misheard words in the transcript too.** A correction can also change words in the meeting's
  transcript (never a speaker or a time). Its Transcript section shows each change in its line,
  before and after. Approving writes the fixed text as a new version; the version before stays one
  click away. (#270, #273, #275)
- **Check the context for old values.** After a correction, **Check the context** opens a follow-up
  for your AI tool to find notes in `context/` and `stakeholders/` that still use the old name or
  term, and propose fixes you review as usual. (#265)

#### Tasks that use meetings

- **Make a task from meetings.** Mention a meeting in a task with `@` (a new **Meetings** tab), or
  tick several meetings in the list and choose **Create deliverable**. When the task is saved, the
  dashboard pins which transcripts and notes the agent may read, with their SHA-256, and the record
  as it was. The task page shows when a source or the record changed since; **Refresh sources** pins
  again and keeps the earlier selection. Each run reads its own sheet, so a later refresh never
  changes what an earlier run used. (#245)
- **A task from a meeting action knows where it came from**, and says when the meeting record has
  been corrected since, without changing the task. (#254)

### Changed

- **A reviewed meeting gets its own folder.** With meeting text kept, a meeting's transcripts and
  notes move out of `context-updates/` into `meetings/<id>/` once its review is done, listed with
  their SHA-256 in `meeting.json`. `meetings/` is left out of git. Meetings kept before stay where they
  are and still open, play and search as before. (#267)
- **Kept recordings live with their meeting.** With Keep recordings on, a recording moves into its
  meeting's folder with its transcript once the review is done, instead of keeping every material of
  the digest. The Meetings rule now covers recordings too, and deleting a meeting moves its whole
  folder to the trash. (#268)
- **Clear words about what agents can read.** Agents are told to read a meeting only when a task
  names it, and the sources sheet lists exactly which files. That is an instruction, not a lock: an
  agent can read any file in your workspace. The Meetings page and the docs now say so. (#280)
- **One look for controls and headings** across tasks, stakeholders, settings and meetings. (#251)
- **The README** now explains Get Things Done as work memory for your AI tools, with new screenshots
  and a full [user guide](docs/user-guide.md). (#274)
- Dependencies: Electron 45.2.0 (#258), electron-builder 26.18.0 (#257), electron-updater 6.8.11
  (#259), eslint 10.14.0, express-rate-limit 8.7.2, react-router-dom 7.18.5 (#263),
  @inquirer/prompts 8.7.5 (#264).

### Fixed

- **One task per action item, even from two dashboards at once.** Two dashboards could both see "no
  task yet" and each make one. (#249)
- **Deleting a meeting always leaves a way to restore it**, even when saving that it was deleted
  fails, or the app stops half way. (#276)
- **A task keeps its meeting text after a new version is chosen**, also when it was made while the
  meeting was still under review. (#277)
- **Versions of a meeting never share a file**, so editing one version's file leaves the others as
  they were, and every file kept is checked against the hash recorded for it. (#278)
- **A meeting folder holding a link to another folder is never read.** (#279)
- **Choosing a meeting's version updates every open dashboard**, not only the one you clicked in.
  (#281)
- **Transcribe again never mixes up two requests**, loses a running job, or drops a finished
  transcript it could not save at once. (#271)
- **A review choice saved just before an approval is never overtaken by it.** (#282)
- For contributors: steadier timing in the GPU helper test (#272); `actions/download-artifact` 8
  (#255).

## [0.8.0] - 2026-11-02

Get Things Done now **records your meetings and turns them into memory**. Click **Record**, follow
the live transcript, and the app transcribes the meeting on your computer, tells the speakers apart
and collects the day's meetings into one digest. Claude Code can then analyze that digest and apply
what you approved, right from the dashboard, on your own Claude plan. Audio and transcripts stay on
your computer: only an analysis you start (or switch on) uses Claude Code.

The dashboard also has a new, consistent look that works on a phone, and a sidebar you can arrange
yourself.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.8.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.8.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.8.0-unsigned-preview.exe` (see the note at the end)

The Mac apps installed from 0.7.0 update themselves to this release. With `npm`:
`npm install -g @bertonha/getthingsdone@0.8.0`.

### Added

#### Record and transcribe meetings

- **Record a meeting** from the microphone, in the browser and in the desktop app. Start it with
  one click: **Record** in the top bar of every page, ⌘K, the desktop menu-bar menu, or **Record
  this meeting** on a meeting-prep task. The dialog is named after when you clicked (for example
  `Meeting 2026-11-01 14:30`), takes who is expected and the spoken language for that meeting, and
  asks you to confirm everyone was told. Audio is saved to disk as it arrives, so a closed page or a
  crash keeps what was saved, and an interrupted recording can be finished later. A banner on every
  page shows what is saved and warns about gaps, silence or a microphone that went away. On macOS,
  **REC** shows in the menu bar while recording. (#176, #177, #178, #181, #186, #232, #238)
- **The computer's sound too, in the desktop app.** A recording can also take the sound of the
  computer, so the other people in a video call are recorded even when you wear headphones. Works
  on Windows and on macOS 14.2 or later (it asks once for *System Audio Recording*), with no extra
  driver. In a browser only the microphone is recorded. (#179)
- **A Meetings page** with the recording, its live transcript and the meeting queue in one place.
  The queue shows newest first, with times, five at a time and a search. **Read it** opens any
  meeting's transcript, and **Make digest now** sits beside the queue with the time of the next
  digest. (#184, #195, #197, #218)
- **Offline transcription.** Download a model in **Settings > Transcription** and recordings are
  transcribed on this computer, nothing sent anywhere:
  - **Whisper large-v3-turbo** (default): accurate, full punctuation, 100 languages.
  - **Whisper large-v3**: the most accurate, also of short remarks, but slow.
  - **SenseVoice**: very fast and light, five languages (English, Japanese, Chinese, Korean,
    Cantonese).

  Each model lists every language it has. Downloads show progress, can be cancelled, continue where
  they stopped, and a second one waits its turn. Besides recordings made in the app you can queue
  WAV files, and on a Mac also M4A, MP3, AAC, FLAC, AIFF and CAF. A transcription can be stopped and
  tried again, and a partial transcript can still be used. (#164, #165, #167, #168, #188, #189,
  #190, #192)
- **Test speed** on each downloaded model says how long an hour of meeting takes on this computer,
  and recommends a model for it. (#180)
- **A live transcript while you record.** Choose a live model in Settings. At Stop, when the live
  text covered the whole meeting it becomes the transcript; otherwise the chosen model transcribes
  the recording again and the live text stays as a draft you can use meanwhile. Transcripts keep
  more context around each part, and text a model repeated in a loop is marked. (#182, #183, #194)
- **The spoken language, during the meeting.** Change it from the recording banner or the desktop
  menu-bar menu, and both transcripts follow from that moment. When the meeting sounds like another
  language, the app suggests it ("This sounds like Japanese, but the language is set to English"),
  with **Switch** and **Keep**. (#193, #231)
- **Who spoke when.** An optional speaker model (41 MB) marks Speaker 1, Speaker 2 and so on in a
  transcript. Name them on the Meetings page with a stakeholder or any name; the meeting's expected
  participants are offered first, and the digest passes your names on. (#196, #217, #229)
- **Whisper Turbo on the GPU, in the Apple Silicon app.** A built-in engine on
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) runs Whisper on the graphics chip. It can
  be chosen once **Test speed** shows it really runs there, also as the live model. If the GPU fails,
  the recording is transcribed again on the CPU and the transcript says so. (#219, #234, #235, #236)
- **A recording comes first.** Starting a recording pauses the transcription of an earlier meeting,
  so the live transcript starts at once; the earlier one goes back in line. (#233)

#### Meeting digest and context updates

- **A meeting digest.** Import gets **Add to the meeting digest**, and a built-in **Meeting digest**
  routine (working days at 18:00 by default) turns the queued meetings into one context update.
  There is one open digest at a time, with a limit on meetings and on text per digest, so long
  meetings are analyzed one by one instead of all at once. A meeting leaves the queue only once the
  digest is checked to hold it. Opt-in: a digest right after each meeting, and analyzing each new
  digest automatically. A recording goes with the queue once its transcript is in a digest, unless
  **Keep recordings after transcription** is on. (#155, #157, #160, #161, #162, #173)
- **Meeting records in context updates.** The analysis can add one record per meeting (attendees,
  decisions, open questions, action items), which you confirm or reject on its own. Confirmed
  records are kept by System cleanup. **Create task** on an action item opens the New task form
  filled in from it. (#145, #147)
- **Readable transcripts from meeting exports.** A WebVTT file (Teams, Zoom, Meet) or a Word document,
  such as a Teams transcript, added to a context update gets a readable text copy next to it, with
  every word and speaker label kept as written. (#149, #153)
- **Run analysis and Apply from the dashboard with Claude Code.** A ready context update gets **Run
  analysis with Claude Code**, an approved one **Apply with Claude Code**. They run the workspace's
  own `/gtd-context-analyze` and `/gtd-context-apply` with the installed Claude Code and your Claude
  plan, never an API key. Apply can write only the files you accepted. You see progress, can stop a
  run, and can continue an apply that stopped half way. (#151, #152)
- **Context updates are easier to find.** Filter by type, search by title or ID, and page through
  the history. Updates waiting for your review are shown at the top. (#171, #204)
- **A Kaizen is a context update.** After a rework, the note the agent writes opens as a context
  update, shows its root cause first, and is reviewed and applied like any other update. (#174)

#### Dashboard

- **Customize the sidebar.** Right click the sidebar, use **Customize sidebar** (shown at its
  bottom edge when you point at the sidebar), or go to **Settings → Appearance → Sidebar**. Drag
  items, or use the arrow buttons, to change their order inside a group, and hide the ones you never
  use. Hidden items stay one click away under **More**, which also shows their dots, so a broken
  routine is never hidden with its item. Situation and Settings are always shown. **Reset to
  default** brings the standard sidebar back. The order is saved in the workspace
  (`.situation-board/ui-preferences.json`), so it follows you between the browser, the desktop app
  and other computers, and items from future releases show up in their default place. (#200)
- **A picture for each workspace**, so you can tell them apart in the sidebar and the workspace
  switcher. Pick an image in Settings and crop it; it stays on this computer, outside the workspace
  folder. (#156)

### Changed

- **One look across the dashboard.** Every page now uses the same width, spacing, cards, buttons,
  fields, dialogs and messages, and works on a phone: task details, templates, settings and Context
  no longer squeeze or run off the screen. Deleting something asks in the app instead of a browser
  pop-up, and errors say what to do next. Muted, warning, success and info text and the edges of
  fields have more contrast, to meet WCAG AA in light and dark. The Meetings page and the
  **Record a meeting** dialog follow the same layout as the rest. (#237, #240)
- **The sidebar is grouped by job and ordered by how often you use it.** Your daily work comes
  first (Situation, Board, Meetings, Insights), then **Memory**, what the agents read before
  they write (Context, Stakeholders, Output templates), then **Automation**, what you set up
  once (Agents & Skills, Routines, Agent Floor when it is on). Profile and Settings stay at
  the bottom. In the collapsed sidebar the group headings become thin dividers. "Outputs" is
  now called "Output templates", like its page. (#199)
- **Workspaces keep their agent files up to date.** Each time a workspace opens in the dashboard or
  the desktop app, it gets this version's agent instructions and commands, as `gtd upgrade` does.
  Files you edited yourself are kept. (#198)
- **The Claude Code agents use the latest Opus.** The four agents in a workspace now use `opus`,
  which Claude Code resolves to the newest Opus model (Opus 5.5 today). (#237)
- **Deleting a context update moves it to the trash** (`.situation-board/trash/`) instead of erasing
  it, so a digest's recordings, transcripts and speaker names can still be got back. The confirmation
  says when a digest holds the only copy. (#220)

### Removed

- **The separate Kaizen screen, its API and `/gtd-kaizen`.** Kaizen notes now open as context
  updates (see above), and `/kaizen` redirects to Context updates. Notes finished before this release
  stay in `kaizen/` and still count in Insights. `gtd upgrade` now removes files the app no longer
  ships, but only when they are still exactly as installed; a copy you changed is kept and listed.
  (#175)

### Fixed

- **Mac automatic updates.** Release files are uploaded under the names the update manifests use,
  and a release now fails if a manifest points to a file that is missing, so installed apps can
  always download the next version. (#148)
- **Uploaded files keep Japanese, Portuguese and other non-English names**, instead of turning them
  into underscores. (#223)
- **Errors show the server's message** instead of a bare "Error" or "Bad Request". (#221)
- **Settings > About shows the app's real version**, not "1.0.0". (#225)
- **A deleted context update's ID is never given out again**, so receipts and run history never
  describe a different update. (#226)
- **The meeting queue never stalls:** a live transcript that gets no audio for a minute lets go of
  the engine, a recording waiting for a missing model offers the model chosen now, and the next
  recording starts as soon as the engine is free. (#227)
- **A transcript without words is partial**, not "Complete", and Settings says when the chosen model
  lacks the chosen language. (#228)
- **Clearer wording** across Meetings, Transcription and Import, for example model names instead of
  IDs, seconds for short recordings, and a disabled **Delete** that says why. (#159, #222, #230)
- **The Context dot no longer stays after you delete an update.** Deleting, closing, approving or
  reopening a context update now refreshes the sidebar dot and "Waiting on you" at once, instead of
  waiting for the file watcher. When the live connection to the server drops and comes back, the
  dashboard reads everything again, so nothing that changed meanwhile stays out of date. (#202)
- **Stage and commit wait for a git lock that goes away** instead of failing with a 500. (#185)
- **System cleanup keeps your unsaved changes** when the Routines page refreshes, so a new schedule
  chosen before Preview is the one saved. (#241)
- For contributors: steadier timing in tests (#158, #163, #166, #172), the git lock test passes with
  commit signing on (#224), the packaged smoke test prints the server log when a check fails (#170),
  unsigned Mac builds on `main` pass again (#154), and the real-model CI job records a meeting
  offline all the way to one digest (#187). New checks: `npm run test:design` (in `npm test`) and
  `npm run test:visual`, see `docs/design-system.md` (#237). New dependency:
  `sherpa-onnx-node` 2.0.1 for offline transcription (#165).

## [0.7.0] - 2026-10-29

Get Things Done now comes as a **desktop app for Mac and Windows**: download it, open it, and a
short setup creates your workspace. Nothing else to install, no terminal. The browser version
(`gtd start`) works exactly as before and shares the same workspaces.

**Download** (below, under Assets):
- **Mac with Apple Silicon** (M1 and newer): `Get-Things-Done-0.7.0-arm64.dmg`
- **Mac with Intel**: `Get-Things-Done-0.7.0.dmg`
- **Windows 10/11**: `Get-Things-Done-Setup-0.7.0-unsigned-preview.exe` (see the note at the end)

The Mac apps are signed and notarized by Apple and update themselves from new releases.

### Added

- **Desktop app for Mac and Windows (preview).** The same server, dashboard and templates as
  `gtd start`, in an app that needs nothing else installed: no Node, no git, no terminal. It
  keeps running in the tray so routines run on schedule, opens web links in your browser and
  blocks everything else, and asks where to save downloads. Folder choices and "open the
  workspace folder" use the system dialogs. A portable git ships inside the app. (#128, #136, #137)
- **Installers built and tested in CI.** Mac (Apple Silicon and Intel: DMG and ZIP) and Windows
  (one-click, no admin rights). Each packaged app is started as a new user would, with an empty
  home folder and no git installed, and must set up a workspace, create a task and use its
  bundled git. (#139, #141)
- **Signed releases and automatic updates for the desktop app.** Version tags build signed and
  notarized Mac installers and attach them to the GitHub release; installed apps update
  themselves from GitHub Releases. Windows installers are attached as an unsigned preview, without
  auto-update, until Windows signing is set up. (#142)
- **First-run setup screen.** Until a workspace is open, the dashboard shows a short setup:
  create a new workspace or open an existing one, your name and role, and which AI assistants to
  prepare it for (installed ones are found and preselected). It works in the browser and in the
  desktop app, so `gtd init` is no longer the only way to start. Before, the dashboard only said
  "check that the backend is running". (#138)

### Changed

- **Search uses Node's built-in SQLite** (`node:sqlite`, Node 22.13 and newer) instead of the
  native `better-sqlite3` module, so there is nothing native to install or rebuild and the
  desktop app gets full-text search. On Node 20 search uses the in-memory scan, as before. (#140)
- **Git is optional on every computer.** Without a git program, git features are hidden, git
  routes answer `503` with a clear message, and Settings says git is not installed instead of
  showing it as active. New `git_installed` field in the workspace and git responses. (#126)
- Releases publish to npm only after the signed desktop installers are built, checked and attached
  to the release, so an npm version never appears without its installers. (#144)
- For contributors: `server/src/server.ts` exports `startServer()`, so any host (the CLI entry,
  the desktop app) runs the same server in-process; `gtd start` starts it with the Node that runs
  the CLI instead of the first `node` on PATH. (#125) Dependencies: Electron 45 (#129),
  TypeScript 7 for the desktop shell (#130), `@vitejs/plugin-react` 6 (#133), `@types/uuid` 11 (#135).

### Fixed

- **Security headers:** the dashboard is served with a Content Security Policy, and the local
  API has a generous rate limit. (#127)
- **Names with quotes** no longer break `workspace.yaml` or the profile (also from `gtd init`),
  and renaming a workspace keeps `$` characters as typed. (#138)
- **Windows:** the file watcher ignores `.git` folders, and "Open Claude Code" works for
  workspace folders with `&` or `%` in their name. (#124)

## [0.6.0] - 2026-10-28

### Added

- **System cleanup, a built-in routine.** It sits at the top of the Routines page and
  runs on the same triggers and lock as your routines (dashboard, `gtd routines run`).
  By default it runs every Monday at 09:00 and only suggests; it moves no file. (#116)
  - **Memory review:** scans context notes and stakeholders for likely duplicates,
    empty notes and notes not updated in 180 days, and opens a context update tagged
    `origin: system-cleanup`, `kind: memory-review`, shown with a **System cleanup**
    badge. `/gtd-context-analyze` then proposes merges, moves and removals. One review
    at a time; none in an empty workspace.
  - **File cleanup, opt-in per type:** finished tasks, archived tasks, finished context
    updates, closed kaizen proposals and the trash, each with its own age and action
    (archive, move to trash, delete permanently). Only finished items, counted from
    their own date; items without a trustworthy date, symlinks, tasks tagged `keep`
    and updates whose materials you kept are skipped. At most 200 items per run.
  - A preview in the settings dialog shows what a run would do, and turning on
    permanent deletion asks once with the count. Settings also has a "Cleanup and
    retention" summary that links here.
- **Context update proposals can remove a file.** The dashboard moves the target (a
  context note with its folder) to the trash after approval; agents never delete. When
  removals are all you accepted, approving finishes the update straight away. A removal
  is held back when another accepted change of the same update failed. (#116)
- **Prepare a meeting from a stakeholder's page.** A **Prepare meeting** button on a
  stakeholder's page (and in the org chart profile dialog) opens the New task form
  already filled in: a "Prepare: meeting with <name>" title, an objective to complete,
  the person as stakeholder, a Meeting brief output and the `meeting-prep` agent.
  Everything stays editable and nothing runs until you save. (#113)
- **Keep a context update's original files.** A "Keep the original files after this
  update finishes" option keeps the imported materials through apply, close and
  cleanup until you release them. Drafts in `proposals/` are still deleted. Backed by
  `PUT /api/context-updates/:id/keep-materials`. (#104)
- **Encrypted Office files are flagged up front.** Word, Excel and PowerPoint files
  protected by a sensitivity label or a password are detected on upload, in file
  lists, in the execution package and as a validation warning, instead of failing
  when an agent tries to read them. Nothing is decrypted; legacy `.doc/.xls/.ppt` and
  PDFs are not checked. (#106)

### Changed

- Dependencies: qs 6.17 (#114).
- For contributors: ESLint and Prettier with `npm run lint` in CI (#120), a reference
  for the local HTTP API in `docs/api.md` (#119), unit tests for task status and
  validation (#118). The README explains how Get Things Done differs from other AI
  memory tools and links the demo video (#105, #115).

### Fixed

- **The Claude Code write limits now apply.** The workspace settings used
  `Write(path)` rules, which Claude Code never matches, so agents could write to
  `.claude/`, `profile/` and `.schemas/` and edit stakeholders, context and outputs
  without asking. The rules are now `Edit(/folder/**)`. Run `gtd upgrade` to get
  them; an edited settings file gets the new version as `.new`. (#112)
- **A task whose file cannot be read is reported.** A `task.md` with broken
  frontmatter (for example a duplicated YAML key) was silently hidden from the board.
  Workspace validation now lists it as an error with the parser's message. (#103)
- `gtd init` and `gtd upgrade` no longer replace the `{{date}}` routine placeholder
  in scaffolded instructions with the current date. Workspaces already upgraded to
  0.5.0 are repaired by the next `gtd upgrade`. (#101)
- `gtd upgrade` no longer reports a JSON file as edited, or writes a `.new` copy, when
  it only differs in key order or layout. (#102)
- `npm run build` works on Windows without WSL. (#117)
- Cleanup rejects symlinks in parent directories and trash destinations, rechecks
  eligibility before removal, and preserves manually named trash entries. Unreadable
  settings and corrupt ID reservations stop destructive work. (#121)
- Context removals wait until every accepted merge or create is confirmed as applied
  or merged. (#121)
- Rejected kaizen retention starts at rejection, and status changes preserve quoted
  titles and extra frontmatter through the shared Markdown writer. (#121)
- Task dialogs trap keyboard focus. Stakeholder tabs survive browser Back, review
  status labels are consistent, and narrow windows keep navigation and content usable.
  (#121)
- Dashboard routes load on demand, and large memory comparisons yield to HTTP/SSE
  processing instead of blocking the server for the whole comparison. (#121)
- The workspace `.gitignore` now excludes `.situation-board/trash/`, as the README
  already said. `gtd upgrade` updates it unless you edited it. (#116)
- Ids of tasks and context updates removed by the cleanup stay reserved
  (`.situation-board/reserved-ids.json`), so a new task never reuses an id that old
  links, routine receipts or the run history still point at. (#116)
- The file watcher ignores the trash folder, so moving many files there does not
  flood the dashboard with refreshes. (#116)

## [0.5.0] - 2026-10-27

### Added

- **Routines put recurring tasks on the backlog.** A routine is a schedule plus a
  task template (`routines/RT-NNNN.md`). When it comes due, a task lands on the
  backlog with its title, objective, priority, stakeholders, outputs, type, context
  notes, preferred agent and a due date counted from the scheduled run. Schedules
  cover daily, weekly, monthly by date or by "first/last weekday", and every N days,
  weeks or months. Routines can be paused, or paused until a date. (#93)
  - Routines catch up when the computer was asleep or off: they are checked when the
    server starts, every minute while the dashboard runs, and on
    `gtd routines run` from a terminal or a system scheduler. Each routine decides
    what to do with missed runs: create only the latest (default), create all (at
    most 12), or skip. Late runs are marked "caught up" in the history.
  - No duplicates on one machine: a deleted task is not recreated, and the server
    and the CLI never run routines at the same time. With a workspace synced
    between machines, run the scheduler on one of them.
  - New **Routines** page with Run now, pause, edit, delete and run history, an
    editor with schedule presets and a preview of the next 5 runs, and a repeat
    icon on board cards for tasks a routine created.
  - New `gtd routines run` and `gtd routines list` commands.
- **Switch between recent workspaces from the sidebar.** The current workspace sits
  at the top of the sidebar with its name, a colored initial and the end of its
  path. Click it to switch to another workspace opened on this machine in one
  click, remove one from the list (the folder is never touched), or open another
  folder. The browser tab title names the workspace. Backed by
  `GET /api/workspace/recent` and `POST /api/workspace/recent/forget`. (#95)
- **"Waiting on you".** Nav items show a dot with a count when something needs you
  (tasks in Needs Review, context updates waiting on you, open kaizen proposals,
  failing routines, workspace validation errors): amber when it is your move, red
  when something is broken. Situation lists them in a "Waiting on you" panel. (#97)
- **Attach files when creating a task.** The New Task dialog has a Files drop zone.
  If an upload fails, the task is still created and a warning lists the files. (#94)
- **Kaizen commands are easy to copy.** Every open proposal shows its
  `/gtd-kaizen ID` command with a Copy button, and with two or more open proposals
  an **Apply all** box copies one command with every open ID. (#98)

### Changed

- **Context updates make the next command hard to miss.** After approving, the
  page scrolls to the apply command and focuses its Copy button. While an update
  waits on a command, a bar at the bottom shows the step with a **Copy command**
  button, and the status labels name the action ("Run the analyze command",
  "Approved: run the apply command"). (#96)
- **The task objective saves with the task.** The Objective section no longer has
  its own Save: "Save changes" in the header saves everything, and the inline links
  are now Done and Discard. (#94)
- **Agent instructions** (Claude Code, Codex, Copilot) and workspace scaffolding
  cover routines: a new `routines/` folder, a `routine.schema.json` schema, and
  `routine_ref` / `routine_occurrence` in the task schema. `/gtd-kaizen` in Claude
  Code now takes several IDs, applies them in order and stops to ask when two
  proposals clash. Run `gtd upgrade` in an existing workspace to get them; an
  edited file gets the new version as `.new`. (#93, #98)
- Search and task filtering include the task objective (the Markdown body). (#99)
- On Node 20, search uses the built-in JavaScript fallback instead of the native
  SQLite module, which needs Node 22 or newer and could crash. (#99)
- Dependencies: Vite 8 (#92), react-markdown 10 (#91), uuid 14 (#88),
  concurrently 10 (#90), `@types/better-sqlite3` 9 (#89).

### Fixed

- **Creating a task keeps all its fields.** Contexts, task type, confidentiality,
  preferred agent, review date, estimated hours and slug were dropped on create
  (they were kept on update). (#78)
- **Tasks created at the same moment no longer overwrite each other**, for example
  a routine and a manual create getting the same task ID. (#99)
- **Switching workspace mid-operation stays safe.** A task, routine run or search
  in progress finishes in the workspace it started in, instead of writing to or
  reading from the new one. After a switch, the dashboard opens Situation instead
  of a detail page that does not exist in the new workspace. (#99)
- A routine with invalid markers no longer leaves an empty task folder behind. (#99)
- The Kaizen page updates when an agent changes a proposal, and shows an error
  when a rejection fails. (#99)

## [0.4.0] - 2026-10-25

### Added

- **Context updates.** Import meeting transcripts, decks, photos, spreadsheets or any
  file under Context > Import & review. `/gtd-context-analyze` proposes only the
  context and stakeholder changes that matter, each with a reason, evidence and
  confidence, plus what it left out and why. Review each proposal as a diff, accept
  or reject it individually, approve, and `/gtd-context-apply` writes only what you
  accepted. Finished updates keep their record and delete the materials. Codex and
  Copilot get the same steps in their workspace instructions. Updates live in a new
  `context-updates/` folder that task agents do not read as context. (#73, #74)
- **Activity calendar on Insights.** A heatmap of how busy each day was, following
  the 7 / 30 / 90 days / All time filter: an hour-by-day grid for 7 days, a month
  grid for 30, small month calendars for 90 and one strip per year for all time.
  Switch between activity, completed, created and agent runs, hover a day for the
  breakdown, click it for the tasks and stakeholders involved. Callouts name the
  busiest day, weekday and month and the longest streak. Fully keyboard
  accessible. Backed by new `GET /api/insights/calendar` and
  `GET /api/insights/calendar/day/:date` endpoints. (#70, #71, #72)
- **Open a person's profile from the org chart.** Clicking a name or avatar on a card
  opens their profile in a dialog over the chart, with "Open full page". (#67)
- Subfolders in a template's or note's file list start collapsed, showing their file
  count. (#63)

### Changed

- **Agent instructions** (Claude Code, Codex, Copilot) and workspace scaffolding
  cover context updates: new `/gtd-context-analyze` and `/gtd-context-apply`
  commands, a `context-update.schema.json` schema, and Claude Code may write to
  `context-updates/**`. Run `gtd upgrade` in an existing workspace to get them; an
  edited `CLAUDE.md` or `settings.json` gets the new version as `.new`. (#74)
- Dialogs keep focus inside while open, return it on close, and only the topmost
  dialog closes on Escape. Org chart card shortcuts act only when the card itself
  has focus. (#67)
- Dependencies: multer 2.x (#64), React Router 7 (#69), body-parser 1.20.9 with a
  security fix (#68).

### Fixed

- **Insights now counts archived tasks**, so numbers go up for workspaces with
  archived work, and "All time" no longer starts in 1970 because of run logs
  without a timestamp. (#71)
- The stakeholder page lists only that person's tasks (it listed every task), and
  its task links open the task instead of "Task not found". (#66)
- Org chart card menus: Enter opens the menu and Delete inside it no longer removes
  the person. (#67)
- A cancelled upload is no longer logged as a server error, and a file of exactly
  the size limit is accepted. (#64)
- The Codex `AGENTS.md` no longer adds a second full stop after an organization
  name that ends with one (for example "Example Inc."). (#65)
- Context updates: concurrent uploads with the same name no longer replace each
  other, concurrent review saves no longer overwrite each other's decisions, and
  impossible dates such as `2026-02-30` are rejected. (#75)

## [0.3.0] - 2026-10-23

### Security

- Disable executable Markdown frontmatter and enforce a shared data-only parser. (#59)
- Reject untrusted local HTTP hosts/origins and request-derived path traversal;
  confine file downloads by real path and sandbox workspace document previews. (#59)
- Protect entity metadata from attachment uploads and case-insensitive deletion. (#59)

### Added

- **Bigger org charts are easier to work with.** Expand to a chosen level or
  collapse all (charts with more than 15 people open at two levels), full screen,
  zoom, fit and pan, and **Find in chart** by name, role, unit or id. The Add people
  panel is hidden by default and a "+" on the selected card adds a direct report.
  The chart list can collapse to a thin rail. These choices are remembered per
  chart. (#40, #41, #42, #43)
- **Org chart titles.** A person can have a title that applies to one chart only,
  without changing their profile role. (#44)
- **Org chart units.** Optional departments and teams, with a Units view to create,
  nest and assign people by drag and drop. Units are membership only: people still
  report to people. (#45)
- **Org chart placeholders** for vacant roles or people who are not stakeholders
  yet. A placeholder can later become a new stakeholder or be linked to an
  existing one. (#46)
- **Files attached to templates and context notes** can be opened in the browser
  or downloaded, files in subfolders are listed, and **Download all (.zip)**
  downloads the whole folder. The template section "Example Files" is now
  "Files". (#47, #48, #49)
- **Recent activity** shows the item's title and its folder, instead of a list of
  identical `task.md` / `note.md` names. The API adds `path` and `title`; `filename`
  is kept. (#58)
- The Situation screen and the header adapt to narrow windows, and Upcoming
  commitments can be opened with the keyboard. (#51, #55)
- Server boundary regressions, a parser import check, blocking high/critical
  dependency audits, and architecture/contributor guidance for future changes. (#59)

### Changed

- **Org chart schema and agent instructions** (Claude Code, Codex, Copilot) cover
  chart titles, units and placeholders. Charts that use them are saved as
  `schema_version` 1.1; other charts stay 1.0. Run `gtd upgrade` in an existing
  workspace to get the new instructions and schema. (#44, #45, #46)
- Org chart saves reject a stakeholder id that is new to the chart and does not
  exist (400). Ids already in a chart stay editable. (#44)

### Fixed

- Saving an org chart no longer drops member fields, and deleting a stakeholder
  keeps the other members' fields. (#44)
- Removing an attached file named with a folder (such as `assets/logo.png`) is
  refused instead of removing a top-level file with the same name. (#48)
- **Download all** never leaves files out silently: the ZIP covers the whole folder
  or is refused with a clear message. (#60)
- Files the app cannot remove no longer show a Remove button, and upload and
  remove errors are readable instead of raw JSON. (#61)
- Content no longer runs off the screen on narrow windows: the Situation side
  column, Skills table actions, a long workspace path in Settings, Agents cards and
  the Context toolbar. (#50, #52, #53, #54)
- Prevent concurrent writes from sharing temporary files, clean up failed writes,
  and avoid backup/trash filename collisions. (#59)
- Preserve malformed/oversized request status codes and hide unexpected error
  details. (#59)
- Prevent cancelled UI requests from changing the active request's loading
  state. (#59)

### Project

- Contributor and AI agent guidance for keeping pull requests independent
  (`AGENTS.md`, `CLAUDE.md`). (#56)

## [0.2.0] - 2026-10-22

### Added

- **Org charts.** A new **Stakeholders → Org charts** tab maps who reports to whom,
  one chart per company or organization. Drag a card onto someone to make them the
  manager, or use the card menu. Charts have a chart view and an outline view, a
  panel to add people (the chart's organization first), and can start with everyone
  from an organization. Reporting loops are blocked. Charts are stored in
  `stakeholders/org-charts/` with a new `org-chart.schema.json`. A stakeholder's page
  shows who they report to, their direct reports and their peers. (#35, #36)
- **@ mentions in tasks.** Typing `@` in a task's Objective opens a picker across
  stakeholders, output templates, context notes and tasks (including archived ones),
  with tabs per type. The choice is saved as a plain Markdown link and shown as a chip.
  Mentioned files are always added to the execution package, on top of the normal
  context loading, which is unchanged for tasks without mentions. Works with Japanese,
  Chinese and Korean input. Validation warns about mentions of files that no longer
  exist. (#31, #32, #34, #37)
- **Change the workspace folder from Settings.** The Change button opens a folder
  picker, offers to initialize a folder that is not a workspace yet, and switches
  without restarting the server. (#29, #30)
- Markdown fields render as Markdown, and edit boxes get Write / Preview tabs. (#25)
- Board cards and the list view show the task ID, and board search matches it. (#33)
- Hovering a stakeholder's avatar shows their role. (#28)

### Changed

- **Agent instructions** (Claude Code, Codex, Copilot): agents always read files
  mentioned with `@`, and read the org charts of every task stakeholder to decide who
  approves, what level to pitch at, the escalation path and who to keep informed. The
  execution package also includes those org charts. Run `gtd upgrade` in an existing
  workspace to get the new instructions and schema.
- **Server upgraded to Express 5.** `express-async-errors` is no longer needed and was
  removed. (#18)
- Dependencies: better-sqlite3 13 (#22), Vite 6 (#27).

### Fixed

- Stakeholder groups (`GRP-NNNN`) no longer fail workspace validation, and a stale
  `done_date` is cleared when a task leaves Done. (#26)
- Workspace files under dot-folders (such as `.claude/`) and the dashboard installed
  under a dot-folder (such as `~/.nvm/`) are served correctly. (#18)

## [0.1.2] - 2026-10-21

### Fixed

- Workspace validation no longer flags tasks the app itself edited: `in_review` and
  `approved` statuses and full timestamps in `start_date` / `done_date` are accepted,
  and a task is no longer "overdue" on its own due date. (#1)
- Board cards show the stakeholder's real initials and name instead of "S" for every
  person. (#1)
- Dropping a card into a column sets that column's own status (In Progress no longer
  becomes Blocked, Done no longer becomes Approved), and dropping within the same
  column keeps the status. (#1)
- Workspace schemas match what the app writes; added a kaizen schema. (#1)
- The context-researcher agent can write context notes; file paths are
  workspace-relative. (#1)
- Situation view shows stakeholder names on avatars and the real task type in
  Upcoming commitments (it always said `ad_hoc`).
- The page header shows "Agent Floor" and "Kaizen" instead of "App".
- Two-letter initials fit inside small avatars and stay readable when stacked.
- Unknown `/api/*` paths return a JSON 404 instead of the dashboard HTML.

### Changed

- **Dependencies upgraded:** simple-git 4, chokidar 5, helmet 8, tsx, and GitHub
  Actions checkout and setup-node v7 (Dependabot #10, #11, #12, #13, #14, #16),
  ora 9 (#19) and open 11 (#20).
  Clears every critical and high advisory in production dependencies. The file
  watcher was ported to chokidar 5, which no longer supports glob patterns; without
  that change live updates in the dashboard would have stopped silently.
- **Minimum Node.js is now 20.19.** The CLI loads ESM-only packages (chalk, ora,
  open), which older versions cannot `require()`, so `gtd` already failed on Node 18
  and Node 20 before 20.19 even though `engines` said `>=18`. The `engines` field and
  docs now state the real requirement.
- The stakeholder-communication skill template uses generic wording for Japanese
  business conventions.
- Dependencies refreshed with non-breaking security updates.

### Project

- Smoke test now also covers live updates over SSE and the git integration
  (status, stage, commit, log).
- CI fixed: the tarball check failed because `npm pack` re-ran the build and its
  output corrupted the JSON. CI now tests on Node 20.19 (the minimum), 22 and 24, runs unit and
  end-to-end smoke tests, and reports dependency advisories.
- Release workflow: protected `npm` environment, npm provenance, trusted publishing
  support, skips versions already on npm, and creates the GitHub release from this
  changelog.
- Added README screenshots from a fictional demo workspace, `npm run seed:demo`,
  CONTRIBUTING, Code of Conduct, Security policy, issue and PR templates, Dependabot.
- Removed the `prepare` script so `npm install` no longer runs a full build.

## [0.1.1] - 2026-10-16

First public release on npm as
[`@bertonha/getthingsdone`](https://www.npmjs.com/package/@bertonha/getthingsdone).

### Added

- `gtd` CLI: `init`, `start`, `stop`, `open`, `status`, `upgrade`, `use`. The old
  `esb` command still works as an alias.
- Local dashboard on `127.0.0.1`: Situation, Board (kanban, list, archive),
  Stakeholders, Outputs, Context, Agents & Skills, Insights, Kaizen, optional Agent
  Floor, Profile and Settings with light and dark themes.
- Workspace as plain Markdown with YAML frontmatter: profile, stakeholders, context
  library, output templates and tasks, with JSON schemas.
- AI agent setup for Claude Code (agents, skills, `/gtd-task` and `/gtd-kaizen`
  commands), GitHub Copilot and OpenAI Codex.
- Full-text search, live updates from a file watcher, optional git integration.

[Unreleased]: https://github.com/geovanneb/get-things-done/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/geovanneb/get-things-done/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/geovanneb/get-things-done/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/geovanneb/get-things-done/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/geovanneb/get-things-done/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/geovanneb/get-things-done/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/geovanneb/get-things-done/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/geovanneb/get-things-done/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/geovanneb/get-things-done/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/geovanneb/get-things-done/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/geovanneb/get-things-done/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/geovanneb/get-things-done/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/geovanneb/get-things-done/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/geovanneb/get-things-done/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/geovanneb/get-things-done/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/geovanneb/get-things-done/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/geovanneb/get-things-done/releases/tag/v0.1.1
