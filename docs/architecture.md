# Architecture and engineering boundaries

Get Things Done is a single-user local application. Markdown files are the source
of truth; the HTTP API, CLI and dashboard are interfaces over those files. The
existing npm workspace layout separates these interfaces without requiring a
framework rewrite or a database migration.

## Module ownership

| Location | Responsibility |
| --- | --- |
| `src/cli/` | Commands, process lifecycle and local configuration |
| `server/src/server.ts` | HTTP composition, listener and SSE; `startServer()` for any host (CLI entry, desktop shell) |
| `desktop/` | Electron shell: starts the server with `startServer()` in a utility process, the window, tray and link rules |
| `server/src/index.ts` | Process entry: reads env vars, starts the server, handles signals and exit |
| `server/src/routes/` | HTTP inputs, status codes and response formats |
| `server/src/services/` | Domain operations and workspace persistence |
| `server/src/utils/` | Shared parsing, path, file response and write boundaries |
| `ui/src/views/`, `components/` | Screens and reusable presentation |
| `ui/src/hooks/`, `store/` | Request lifecycle and client state |
| `templates/` | Generic content shipped into users' workspaces |
| `server/tests/` | Isolated server regression tests |
| `scripts/` | Package smoke tests, demo fixtures and boundary checks |

`scaffold.ts` owns workspace creation and upgrades. Runtime state belongs in the
user's workspace or home configuration, never in the source tree. Optional SQLite
search is a derived index, not authoritative storage. Keep templates generic and
update all three agent integrations together when changing workspace guidance.

### Meeting files

A meeting's files live in one of two places, and every reader asks `meetingFiles()` in
`server/src/services/meetingFolder.ts` which one, file by file:

- `context-updates/<CU id>/materials/`: while its update waits for review, and for meetings
  kept before meeting folders (an update without `meeting_folders`).
- `meetings/<meeting id>/v1/`: once the update is done and meeting text is kept. `meeting.json`
  names the update, the current version and each file with its SHA-256. With Keep recordings
  (`keep_recordings` on the digest), the recordings go to `meetings/<meeting id>/audio/`, listed
  the same way; digests kept before that set `keep_materials` and stay as they are. The folder is written
  under a hidden draft name (text copied, recordings hard-linked where possible; every file hashed
  and checked against the hash the update recorded) and renamed into place only when complete; the files leave
  `materials/` only after that, so a crash leaves a copy in one place or both, never in neither.
  A folder of another update, or one whose `meeting.json` cannot be read, is never used.

