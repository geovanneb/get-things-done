# Release readiness review — 4 November 2026

## Verdict and scope

**The reviewed main snapshot needed fixes before release. The fixes below are on
`chore/0.9-release-review`; final release approval remains conditional on CI and the
manual/native acceptance gates below.** No release, tag, public security report or
installation into the user's application/workspace was performed.

Base: `89fde1c` from freshly fetched `upstream/main`. `v0.9.0` already exists at the
release preceding six additional feature/fix commits. This review covers the 0.9
feature family (`v0.8.0..89fde1c`: 197 files), with detailed source and adversarial
review of the newer voice recognition, speaker naming, run progress/notifications,
update checks and GPU-settings changes. The older meeting-history, correction,
source-pin and retention work was re-exercised through the current regression
suite; the earlier local review is historical context, not fresh certification.
The post-tag delta alone is 94 files. This is targeted engineering review, not an
exhaustive penetration test or a guarantee of no defects.

All new fixtures are fictional and use temporary HOME/workspaces. Biometric test
vectors are synthetic. Existing untracked review notes and `.claude/` were left
untouched. No application version was bumped.

## Findings and changes

| Priority | Finding | Evidence and disposition |
| --- | --- | --- |
| P1 — privacy/integrity | An open consent dialog could enroll a different person after another window renamed its speaker. The request carried only the label and `consent: true`; the service resolved the current person and recorded consent for them. | Reproduced with the real service/store and fake engine; a persistent regression also uses real queue naming. Fixed: the dialog sends `consent_ref`, checked against the current confirmed person before audio extraction. Missing or mismatching consent identity returns 409. Existing consent-free additions to an already remembered voice retain their behavior. |
| P1 — privacy/concurrency | “Forget them” for a moved workspace could succeed while an in-flight relink held its voice bytes, after which the relink wrote them into the destination. | Reproduced by suspending publication and deleting the source. Fixed: relink and moved-store deletion share a move lock, re-read the source under it, and lock the source binding against enrollment. A delete after a completed move returns not found rather than claiming to have forgotten the destination's voices. |
| P2 — persistence | Relink advertised damaged voices but silently skipped their unreadable files, then deleted the source directory and returned success. | Regression includes one valid and one damaged print. Fixed: validate the entire set before any destination prints are written; return 409 and preserve both original files. Explicit deletion remains possible. API smoke coverage verifies both behaviors. |
| P2 — UX | An enrollment error was rendered behind the still-open consent modal. The user could see no explanation for why Remember voice did not work. | Browser reproduction with an injected 409, visually inspected at phone width. Fixed: the modal itself renders the error using the shared Notice. |
| P2 — UX/destructive action | “Forget them” on a moved store immediately deleted all its voices without the confirmation used elsewhere. | Source-confirmed. Fixed using shared `useConfirm`; browser checks verify Cancel sends no delete and confirmation sends exactly one. |
| P3 — test reliability | The broad visual harness could inspect a lazy route before React mounted: no heading, no controls, no page error, blank screenshot. Its spinner-absence check could pass before the spinner existed. | Initial run had two heading failures. Added a bounded wait for the heading before measurement; a genuinely missing heading still fails the existing assertion. No screenshot threshold or baseline was relaxed. |

The three server regressions were run **before** the fixes and all failed, then
passed afterward. They live beside the voiceprint tests in
`server/tests/voiceprints.test.ts`. The consent protocol change is documented in
`docs/api.md`; old open clients must reload/reopen the dialog to enroll a new voice.

The new `scripts/voiceprint-ui-check.mjs` runs on an isolated built app, with a
silent WAV fixture and mocked voice API responses. It verifies the actual browser
request's consent identity, disabled submit before consent, visible failure text,
Escape/focus restoration, layout, and moved-store confirmation at 390/768/1280 in
light/dark. It is now part of the existing browser CI job. It does not test speech
recognition or actual model enrollment.

## Verification

Local platform: macOS arm64, Node 26.12.0. Results concern the branch's working tree,
not a pushed commit or hosted CI result.

| Check | Result |
| --- | --- |
| Fresh `npm run build` | Passed: server, UI, CLI and copied distribution |
| Full `npm test` after fixes | Passed: 593 server tests, 582 passed, 11 fixture-dependent skips, zero failures; UI tests, 22 desktop tests and built API/CLI smoke also passed |
| New adversarial regressions | All three failed before fixes and pass afterward |
| Focused voice browser suite | All six width/theme combinations passed; consent request binding, error display, Escape/focus and delete confirmation checked |
| Broad visual suite | Passed in the final isolated run: all routes at 390/768/1280 in light/dark, labels/names/headings, contrast, keyboard, and all 12 existing screenshot comparisons. Baselines were not updated |
| Desktop TypeScript build | Passed; not a packaged native-app acceptance test |
| Lint | Application/new code: zero errors, 20 warnings when excluding the pre-existing untracked `docs/release-regression-2026-11-probes.cjs`. Plain `npm run lint` includes that unrelated file and reports 41 errors from it. No ignore configuration was changed to hide this |
| Root production dependency audit | Zero advisories (public npm registry) |
| Full root / desktop audits | 12 / 15 moderate affected-package entries respectively; zero high/critical. Existing minimatch tooling chain remains; counts are affected packages, not independent vulnerabilities |
| `npm pack --dry-run --json` | 592 entries, 4,604,768 unpacked bytes; compiled voiceprint modules included; no test sources. This run did not install the tarball |
| Diff whitespace check | Passed |

