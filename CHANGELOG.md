# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/). While the version is `0.x`,
minor versions may include breaking changes.

## [Unreleased]

## [0.8.0] - 2026-11-01

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

[Unreleased]: https://github.com/geovanneb/get-things-done/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/geovanneb/get-things-done/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/geovanneb/get-things-done/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/geovanneb/get-things-done/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/geovanneb/get-things-done/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/geovanneb/get-things-done/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/geovanneb/get-things-done/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/geovanneb/get-things-done/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/geovanneb/get-things-done/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/geovanneb/get-things-done/releases/tag/v0.1.1
