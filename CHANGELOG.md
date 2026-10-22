# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/). While the version is `0.x`,
minor versions may include breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/geovanneb/get-things-done/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/geovanneb/get-things-done/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/geovanneb/get-things-done/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/geovanneb/get-things-done/releases/tag/v0.1.1
