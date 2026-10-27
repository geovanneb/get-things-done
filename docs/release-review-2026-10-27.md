# Release review: 27 October 2026

Reviewed `v0.4.0..8719f2c` and prepared corrections on `fix/release-regressions`,
starting from the latest upstream main. No version bump, commit, push or PR was
made. The public GitHub API reported no open PRs at the final overlap check.

## Scope and findings

The release adds routines and their scheduler/CLI, recent workspace switching,
task attachments during creation and Markdown objectives, context-update command
guidance, pending-action indicators, kaizen bulk commands, and dependency updates.
Review covered the changed source, shared persistence boundaries, existing security
regressions, built-package behavior, desktop UI interaction and performance samples.

| Priority | Reproduced problem | Correction and evidence |
| --- | --- | --- |
| High | Twelve simultaneous task creates returned one ID and overwrote the same file. Routines introduce another concurrent creator alongside manual tasks. | Reserve each task directory with exclusive `mkdir`, retrying occupied sequence numbers. Regression checks all twelve distinct tasks; smoke coverage exercises eight concurrent HTTP requests. |
| High | Switching workspace during a routine redirected its task and receipts into the new folder. Outstanding HTTP task operations could also change destinations across awaits. | Capture the workspace per API request and queued routine operation using async-local context. Tests switch folders at controlled suspension points and assert the original folder receives the task/receipt and the new folder stays untouched. |
| High | An outstanding search could return the other workspace's results after a switch because the index connection/cache was shared. | Own and close the search service per request. An HTTP regression holds an indexed request, switches workspace, completes a second search, and verifies both result sets remain isolated. |
| High, conditional | Node 20.19.0 crashed with SIGSEGV when search loaded better-sqlite3 13 from an installation shared with a newer Node. The optional package declares Node >=22. | Skip the native module on Node 20 and use the existing JavaScript search fallback. The actual Node 20 build and complete suite pass after the change. Fresh installs may already omit the unsupported optional dependency. |
| Medium | Objectives saved in the new task Markdown body were absent from both task filtering and global search. | Include the Markdown body in both searches, with failing-before service coverage and API smoke coverage. |
| Medium | Invalid routine markers returned 400 but left an empty task directory behind. | Validate before allocating the directory. Service and HTTP regressions assert there are no filesystem changes. |
| Medium | Agent-edited kaizen status updated the navigation count but left stale Apply commands on the page. Rejection HTTP failures were ignored. | Subscribe the view to kaizen file-change events and use the checked API helper with visible errors. Live updates and successful rejection were checked in Chrome. |
| Medium | Switching workspace from a detail URL opened a missing entity in the destination workspace. | Reload into Situation after switching. Reproduced from a context-update detail and verified the corrected navigation in Chrome. |

Persistence/isolation tests were run against the original behavior and failed before
correction. No parser, contained-file, sandboxed-response, attachment protection or
atomic-write boundary was bypassed. The existing import-boundary check and blocking
dependency audit remain intact. Async-local context follows Node's documented
[AsyncLocalStorage behavior](https://nodejs.org/api/async_context.html#class-asynclocalstorage).
It isolates workspace selection; it is not a transaction or a lock on file content.

## Regression results

All fixtures were temporary fictional workspaces. Browser interaction used only the
seeded demo and additional fictional review tasks, routines and proposals.

| Check | Result |
| --- | --- |
| `npm run build` and `npm test`, Node 20.19.0 | Pass: 83 server tests, UI suites, boundary harness and built-package smoke tests |
| Same commands, Node 22.23.3 | Pass |
| Same commands, Node 24.22.0 | Pass |
| Production dependency audit, `npm audit --omit=dev --audit-level=high` | Pass, zero reported vulnerabilities |
| Package dry run and content assertions | Pass: 291 files; required runtime, UI and routine schema present; no workspace, test, script or node_modules leakage |
| `git diff --check` | Pass |

The Node 20 result above uses an explicit temporary Node 20.19.0 installation. An
initial npm-exec attempt resolved to Node 26 and was discarded as Node 20 evidence.
The final checks use the existing lockfile installation; the Node 20 fallback and
Node 22/24 native search paths are exercised. Linux CI has not run on this branch.

The complete suites include recurrence intervals, monthly boundaries, pause/resume,
catch-up policies, receipt deduplication, lock handling, routine validation and CLI
execution; task fields/uploads; context-update decisions/concurrency; archives;
calendar/DST behavior; org charts; Markdown parsing; traversal/symlink protection;
local request rejection; upload limits; and response security headers.

Desktop Chrome visual/interaction checks covered:

- Situation's pending-action panel and navigation indicators.
- Empty routines view, editor, weekday preset, creation, manual execution and history.
- Task creation with an objective and a fictional text attachment, followed by objective
  display and the Files tab confirming the attachment.
- Context proposal review, selection and approval, including scrolling/focus to the
  apply command and the persistent next-step guidance.
- Kaizen single/bulk command layouts, live proposal changes and rejection.
- Recent workspace menu, switching between two isolated workspaces, cache reset and
  corrected landing-page navigation.

Existing screenshots were not replaced: this patch changes behavior/error handling,
not the established page design. No screenshots containing browser chrome or personal
browser tabs are committed. Clipboard contents and actual external agent execution
were not verified; this review covers command presentation and application workflow.

## Performance samples

macOS, Node 26.12.0, temporary fictional workspace with 1,000 active tasks, 1,000
archived tasks and 100 weekly routines. Each measurement is ten sequential warm
samples after one warm-up; these are local service timings, not browser latency,
load-test percentiles or cross-platform guarantees.

| Operation | Median | Maximum |
| --- | ---: | ---: |
| List 1,000 active tasks | 33.1 ms | 36.9 ms |
| List 100 routines | 7.8 ms | 8.1 ms |
| Idle scheduler with 100 routines | 6.0 ms | 7.7 ms |
| Build request-owned index and search 1,000 active tasks | 35.7 ms | 38.1 ms |

The main UI chunk is 671.86 kB minified / 175.57 kB gzip and still triggers Vite's
500 kB warning. Route splitting remains a separate performance improvement; no
cache was added without evidence. Due-run bulk creation and cold-start latency
were not benchmarked.

## Remaining limits

Atomic replacement still does not prevent concurrent read-modify-write lost updates.
Exclusive task-directory reservation prevents simultaneous creators taking the same
active ID, but is not a transaction with arbitrary external edits, archival, receipt
writes or process crashes. Routine locks remain local leases, not distributed locks;
run the scheduler on one host. Other local processes/workspace owners remain trusted.

Mobile layouts, Safari/Firefox, Linux/Windows native folder dialogs, external AI-agent
behavior and exhaustive accessibility certification were not tested. This is a release
regression review with explicit evidence, not a claim that every possible defect has
been eliminated. No unresolved release blocker was found within the exercised scope.
