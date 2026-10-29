# Phase 1 desktop audit — 2026-10-29

Phase 1 is **not release-complete**. The code and local regression checks are substantially
complete, but the signing accounts are not configured and signed installation/update acceptance
has not been exercised. Do not close the Phase 1 section of #123 on the strength of unsigned builds.

Scope: upstream main `607787a`, PR #141, and the unfinished `ci/desktop-release` working tree.
The shared CLI/server/dashboard remain the implementation in both browser and desktop modes.

## Requirement status

| #123 requirement | Evidence / remaining gate |
| --- | --- |
| Windows watcher and agent launch | #124 merged; server regressions included in full suite |
| Shared server lifecycle | #125 and #127 merged; built-package smoke and desktop server exit checks |
| Optional Git | #126 merged; missing/system/custom Git regressions |
| Built-in SQLite search | #140 merged; full suite on Node 20.19.0 (fallback), 22 and 24 |
| Electron shell / tray | #128 merged; packaged Apple Silicon app starts and serves dashboard |
| Native bridge / links / downloads | #136 merged; bridge and link tests; native OS dialog interactions still require platform acceptance |
| Bundled Git | #137 merged; Apple Silicon packaged stage test passes; Windows packaged CI passes on #141 head `34906f0` |
| Shared welcome wizard | #138 merged; setup regressions and packaged workspace creation |
| Packaging | #139 merged; local Mac app, installer build and CI packaging workflow |
| Task creation in packaged smoke | #141 open; task POST, board GET, status checks and isolated HOME/port |
| Signed release / auto-update | Draft PR #142 implements plumbing; signing accounts and real signed install/update tests remain required |
| Intel Mac support | Added native Intel runner alongside Apple Silicon and Windows x64; requires CI result |
| Browser compatibility | Complete package smoke suite plus 13 Playwright checks on fictional data |

The plan also mentions optional launch-at-login behavior. The current tray keeps routines running
while the app is open, but there is no login-start preference. This remains outside the enumerated
Phase 1 work items and must not be advertised as implemented.

## Findings corrected in this work

- The unfinished desktop workflow had no caller from the tag-release workflow.
- Job-level environment expressions referenced `runner`, which GitHub Actions does not allow there.
- Missing signing credentials could previously yield a successful release with no installers.
  Release jobs now fail instead; ordinary PR/main/manual builds remain unsigned.
- Only Apple Silicon was packaged for Mac. Intel has its own native runner, and ARM uses a separate
  update channel to prevent two Mac manifests overwriting one another during artifact merge.
- Unsigned packaged apps could check for updates despite the comment promising otherwise. Only a
  signed-release metadata flag enables checks; development and smoke-test modes remain disabled.
- `quitAndInstall` can close windows/start installation before `before-quit`. Restart now waits for
  server shutdown (including exit after a forced kill) and coalesces repeated requests. Channel selection no longer enables downgrades.
- The updater's background download has a separate promise. Failures from both the check and the
  download are consumed and logged, as are dialog failures.
- The packaged smoke test scanned the normal app ports. PR #141 now uses an ephemeral saved port,
  verifies the exact fictional home path before writing, and reports Git HTTP status/body on failure.
- The unfinished browser script failed lint and assumed Escape should close a dialog while typing.
  Its check now focuses the Close button first, preserving the intended unsaved-edit protection.

## Validation

All fixtures are fictional and all API/browser tests use temporary workspaces.

| Check | Local result |
| --- | --- |
| Root build | Pass on Node 22 and 26 |
| Full `npm test` | Pass on Node 20.19.0, 22, 24 and 26; parser boundary, 150 server tests, UI suites and package smoke |
| Desktop build | Pass |
| Desktop unit tests | Eleven pass, including unsigned-update policy, shutdown ordering/retry and failed downloads |
| Lint | Zero errors; 16 existing warnings |
| Production dependency audit | Zero vulnerabilities |
| Desktop dependency audit including Electron | Zero vulnerabilities |
| Package contents | 354 files; required entry points/templates present, desktop/tests/workspaces excluded |
| Workflow validation | `actionlint` passes for desktop and release workflows (external shellcheck disabled) |
| Packaged Apple Silicon smoke | Nine checks pass with #141 changes: first run, setup, dashboard, task creation/readback, bundled Git and server exit |
| Browser regression | 13 checks pass; cleanup, meeting prep, keyboard focus, context import retention, Insights windows, org-chart history, responsive captures and dark mode; zero JavaScript errors |

