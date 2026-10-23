# Contributing to Get Things Done

Thanks for taking the time to help. Bug reports, docs fixes, new templates and code
are all welcome. You do not need to be an expert: if something confused you, that is
worth an issue.

## Ground rules

- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Never paste real workspace content into an issue, PR, screenshot or test. A
  workspace holds stakeholder names and private notes. Use made-up data, like the
  demo workspace in `scripts/seed-demo.mjs`.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## How we work (GitHub Flow)

`main` is always releasable. All work happens on short-lived branches and lands
through pull requests.

1. **Open or pick an issue** for anything bigger than a small fix, so we can agree on
   the approach before you write code. Issues labelled `good first issue` are a
   good place to start.
2. **Fork the repo** and create a branch from `main`:
   - `fix/<short-description>` for bug fixes
   - `feat/<short-description>` for new features
   - `docs/<short-description>` for documentation
   - `chore/<short-description>` for tooling and dependencies
3. **Make your change** with tests where it makes sense.
4. **Open a pull request** against `main`. Fill in the template and link the issue
   (`Fixes #123`).
5. **CI must pass** and a maintainer reviews. We squash-merge, so the PR title becomes
   the commit message.

Releases are cut from `main` by a maintainer pushing a version tag. You do not need
to bump the version in your PR.

## Keeping pull requests independent

We squash-merge: the commits on your branch become one new commit on `main`, and the
original commits are not on `main`. A branch that still carries them can show changes
that are already merged, or conflict. These habits keep each PR easy to merge.

### Set up your fork once

```bash
git remote -v          # origin = your fork
git remote add upstream https://github.com/geovanneb/get-things-done.git
```

`origin` is your fork (you push there). `upstream` is this repository (you start new
branches from it).

### Start every PR from the latest main

Even while your other PRs are still open, start each new one from `upstream/main`, next
to the others rather than on top of them:

```bash
git fetch upstream
git checkout -b feat/my-change upstream/main
```

- **One logical change per PR**, so it can be reviewed and merged on its own.
- **Don't add to the same spot as your other open PRs.** If two PRs both append to the
  end of `ui/src/index.css`, or both add smoke checks in the same place in
  `scripts/smoke-test.mjs`, they are likely to conflict once one is merged. Put each
  change next to the code it belongs to. This lowers the risk; it does not remove it.

### When a change needs another PR that isn't merged yet

A depends on nothing; B needs A's code or behaviour. Two options:

- **Wait (easiest).** Finish A, open its PR and work on something else. When A is
  merged, fetch `upstream` and start B from the new `main`.
- **Build on A, and move B onto main after A is merged.**
  1. Create B from A's branch and **note the commit you started from**:

     ```bash
     git checkout -b feat/b feat/a
     git rev-parse feat/a      # write this down, e.g. in a comment on B's PR
     ```

  2. Open B as a **draft** and write in its description:
     **"Depends on #A, please merge that first."**
  3. When A is merged, replay only B's own commits onto the new `main`, using the commit
     you noted (not the branch name, which may have moved or been deleted):

     ```bash
     git fetch upstream
     git rebase --onto upstream/main <noted-commit> feat/b
     git range-diff <noted-commit>..origin/feat/b upstream/main..feat/b   # B's changes only?
     npm run build && npm test
     git push --force-with-lease origin feat/b
     ```

     If the maintainer changed A before merging it, check B against what actually landed.
  4. Remove the "Depends on" line. When CI has passed on this push and GitHub shows no
     conflicts with `main`, mark B as ready for review.

**Chains (A, then B, then C).** When A is merged, move B onto `main` as above, and move C
onto the new B straight away (`git rebase --onto feat/b <B's old tip> feat/c`, noting B's
old tip first). C stays a draft until B is merged. Keep the old branches until every PR
that depends on them has been moved.

### Before you mark a PR as ready

- GitHub shows no conflicts with the current `main`.
- CI passed on your latest push. Marking a draft as ready does not run CI again, and a
  green check from an older push says nothing about today's `main`.
- The diff contains only this change, and any dependency on another PR is stated.

## Commit and PR titles

We use [Conventional Commits](https://www.conventionalcommits.org/) for PR titles,
because they become the commit on `main` and feed the release notes:

```
fix(board): keep blocked status when dropping in the same column
feat(cli): add --port to gtd open
docs: explain workspace upgrades
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

## Development setup

You need Node.js 20.19 or newer (22 recommended, see `.nvmrc`) and npm.

```bash
git clone https://github.com/<you>/get-things-done.git
cd get-things-done
npm install
npm run dev          # API on :3001, Vite UI on :5173
```

Before you push:

```bash
npm run build        # type-checks and builds CLI, server and UI
npm test             # unit tests + end-to-end smoke test
```

The smoke test creates a throwaway workspace in a temp folder with its own HOME,
starts the built server, seeds fictional data and checks the API. It never touches
your own config or workspaces.

### Seeing a populated dashboard

```bash
node bin/gtd.js init -y -d /tmp/gtd-demo --name "Alex Morgan" --role COO --org "Northwind Labs"
cd /tmp/gtd-demo && node /path/to/get-things-done/bin/gtd.js start --no-open
npm run seed:demo -- http://127.0.0.1:3001
```

### Where things live

| Path | What it is |
|---|---|
| `src/cli/` | The `gtd` command |
| `server/` | Express API over the workspace files, file watcher, SSE |
| `ui/` | React + Vite dashboard |
| `templates/` | Everything scaffolded into a new workspace (AI agent setup, schemas, output templates) |
| `scripts/` | Demo seed and smoke test |

`server/src/services/scaffold.ts` is the single source of truth for creating and
upgrading workspaces. Change workspace structure there, not in the CLI.

## Changes to workspace templates

Files under `templates/` end up in users' workspaces. If you change them:

- Keep them generic. No company names, people or internal jargon.
- Think about `gtd upgrade`: existing users get the new version of app-owned files.
- Mention the change in the PR so it lands in the changelog.

## Updating screenshots

Screenshots in `docs/screenshots/` come from the demo workspace. If your change
alters the UI noticeably, regenerate the affected ones from seeded data only, at
1440x900, and keep them under about 500 KB each.

## Questions

Open a [discussion](https://github.com/geovanneb/get-things-done/discussions) or an
issue. There are no silly questions.
