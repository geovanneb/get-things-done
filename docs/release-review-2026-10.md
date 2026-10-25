# Release regression review — 25 October 2026

## Scope and result

Reviewed `v0.3.0` (`b0fa91d`) through `upstream/main` (`b57e0d4`): ten
commits, 64 changed files. The latest published GitHub release was confirmed as
`v0.3.0`; no open PRs were listed at review time. This branch addresses context
update persistence and input validation, without changing the package version.

The existing build and tests passed before this review. Three additional
regressions failed against the unchanged implementation and pass with the fixes:

| Priority | Reproduced defect | Correction |
| --- | --- | --- |
| High | Concurrent uploads named `meeting.txt` selected the same destination and replaced one another | Serialize filename reservation, attachment write and inventory update per context update |
| High | Concurrent review saves overwrote another proposal's decision; approval could race a save | Serialize read-modify-write operations and status transitions per context update, shared across service instances |
| Medium | Impossible dates such as `2026-02-30` were accepted | Round-trip the date and reject normalized dates before creating or changing files |

The queue is keyed by the absolute update directory, releases after rejected
operations, and removes idle entries. Detail reads join the queue because they
can clean up completed updates. Different updates remain independent. Existing
Markdown, attachment and atomic-write boundaries are retained.

This is process-local ordering of service operations, not a filesystem transaction
or a cross-process lock. External agent/editor writes, workspace switches during
in-flight requests, and network arrival order still require coordination. Atomic
replacement alone does not prevent lost updates. Other domain services were not
converted to use this queue.

## Coverage

| Area | Evidence |
| --- | --- |
| Context imports and review | Service and built API tests for material persistence, duplicate names, concurrent decisions, approval, rejection recovery, reopen, close, cleanup, target confinement and dates |
| Activity calendar and Insights | Source review and existing tests for local dates, DST, filter windows, archived tasks, execution timestamps, due dates, counts and day details |
| Stakeholders and organization charts | Source review of profile embedding/navigation and task filtering; smoke coverage and chart domain tests |
| Files and attachments | Existing traversal, symlink, protected metadata, ZIP completeness, nested grouping and upload error tests |
| CLI and workspace | Built CLI initialization, all three agent integrations, schema scaffolding and package smoke tests; source review of process lifecycle |
| Existing functionality | Smoke coverage for tasks, context, templates, search, mentions, execution packages, validation, organization charts and workspace Git operations |
| UI logic | Agent simulation, org chart, file grouping, calendar model and line diff suites; production TypeScript build |
| Security boundaries | Parser import harness; data-only frontmatter, loopback request guard, Host/Origin rejection before mutations, sandboxed file responses, traversal/symlink and upload regressions |
| Dependencies and release packaging | Production dependency audit, package dry run, CI/release workflow source review |

Agent command instructions were reviewed as text. No external AI agent was run
against imported material. Tests use temporary fictional workspaces and isolated
home directories. Git commits exercised by the smoke test are fixture commits,
not commits to this repository.

## Validation

- `npm run build` and `npm test`: pass on macOS with Node **22.23.3**, **24.22.0**
  and **26.12.0**. Each complete test run includes 43 server tests, all five UI
  suites, the parser boundary harness and the built-package smoke checks.
- The first Node 24 smoke attempt overlapped a clean build and encountered a
  missing generated CLI. A sequential Node 24 build and complete test rerun passed.
- `npm audit --omit=dev`: **zero reported vulnerabilities**, including moderate.
  This supersedes the older Router advisory snapshot in the architecture guide.
- `npm pack --dry-run --json --ignore-scripts`: 271 files, about 426 KB compressed;
  required CLI/server/UI/template files present, no test sources, scripts,
  workspace content or `node_modules` included.
- `git diff --check`: pass.
- Node 20.19 and Linux CI results are pending publication of the branch. Dependency
  installation from a clean checkout was not repeated locally for each runtime.

## Browser checks

Run in Chrome on macOS against the built package, on a fictional demo workspace
(`scripts/seed-demo.mjs`) with an isolated home directory, on its own port.

