# 0.11.0 release assessment

Assessment date: 5 November 2026 (Asia/Tokyo). Release title:
**0.11.0 — In-app updates, customizable boards, and offline dictation**.
Prepared locally; no tag, publication, push, or signed installer was produced by this assessment.
A local commit was attempted, but the configured SSH signing key could not unlock. Changes
remain staged on the assessment branch; signing was not disabled.

## Scope and version

Compared `v0.10.0` (`42d530a`) with upstream main (`da87383`), fetched before creating
`fix/post-0.10-release-regressions`: seven commits, 78 changed files, 4,273 insertions
and 297 deletions before these fixes. Reviewed the changed service, HTTP, desktop,
UI, schema, and release boundaries and exercised the existing regression harness.

| Change | Classification | Regression coverage |
| --- | --- | --- |
| Global npm updates from Settings (#296) | Feature | Version validation, installation location, locks, busy state, helper failure/recovery/restart, command arguments |
| Desktop update controls and coordinated shutdown (#297) | Feature | Signed-build eligibility, download state, preparation failures, repeated requests, quit ordering, retry |
| Workspace-bound run-finished notices (#298) | Fix | Workspace headers and material links, rejection on workspace mismatch, built API smoke |
| External dashboard links and API-only rate limiting (#299) | Fix | Host/Origin/Fetch Metadata checks, cross-site navigation, API case/path variants, rate-limit tests |
| Ubuntu browser runner (#300) | CI | Configuration reviewed; local macOS browser validation does not certify Linux screenshots |
| Editable board columns (#301) | Feature | Validation, concurrent preference writes, symlink protection, task round trips, legacy status placement, keyboard editing |
| Offline text-field dictation (#302) | Feature | WAV/type/size/model limits, temporary-file cleanup, worker contention, component lifecycle, restart admission |

New user-facing capabilities require a minor release, **0.11.0**, rather than a
0.10.1 patch. No intended incompatible API removal was found in this range; the
workspace task schema adds optional `board_column`, retaining established statuses.
Root and desktop manifests and lockfile metadata agree on 0.11.0. The changelog now
includes the previously omitted update controls, workspace notice fix, and external
navigation fix. Refresh workspace-owned schemas with `gtd upgrade`; dashboard opening
also refreshes the task schema. Release workflows require the eventual tag to match.

## Confirmed findings and corrections

1. **Dictation could race an update restart.** Before the worker acquired its slot,
   reading model settings and preparing audio were invisible to the busy check. New
   dictation also ignored closed update admission. Dictation now holds `beginStart`
   across preparation, transcription, and cleanup, releasing it on every error path.
   A deferred-settings regression failed before the fix and passes afterward.
2. **Unreadable activity was treated as idle.** Run-directory read errors and meeting
   queue problems could allow an update while activity was unknown. Missing run
   directories remain valid, but other directory errors and queue problems now block
   installation. Both pre-install checks and status reporting fail closed. Regressions
   reproduce damaged run and queue paths; built-package smoke checks the HTTP result.
   Desktop preparation reopens admission after a refused restart.
3. **Desktop retry could be a no-op.** `quitAndInstall()` may return before reporting an
   installation failure through an event. The completed handoff promise stayed cached,
   so a later retry never installed again. That event now resets the handoff while
   concurrent calls still share one attempt. The regression covers failure after the
   original handoff completed and exactly one new attempt on repeated retry clicks.
4. **Dictation retention wording overstated guarantees.** The API documentation said
   the clip was never stored, although it uses a private temporary file. Documentation
   now describes normal cleanup and the possibility of leftovers after a process crash.

No parser, path-containment, sandboxed-response, attachment, or atomic-write boundary
was bypassed by these fixes. No dependency override, test skip, design exception, or
ratchet increase was introduced to obtain a passing result.

## Validation

- Baseline `npm run build`, `npm test`, and lint completed on Node 26.12.0 before fixes.
- Final CLI/server/UI build and desktop TypeScript build passed.
- Final `npm test` passed on **Node 22.23.3 and Node 24.22.0**, including boundary/design
  checks, server and UI/desktop unit tests, and built-package API/CLI smoke. Each server
  run had 614 tests: 603 passed and 11 optional real-model tests skipped because their
  model/audio fixtures were not configured. The smoke test did load the native engine.
- Focused update/dictation suites: 32 passed; desktop update suite: 9 passed.
- The separate `node --test scripts/dictation-lifecycle.test.mjs` checks passed.
- Lint: zero errors; 21 existing warnings. `git diff --check` passed.
- Final `npm run test:visual` passed: 390, 768, and 1280px in light/dark, accessibility
  labels, overflow, contrast, focus handling, and all 12 screenshot baselines. All 24
  added board-editor assertions passed (keyboard add/reorder/save/cancel and layout).
  Baselines were not regenerated. The final run used a stable build; an earlier run
  overlapped rebuilding and was discarded.
- Package dry run: 611 files, about 1.15 MB compressed; required CLI, server, worker,
  UI, and template files present; no scripts, desktop sources, node_modules, or
  workspace data included. Version is 0.11.0.

## Security and dependency audit

Fresh npm registry audits found **zero production advisories** in the root package
and **zero high/critical advisories** in either full dependency tree. Full root audit:
10 moderate affected dependency entries; desktop: 6. These trace to the existing
[Minimatch glob amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
through ESLint/typescript-eslint and electron-builder tooling, not 16 distinct
vulnerabilities. Dependencies did not change in the post-0.10.0 range. npm's suggested
fixes downgrade major tool chains; no unverified force-fix or override was applied.
Keep those build inputs trusted and resolve the tooling upgrades separately with
Node-floor and packaging compatibility tests.

The local HTTP guard remains a browser-origin boundary, not user authentication.
Workspace owners and other local processes remain trusted. Atomic preference writes
avoid partial files and serialize this server's changes, but do not prevent lost
updates between different processes. Client-only dictated audio is not durable before
upload; neither this pass nor the restart admission fix makes unsaved browser state
crash-safe. Normal dictation cleanup is tested; crash recovery of temporary audio is
not implemented.

## Performance sample

A temporary fictional workspace with 1,000 completed run records was scanned ten
times on this macOS host using Node 26.12.0. Activity scans took **24.70–30.13 ms**;
100 concurrent preference-save requests serialized and completed in **23.45 ms**.
This exercises the new updater scan and shared preference writer, not end-to-end
startup or real speech inference. Run scanning is linear in retained history and
preferences share a process-wide queue; no cache was added without evidence of a
user-visible bottleneck. These warm local samples are not cross-platform guarantees.

## Remaining release verification

Run remote CI on the final pushed commit, especially Node 20.19 and Ubuntu browser
baselines. Exercise signed macOS and Windows installers, actual npm installation and
rollback in a disposable global prefix, and real-model dictation/microphone paths.
Those destructive/external integrations were covered with fixtures or controller
regressions here, not by updating a real installation. The existing CI real-model job
supplies separate coverage when it runs. This is a targeted release assessment, not
penetration testing or exhaustive platform certification.

## Disposition

The assessed local candidate passes the completed release gates above, with no remaining
confirmed defect from this targeted regression review. It is prepared for review and CI,
not certified for publication across untested platforms. Publish only after the remaining
platform/install checks succeed and the signed release workflow completes.
