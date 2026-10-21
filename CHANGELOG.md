# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/). While the version is `0.x`,
minor versions may include breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/geovanneb/get-things-done/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/geovanneb/get-things-done/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/geovanneb/get-things-done/releases/tag/v0.1.1