Logs are local `/tmp/gtd-09-review-*`, notably `final-build.log`,
`verified-tests.log`, `failing-before.log`, `voice-ui.log`, `verified-lint.log`,
`prod-audit.json`, `desktop-audit.json`, `pack.json` and `isolated-visual.log`.
Review screenshots are under `.visual-output/voices/` and `.visual-output/routes/`.
These are ignored local artifacts, not committed private data.

Earlier browser runs are not silently counted as passes: the first run had two
premature heading checks; an intermediate run was invalidated by rebuilding assets
while its server was running; another run passed behavior checks but reported small
phone screenshot differences. The final isolated run avoids concurrent builds and
browser suites. None of those observations justifies accepting new baselines.

## Security and architecture assessment

- HTTP remains a loopback, trusted-local-user service with Host/Origin/Fetch Metadata
  checks ahead of parsers. Current negative smoke and regression checks pass.
- Voice request path components are validated; byte access uses the contained file
  resolver and hash checks. Embeddings are excluded from public voice views, stored
  outside the workspace with private permissions, and omitted from task packages.
- Consent requires a user action and now binds to a specific person. Voice matching
  remains a suggestion: no automatic naming. Existing tests cover stale model,
  transcript and suggestion rejection, sample removal and forget-vs-enrollment.
- The voice store uses shared locks and unique atomic replacement. **Relinking is
  still not a crash-atomic multi-file transaction.** A crash/write failure after some
  copies are published can leave data at both locations and require recovery. The
  source is retained until the copy phase completes. Do not describe this fix as
  solving every persistence failure or concurrent lost-update scenario.
- Run progress filters tool inputs to constrained names and contained existing
  workspace paths, rather than displaying raw commands/content. Desktop notices
  validate a run against the local server. Tests exercise those boundaries.
- “Never given to AI tools” describes what the application packages/sends. Keeping
  voice data outside the workspace is not an OS sandbox against a trusted local
  process with the user's filesystem permissions.
- No new remote-only exploit was demonstrated. Live agent prompt-injection,
  compromised local-user scenarios and signed update delivery were not certified.

## Performance

Synthetic store-list benchmark, five consecutive runs on this machine, with 20
samples per voice and 192-dimensional vectors:

| Prints | `VoiceprintStore.list()` milliseconds |
| --- | --- |
| 100 | 10, 9, 8, 8, 9 |
| 1,000 | 81, 78, 78, 63, 64 |

These are warm local filesystem microbenchmarks, not end-to-end latency targets.
`view()` also resolves stakeholders/models/moved stores; `detail()` may scan meeting
history. Multiple speaker panels each fetch voice/person data. Avoid speculative
caching, but measure those full routes on large real-shaped fictional workspaces
before claiming scalability. Embedding jobs bypass the main transcription slot;
concurrent enrollment CPU/memory and long non-WAV conversion remain unmeasured.

## Remaining release gates and follow-up

1. Run hosted Node 20/22/24, browser, dependency and packaging CI on the eventual
   signed commits. This session validated Node 26 locally; old Node matrix evidence
   from the previous release does not certify these changes.
2. Run real-model voice recognition/enrollment and transcription acceptance with
   consented fixtures. Eleven server tests skipped locally. Include unknown voices,
   merged speakers, short speech, renaming during extraction and long recordings.
3. Exercise the actual packaged desktop release on supported platforms: microphone
   and system audio, playback, GPU selection/speed test, suspend/resume, stop during
   extraction, notification click, update from the released version and restart.
   No installed app or user's workspace was touched for this review.
4. Review any remaining visual mismatches before release; do not update baselines
   merely to turn the suite green. Native screen-reader behavior and 200% zoom are
   still manual checks beyond the browser keyboard tests.
5. Update the moderate minimatch tooling dependency chain in a focused compatible
   change; retain the blocking production audit. Address the 20 lint warnings
   separately, especially stale effect dependencies. No blanket dependency upgrade
   or unrelated architectural rewrite was introduced here.

The branch fixes the confirmed issues above and leaves an executable regression
trail. It does not by itself authorize publishing the next release or justify
calling unexecuted hardware/CI checks passed.