`meetings/` is private: git-ignored, never task input unless a task's pinned sources name a file
in it, and never part of anything shared. There is no publisher yet; when one is added (Phase 3),
it must refuse every path under `meetings/` and `context-updates/` itself, not rely on git-ignore.
Versions after `v1` are written by Transcribe again (`meetingVersions.ts`): the transcription job takes a
request from `meeting.json` once no queued recording waits, and the result becomes `v2`, `v3`… (the other
files copied, the transcript replaced), listed only when complete. Versions never share a file: editing one
version's file in place leaves every other version as it was. Nothing switches the current version
by itself, and a task's pins on an older version stay valid. Every change to `meeting.json` after the
folder is made holds that meeting's lock (`meetings/.<id>.lock`).
Corrections to the words go through the same writer: `checkTranscriptChanges` (read only, for the
review) and `writeCorrectedVersion` in `meetingVersions.ts` take changes `{ file, turn, before, after }`
against a numbered turn of a readable copy (`transcriptChanges.ts`). `before` must stand once in that
turn, on one line; a WebVTT original changes in its one cue and its copy is made again from it, checked
to differ only there. The new version becomes current, since approving the correction is the choice,
and it is refused when the version it started from is no longer current.
A correction's record carries them as `transcript_changes` (`correctionTranscript.ts`): the version they
change is read from its pins (`meetings/<id>/vN/…`, one `vN`), never written by the agent. Only sure
changes and the suggestions the executive used count, and those must each stand alone in the pinned turn
(no two on the same text). Approving keeps `finishing` (the changes and their receipt) on the update
before calling the writer, then marks it done with `transcript_version`; approving again after a stop
finishes exactly that, and every other change to the correction waits under the corrections lock.
Remaining risk: the first move is coordinated with the update's own queue, not across two dashboards
on the same workspace. A WebVTT original saved in UTF-16 is written back in UTF-8 when corrected. The writer takes a receipt (its caller's hash of what is being finished) and records it on the version: finishing the same correction again returns the version already written, and another receipt for it is refused. Reading a version's files checks their hashes, so a file changed on disk is never corrected.

## Request and file flow

1. The listener binds to loopback. The local request guard checks Host, Origin and
   Fetch Metadata before body parsing or route execution; CORS config shares its
   origin list. This is a local-browser boundary, not user authentication.
2. Routes delegate to services. Validate request values at runtime before using
   them in paths; interfaces and casts do not establish that a string is safe.
3. Services use `utils/markdown.ts` for frontmatter. Its explicit options disable
   executable JavaScript (including aliases) and the parser's global content cache.
4. Download and mention resolution use `fileInside`, checking both lexical and
   canonical paths and requiring a regular file. `sendFile` applies a sandbox CSP
   even to HTML and SVG attachments. Do not use raw Express file responses in routes.
5. Attachment writes use `saveAttachment`, protecting entity metadata and hidden
   filenames. `atomicWrite` writes an exclusive, unique sibling temporary file,
   then renames it; failure cleanup removes that temporary file. Existing regular
   file permissions are retained; new files are private to the current user.
6. Errors preserve explicit client statuses, including malformed/oversized bodies.
   Unexpected server error messages stay in server logs, not HTTP responses.

The workspace owner and other local processes remain trusted. Canonical path
checks cannot prevent another process swapping directories between checking and
opening a file. Atomic replacement provides whole-file visibility, not durability
against power loss or transaction isolation across read-modify-write operations.

## Regression harness

Run `npm run build && npm test`. The test command executes:

- `test:harness`: rejects direct gray-matter imports outside the parser wrapper.
- Server tests: executable frontmatter, path traversal, symlink escapes, metadata
  protection, concurrent atomic writes, cleanup, request rejection and error status.
- UI unit tests: simulation and organization-chart domain behaviour.
- Smoke tests: a built CLI/server/UI with a throwaway HOME and fictional workspace,
  including sandbox headers, upload protection and filesystem escape attempts.

CI runs the build and tests on Node 20.19, 22 and 24, validates package contents,
checks production dependency advisories and blocks high/critical findings.
A parser boundary violation or a security regression must not be waived to make CI
pass. Add new regression cases next to the behaviour they cover.

## Assessment and follow-up work

The October 2026 review of main at `f8587ef` found and addressed:

| Finding | Correction |
| --- | --- |
| Executable frontmatter in workspace/marketplace parsing | Shared data-only parser; no global document-content cache |
| Request-controlled paths in tasks, skills, context and templates | Path component validation before filesystem access |
| Lexical-only file confinement and unsandboxed attachment previews | Real-path checks and shared sandboxed responses |
| Uploads could replace entity metadata or follow a file symlink | Protected attachment writer using atomic replacement |
| Fixed temporary filename caused concurrent writes to collide | Unique exclusive temporary files and failure cleanup |
| Missing Host validation and inconsistent browser rejection | Middleware before routes and parsers |
| Parser client errors could be reported as server errors | Preserve explicit status; classify upload limit errors |
| Aborted UI requests could change current loading state | Ignore state updates after cancellation |
| No server regression suite and advisory CI was report-only | Server tests in npm test, import boundary check and blocking audit |

For the subsequent release review, current dependency audit, performance samples
and context-update concurrency fix, see [the October release review](release-review-2026-10.md).
The findings and validation below describe the earlier snapshot.

Remaining engineering work should be separate, measured changes:

- Add runtime request schemas consistently across all endpoints; the current checks
  protect path boundaries but do not constitute complete domain input validation.
- Introduce optimistic concurrency/version checks if multiple writers are expected;
  unique temporary files do not prevent lost updates or duplicate sequence IDs.
- Separate application construction from listener/SSE lifecycle when expanding HTTP
  integration coverage. Current boundary tests instantiate Express independently;
  smoke tests exercise the actual composition.
- Profile large workspaces, then consider bounded scan concurrency and route-level
  UI splitting. The current production entry chunk is about 551 KB minified and
  triggers Vite's size warning; no startup latency claim has been measured.
- Review the two moderate React Router advisories reported by npm audit. Their
  suggested fix is a major-version upgrade, requiring a dedicated routing review.

This assessment is a targeted source review and regression pass, not a penetration
test, exhaustive platform certification or a guarantee that all defects are absent.


## Validation of this change

The build and complete test command passed locally on macOS with Node 22.23.3 and
26.12.0. Seven server regression tests and the existing UI suites passed; the
expanded built-package smoke test passed. The package dry run included the new
runtime utilities and excluded test sources. `npm audit --omit=dev --audit-level=high`
passed with the two moderate Router findings noted above. Node 20/24 and Linux
remain covered by the configured CI matrix, which has not run for this local branch.
No browser interaction or large-workspace benchmark was performed.