The 390px board and 1440px dark-mode screenshots were visually inspected. Narrow board columns
scroll horizontally; these screenshots are not a claim of exhaustive visual or accessibility coverage.
The forced-shutdown regression fails against the previous resolve-immediately-after-kill behavior and passes with the exit-event wait.
No private workspace or screenshot is included in the repository.

## PR review and remaining gates

[#141](https://github.com/geovanneb/get-things-done/pull/141) originally passed Node 20/22/24,
Mac packaging, dependency audit and CodeQL, but failed Windows packaging at bundled-Git staging.
Its task-creation check passed. The initial log only showed an empty staged list, so it did not
establish a root cause. The updated smoke test preserves the assertion and exposes the response
and full status rather than retrying or weakening the check. All ten checks, including Windows and Mac packaging, passed on updated head `34906f0`. The original failure did not recur; its underlying cause was not established.

The other open PRs at audit start were dependency updates #131, #132 and #134. They are not
Phase 1 dependencies. In particular, #134's Chokidar 6 update requires Node 22.22+, conflicting
with the project's Node 20.19 support; do not merge it as part of this phase without a separate
compatibility decision. #131 and #132 likewise need their own engine/type compatibility review.

Before marking Phase 1 complete:

1. Merge reviewed changes only after CI on their final commits passes; keep #141 and release
   plumbing independently reviewable. Neither PR requires the other's source changes.
2. Configure the Apple account and repository secrets described in `desktop/README.md`. Windows: Azure Trusted Signing is not available to individuals in Japan; SignPath Foundation was chosen. Until it is approved, releases attach the Windows installer as an unsigned preview without auto-update. SignPath's free program needs a manual approval for every signing request, so Windows signing is never unattended.
3. Run a signed tag release, verify all installer signatures/notarization and update manifests.
4. Install on clean Apple Silicon and Intel Macs and Windows 10/11; reach setup and a working
   dashboard without extra runtimes. Confirm the actual Gatekeeper/SmartScreen experience.
5. Upgrade between two signed versions on each platform, both Restart now and Later/quit, while
   preserving workspace data and confirming the previous server exits. Exercise offline checks.
6. Manually verify native folder selection, folder opening, downloads, external links, tray reopen
   and quit on Mac and Windows. API smoke checks do not exercise every native interaction.

This is a source audit and regression pass, not a guarantee that every defect is absent. No
signing credentials, release tags or published installers were created during this audit.

## Reproduce the browser regression

Install Playwright outside the repository (for example `npm install --prefix /tmp/gtd-browser-tools
playwright`, then `/tmp/gtd-browser-tools/node_modules/.bin/playwright install chromium`). Create a
fresh temporary HOME and workspace with `gtd init -y -d <temporary-workspace>`, selecting all three
AI integrations so meeting-prep is present. Start `dist/server/index.js` with that HOME, a free `PORT`
and `ESB_UI_PATH` pointing to the built `dist/ui`. Seed it with
`node scripts/seed-demo.mjs http://127.0.0.1:<port>`.

Run with `NODE_PATH=/tmp/gtd-browser-tools/node_modules`, `GTD_TEST_URL` pointing to that server and
`GTD_TEST_WORKSPACE` equal to its temporary workspace path:

```sh
node scripts/release-browser-check.mjs
```

`GTD_TEST_ARTIFACTS` optionally selects an output folder; otherwise a temporary one is created.
Keep the browser process's ordinary HOME (or set `PLAYWRIGHT_BROWSERS_PATH`) so it can locate its
browser binaries. Stop the temporary server afterward. Never run the mutating seed or browser
script against a personal workspace.
