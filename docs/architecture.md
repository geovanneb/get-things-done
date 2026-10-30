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
