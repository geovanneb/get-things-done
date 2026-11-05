# Security Policy

## Supported versions

Only the latest release on npm receives security fixes.

| Version | Supported |
|---|---|
| Latest `0.x` release | Yes |
| Older releases | No, please upgrade |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub:
[Report a vulnerability](https://github.com/geovanneb/get-things-done/security/advisories/new)
(Security tab, "Report a vulnerability").

Include what you can:

- What the issue is and where (file, endpoint, command)
- Steps to reproduce, or a proof of concept
- The impact you think it has
- Your environment (OS, Node.js version, package version)

Do not include real workspace content. Use made-up data.

## What to expect

- An acknowledgement within 5 working days.
- An initial assessment within 10 working days.
- A fix and a published advisory as soon as practical, with credit to you unless you
  prefer otherwise.

## Scope

Get Things Done is a local tool. The server binds to `127.0.0.1` and has no
authentication, by design: anyone with local access to your machine can already read
your workspace files. Reports are most useful when they show:

- A way for a web page or another machine to reach or abuse the local server
  (CORS, DNS rebinding, CSRF)
- Path traversal outside the workspace through the API or file uploads
- Code execution through workspace content, templates or the CLI
- Problems in the published npm package or the release pipeline

## Local trust boundary

Use the dashboard on `http://127.0.0.1:<port>` or `http://localhost:<port>`.
The API validates Host and Origin headers and rejects cross-site browser requests
before parsing request bodies. Only a top-level page load of the dashboard (a link
from another site) passes; it serves the page and its files, never an `/api` path, and
`frame-ancestors 'none'` keeps other sites from framing it. Development origins use ports 3000, 5173 and 4173.
Requests without an Origin remain available to local CLI clients; this is not
an authentication system. Do not expose the API through a public reverse proxy.

Workspace and marketplace Markdown is parsed as data, with executable JavaScript
frontmatter disabled. Workspace file previews have a restrictive CSP sandbox:
interactive HTML attachments must be downloaded to use outside the dashboard.
Download resolution checks real paths so symlinks cannot escape the selected root.
Uploads cannot replace entity metadata files or follow a destination file symlink.

A local process that can change workspace directories remains trusted. Path checks
are not an OS sandbox against another process swapping directories during a request.
Atomic replacement avoids partial files and temporary-file collisions, but concurrent
read-modify-write operations can still lose updates. Keep workspace backups.

## Remembered voices (biometric data)

**Recognize known voices** (off by default, [docs/voiceprints.md](docs/voiceprints.md)) keeps a voiceprint of
a stakeholder only after the user records that person's consent. Voiceprints are biometric data:

- They stay on this computer in `~/.gtd/voiceprints/`, outside the workspace (never in git or a sync folder),
  in folders and files readable only by the current account (`0700` / `0600`).
- They are never sent anywhere, never part of the digest, run packages, exports or search, and never given to
  AI tools. The API lists them without their samples.
- A voice only suggests a name; nothing is named without the user's click.
- Forget, Forget all and deleting a stakeholder remove the file. System backups (Time Machine and the like)
  include `~/.gtd`, so a forgotten voiceprint may remain in an older backup.

Anyone who can read this account's files can read the voiceprints, as with the rest of the app's local data.

