# Release regression review — 18–19 November 2026

Reviewed the features shipped between `v0.15.0` and `v0.16.0`, with fixes applied on
`fix/release-regression-audit` from upstream main `6311fb2`. GitHub's release API
confirmed on 18 November `v0.16.0` as the latest non-prerelease, published 17 November 2026.
The complete regression suite also exercises the subsequent main changes (chat,
custom context categories and overdue-task validation). All fixtures were disposable
workspaces with fictional content and isolated HOME directories.

## Findings and fixes

| Finding | Effect | Fix and regression |
| --- | --- | --- |
| Task attachment operations accepted a symlinked task folder or ancestor | Listing could expose outside file metadata; uploads and deletion could modify files outside the workspace | Resolve the attachment directory through `workspaceEntry` for all three operations. Tests cover the task folder, `tasks/active`, and `tasks`, including unchanged target bytes. API smoke checks verify 400 responses and no writes/deletions. |
| Deliverable validation trimmed a filename before upload normalization | A leading space produced a reference to a different filename from the saved attachment | Both paths use the same `safeFileName` input. Regression covers leading spaces, decomposed Unicode and long multibyte filenames; smoke checks exercise the upload and task APIs together. |
| Onboarding inferred interview ownership from a fixed filename | A user's own `first-context-interview.md` was hidden and a files-only interview could not be submitted; a renamed generated interview could be shown as user material | Return the stored `interview_file` identity in the first-context API and filter only that material. Server tests cover collisions and reload; UI tests cover both owners; browser tests exercise files-only drafts. |
| Assistant fallback commands interpolated paths in shell double quotes | Pasting a command could expand substitutions embedded in a workspace name | A browser-safe shared helper quotes POSIX arguments and uses an encoded PowerShell invocation with a literal path on Windows for the API and clipboard fallback. Tests run all four POSIX commands with fake CLI functions and hostile filenames, checking that no injected marker is created. Windows tests decode the invocation and cover Unicode, apostrophes, substitutions and percent signs without exposing them to cmd. |
| Onboarding resume prompt squeezed its message beside two actions | On phones, the message collapsed to a vertical strip and overflowed with offline fonts | Place the button group below the message inside the shared Notice body; check that the message keeps more than half the notice width in every browser size/theme combination. |
| Floating chat launcher covered the last template action on a phone | At maximum scroll, pointer events reached the chat icon instead of Delete | Standard `Page` padding reserves the existing launcher-space token. Full-bleed pages retain their own layout. Browser checks verify hit testing and keyboard activation in both themes at all three widths. The design guide, showcase and macOS screenshots are updated. |
| Lint dependencies retained affected minimatch | Development-tool denial-of-service advisory | Update the TypeScript ESLint lockfile chain to 8.73.0 with minimatch 11.0.9, verify a clean install, and remove the now-withdrawn picomatch audit exception. Desktop builder moderate advisories remain documented below. |
| Remote fonts made screenshots depend on network availability | A clean rerun changed phone text rendering despite unchanged layout CSS | Run the page matrix and screenshots with Google Fonts blocked, explicitly testing the supported offline system-font fallback. Document that web-font rendering remains a separate online check; add a focused screenshot comparison mode. |
| The browser page inventory omitted onboarding | Its distinct shell and failure states escaped routine layout QA | Add `/get-started` to the page inventory and a focused browser helper for collisions, heading focus, failed autosave, retry and persistence before navigation. |

The filename, symlink-directory, command-quoting and ownership regressions failed against the original
implementation before their fixes. A separate browser reproduction confirmed the
covered template action received a chat-icon hit before the padding fix and its own
button hit afterward. No baselines or static ratchets were relaxed to hide failures.

## Coverage

- **Onboarding:** normalization, empty/partial answers, profile placeholders, existing
  profile preservation, retry after profile-read failure, update reuse, submitted-state
  conflicts, restart, skip, generated/user-file collisions and browser save recovery.
- **Attached-file deliverables:** template switching, invalid/reserved filenames, path
  reduction, format derivation, schema validation, Unicode and byte-length boundaries,
  attachment containment and built-server behavior.
- **Material retention:** default opt-in, per-update override, analysis preserving the
  choice and cleanup behavior, through the existing context-update and cleanup suites.
- **Assistant portability:** generated skill inventory, unchanged procedures, standard
  frontmatter, deduplication, upgrades preserving edits, tool detection and launch
  argument construction. Chat adapters are tested with fake CLIs, not live accounts.
- **Security/persistence:** data-only Markdown, traversal, symlink escapes, protected
  metadata, local request guard, malformed bodies, sandboxed file responses, unique
  atomic writes, locks, interrupted operations and existing recording/meeting regressions.
- **UI:** shared primitives, design tokens and static ratchet; all routed pages in the
  browser inventory at 390/768/1280 pixels in light/dark, names/labels/headings, overflow,
  console errors, contrast-token checks, keyboard dialogs, navigation and language changes.

## Validation