| Area | Result |
| --- | --- |
| Activity calendar | Pass. The 7, 30 and 90 day and all-time windows show the expected day cells and totals; the Completed filter matches the Completed card (6 in 30 days). Hover summary, day details, previous/next day, close, and Next disabled on today all work |
| Stakeholder links | Pass. Profile page, organization section, direct-report links and related-task links open the right person or task |
| Nested dialogs | Pass. A profile dialog opened over the full-screen org chart traps Tab and Shift+Tab; Escape closes only the profile and returns focus to the card; a second Escape exits full screen |
| Collapsed file folders | Pass. On an output template, `assets/`, `assets/icons/` and `source/` start collapsed with a file count (`aria-expanded="false"`); opening one shows only its own files |
| Context import | Pass. An update created from the dialog with pasted text saves the material and shows the analyze command |
| Concurrent uploads | Pass. Three uploads of `meeting.txt` sent at the same time from the page are kept as `meeting.txt`, `meeting-2.txt` and `meeting-3.txt`, each with its own content |
| Concurrent decisions | Pass. Two decisions saved at the same time are both kept with their notes. A save racing an approval is applied first, then the approval freezes it |
| Review in the UI | Pass. "Change my selection" returns an approved update to review with its decisions; clearing the selection autosaves and keeps reviewer notes |
| Date validation | Pass. `2026-02-30` is rejected with 400 and the stored date is unchanged |

Destructive actions that use the browser's native confirm were exercised with the
confirm stubbed in the page. Screen readers, responsive layouts and other browsers
were not tested.

Issues found, all present before this release and left for separate PRs:

- **Task dialog has no focus trap.** Shift+Tab moves focus to the board behind it.
  It renders its own dialog instead of the shared `Modal`; v0.3.0 behaves the same.
- **Status label mismatch.** The stakeholder profile shows "In Review" while the rest
  of the app shows "Needs Review" for the same status.
- **Org charts tab is not in the URL.** Browser Back from a task returns to the
  Individuals tab instead of Org charts.
- `gtd stop` reported that the demo server did not exit cleanly and force-stopped it
  after the session. Not investigated further.

## Performance observations

Local warm-process samples on Node 26, one warm-up followed by five measurements:

| Operation | Median | Largest sample |
| --- | ---: | ---: |
| Calendar aggregation, 1,000 synthetic tasks over 365 days | 1.2 ms | 1.7 ms |
| Calendar aggregation, 10,000 synthetic tasks over 365 days | 12.3 ms | 14.0 ms |
| Insights API, seeded workspace (14 active + 138 archived tasks) | 12.1 ms | 14.5 ms |
| Calendar API, same workspace, all-time window | 11.1 ms | 11.2 ms |

The synthetic benchmark used two dated runs and one stakeholder per task, with
creation dates spread over a year. It measures aggregation only, not filesystem
scanning or browser rendering. API times include local HTTP and response reading.
These are observations, not latency guarantees or large-workspace load tests.

The production entry bundle is **632.63 KB minified / 169.99 KB gzip**, still above
Vite's 500 KB warning threshold. The separate Markdown chunk is 160.08 KB minified.
Route-level splitting and bounded scanning deserve a measured follow-up; this
persistence fix does not add caching or suppress the warning.

## Remaining release gates and engineering risks

- The browser checks above passed. Responsive layout and assistive technology were
  not validated, and the task dialog focus trap is a known gap (see above).
- Run CI on the published head and confirm mergeability before marking the PR ready.
- Concurrent external writers remain outside this fix. Optimistic version checks
  and UI reconciliation of autosaves with live refreshes need separate integration
  coverage; the queue cannot guarantee browser event order across requests.
- Existing filesystem scans and all-time calendar ranges remain unbounded by a
  product-level retention window. The measured fixtures do not establish behavior
  for arbitrarily large or malformed workspaces.
- Full runtime schemas across domain endpoints and browser-level regression tests
  remain engineering gaps. Existing checks protect important boundaries but are
  not exhaustive domain validation.

The code retains the project's service/route separation and shared persistence
utilities, with tests demonstrating the defects and fixes. This review is not a
penetration test or a claim that every feature is defect-free. Release readiness
still depends on CI above.
