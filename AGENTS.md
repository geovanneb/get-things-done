# Instructions for AI coding agents

This file is for AI agents (Codex, Claude Code, Copilot and others) working on this
repository. The same rules for people are in [CONTRIBUTING.md](CONTRIBUTING.md), which
is the source of truth when the two differ.

**Read in this order:** this file, then `CONTRIBUTING.md`, then `AGENTS.local.md` or
`CLAUDE.local.md` if one exists. Those two are personal notes for one clone (a fork,
local ports, how that person works). They are git-ignored by default; never commit them.

## The project in one paragraph

Get Things Done is a local CLI, an Express API and a React dashboard over a folder of
Markdown files (the "workspace"). `src/cli/` is the `gtd` command, `server/` the API and
file watcher, `ui/` the dashboard, `templates/` everything scaffolded into a user's
workspace, `scripts/` the demo seed and the smoke test.
`server/src/services/scaffold.ts` creates and upgrades workspaces.

## Branches and pull requests

The maintainer **squash-merges**, so the original commits of a merged PR are not on
`main`. A branch that still carries them can show already-merged changes or conflict.

- **Start every PR from the latest `main`** (`git fetch upstream`,
  `git checkout -b <type>/<short-name> upstream/main`), even while other PRs are open.
  Do not start a branch from another unmerged branch just for convenience.
- **One logical change per PR**, reviewable and mergeable on its own.
- **Don't add to the same spot in a file as another open PR** (for example both
  appending CSS at the end of `ui/src/index.css`, or both adding smoke checks at the same
  place in `scripts/smoke-test.mjs`). Put each change next to the code it belongs to.
- **When the change needs an unmerged PR** (its code or its behaviour): prefer waiting
  until that PR is merged. Otherwise branch from it, record the parent's tip
  (`git rev-parse <parent-branch>`), open the PR as a **draft** and write
  "Depends on #N, please merge that first." After #N is merged:
  `git rebase --onto upstream/main <recorded-parent-tip> <your-branch>`, compare with
  `git range-diff`, run the checks, push with `--force-with-lease`, remove the
  "Depends on" line, and mark the PR ready only when CI passed on that push and GitHub
  shows no conflicts. In a chain, move the next PR onto the rewritten one straight away
  and keep it a draft.
- If the maintainer changed the parent before merging it, check your change against what
  actually landed, not against the old parent.
- PR titles follow Conventional Commits (`feat(ui): …`, `fix: …`); they become the commit
  on `main`. Fill in `.github/PULL_REQUEST_TEMPLATE.md`.

## Before you open or update a PR

- `npm run build` and `npm test` must pass. CI also runs Node 20, 22 and 24 and checks
  the package contents. Add or update smoke checks for behaviour changes.
- Use fictional data only (the demo workspace in `scripts/seed-demo.mjs`). Never put real
  workspace content, real people or company names into code, tests, screenshots, commits
  or PR text.
- Files under `templates/` end up in users' workspaces: keep them generic, and change the
  agent instructions for all of `templates/ai/claude-code/`, `codex/` and `copilot/`
  together.
- Match the surrounding code: inline styles with the design tokens (`var(--color-…)`,
  `var(--text-…)`), small components, comments only where they explain why.

## Architecture and regression harness

Follow [CONTRIBUTING.md](CONTRIBUTING.md#architecture-and-regression-rules) and
[docs/architecture.md](docs/architecture.md) for boundary changes. In particular:

- Use the data-only Markdown wrapper, contained file resolver, sandboxed file sender,
  protected attachment saver and unique temporary-file writer. Do not bypass them
  in new services or routes.
- Validate path components at service boundaries, including values from JSON bodies;
  TypeScript types do not validate requests at runtime.
- Add failing-before regressions for security and persistence fixes, using temporary
  fictional workspaces. Preserve `test:harness` and the blocking dependency audit.
- Do not describe an atomic file replacement as preventing concurrent lost updates.
  Document remaining risks and the checks actually run.
