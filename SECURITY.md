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