- Application build: passed on Node 26.13.0 and, after a clean lockfile install, Node 22.23.4.
  Desktop TypeScript build: passed.
- Complete `npm test`: passed on Node **20.19.0**, **22.23.4** and **24.22.2**,
  macOS arm64, with one runtime matrix running at a time. Each run discovers **907
  server tests**: Node 22/24 pass **896** and skip **11**; Node 20 passes **892** and
  skips **15** (four additional native-SQLite cases). Each also passes all UI suites,
  **27 desktop tests**, and **230 built-package smoke checks**. Optional real
  transcription/voice-model and GPU cases remain skipped without their fixtures.
- Lint: **0 errors, 35 existing warnings**; no new warning allowance.
- Separate voice-consent browser suite: all six width/theme combinations passed,
  including consent payloads, enabled states, moved-voice confirmation, layout and focus.
- Parser boundary and design checks: passed within `npm test`.
- Package dry run: **782 files**, all required runtime/template entries present;
  no scripts, desktop sources, test sources, node_modules or `.DS_Store` leaked.
- Browser verification uses Playwright 1.57.0 with the installed Chromium headless shell
  159.0.8154.6 via `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. The pinned Chromium 143 download
  stalled during extraction, so its incomplete installation was not used. The macOS
  baseline browser version differs from CI's pinned version; CI's Linux behavior
  checks remain necessary (there are no Linux screenshot baselines in this checkout).
  The page matrix and baselines explicitly use the offline system-font fallback;
  Google Fonts requests are blocked for reproducibility.

The initial browser pass found three outdated phone screenshots containing the new
chat launcher, which led to the covered-action reproduction above. The launcher was
introduced on main after the release; it is included here because the review found a
concrete usability problem. Screenshots are intentionally changed for the added
bottom space and showcase documentation, rather than accepting a larger pixel tolerance.

## Performance sample

Node 22.23.4, local APFS, one process, fictional short Markdown tasks and plain-text
attachments. Six sequential service calls per case; the first measurement is separate
from the median of the remaining five. Fixture creation is excluded. OS disk caches
were not cleared; these are service timings, not cold-start or network/UI benchmarks.

| Operation | First call | Median of next five |
| --- | ---: | ---: |
| List 1,000 tasks | 71.56 ms | 62.80 ms |
| Search 1,000 tasks | 57.86 ms | 57.00 ms |
| List 500 attachments | 12.79 ms | 5.25 ms |
| Read onboarding state with empty memory | 0.41 ms | 0.09 ms |

The production entry JavaScript chunk is about **385 KB minified / 116 KB gzip**.
No cache or concurrency rewrite was justified by this sample. Large Office documents,
network volumes, huge transcripts and continuous transcription need separate workloads.

## Dependency and remaining risks

On 19 November, the production **and full root dependency audits report zero
advisories**. The lockfile now uses TypeScript ESLint 8.73.0 and its supported
minimatch 11.0.9 dependency, removing the moderate advisory without a forced
transitive major override. The desktop high/critical gate also passes with **zero
exceptions**; its obsolete exception was removed, not expanded. The full desktop
build-tool audit still reports **six moderate package entries** from minimatch in
`electron-builder` 26.18.0 (`app-builder-lib` and `@electron/universal`). This is the
latest builder release checked on 19 November and it still requires minimatch 10/9.
No compatible owning-package update is available; npm suggests a builder downgrade.
Keep packaging patterns repository-controlled and update the builder once its chains
support the patched dependency. No forced major override was added.

- [Minimatch GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
  is fixed starting at 11.0.1. Updating the owning TypeScript ESLint chain allowed
  the patched dependency within the project's existing version range.
- [Picomatch GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
  was withdrawn on 18 November and is no longer reported by npm. Earlier runs in
  this review reported it; its disappearance is an upstream advisory withdrawal,
  not a code fix or a newly accepted exception.
- Running all three Node matrices simultaneously on this machine exposed wall-clock
  sensitivity in the DOCX linear-time tests and recording-start tests, and a stalled
  workspace-operation test. The failed concurrent run was stopped and the matrices
  were rerun separately; thresholds were not relaxed. CI runs each matrix on its own
  machine. Keep performance checks isolated and follow up on bounded waits in the
  workspace-operation regression harness.
- Existing lint warnings include hook dependencies and unused variables. They remain
  visible. Eliminating them safely requires checking language changes and request
  lifecycles in each feature; suppressing the warnings would not improve correctness.
- The local workspace owner remains trusted. Path checks do not eliminate directory
  swaps between validation and I/O. Atomic replacement is not transaction isolation
  and does not solve cross-process lost updates.
- Live signed-in Claude/Codex/Copilot sessions, OS terminal launch, microphone/system
  audio, real-model accuracy, Electron packaging/signing, Windows/Linux execution,
  primary online web-font rendering, screen-reader narration and 200% zoom were not certified by this pass.

This is a broad automated regression run plus focused source and browser review. It
is not proof that every feature, platform or engineering practice is defect-free.
