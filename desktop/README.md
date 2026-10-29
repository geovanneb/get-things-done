# Desktop app (Electron shell)

The Mac and Windows app for people who do not use a terminal. It is a thin shell: the server,
the dashboard and the templates are the same code as `gtd start` (see #123, phase 1).

## How it works

- `src/main.ts` (main process) picks a port (3001 first, then the next free one, remembered in
  `desktop.json` in the app's user data folder), starts the server and opens the dashboard at
  `http://127.0.0.1:<port>`. Closing the window keeps the app in the tray, so routines keep
  running. Quit from the tray or the app menu.
- `src/server-host.ts` runs in an Electron utility process and calls `startServer()` from
  `server/dist/server.js`. On quit it gets a `shutdown` message and closes the server
  cleanly, also on Windows, where there are no signals.
- `src/links.ts` decides where links go: the app's own pages stay in the app, web pages and
  e-mail open in the system browser or mail app, everything else is blocked.
- `src/preload.ts` and `src/bridge.ts` give the main window `window.gtdDesktop` with two calls:
  the system folder dialog and "open the workspace folder". Nothing else from Electron reaches
  the page, preview windows get no bridge, and no call takes a path from the page (the workspace
  path comes from the server). The dashboard uses them through `ui/src/utils/desktop.ts` and
  falls back to the server routes in a browser.
- Downloads always ask where to save, starting in the Downloads folder.
- The window is sandboxed (`contextIsolation`, `sandbox`, no Node in the page). The page gets no
  permissions except clipboard writes for the copy buttons.
- Git comes with the app: `dugite` ships a portable git (the one GitHub Desktop uses), and
  `server-host.ts` passes it to `startServer({ git })`. Users never install git. If the bundled
  copy is missing, the server uses the git on PATH, and without any git the git features are
  hidden (#126).
- The server reads the workspace from `~/.gtd/config.json`, the same as the CLI, so both
  see the same workspaces.

Server logs go to the app's log folder (`~/Library/Logs/Get Things Done/server.log` on macOS,
`%APPDATA%\Get Things Done\logs\server.log` on Windows).

## Run it from source

```bash
npm install                  # repo root, once
npm install --prefix desktop # downloads Electron and the portable git, once
npm run desktop              # builds everything, then opens the app
```

If your npm config has `ignore-scripts=true`, the two downloads do not run on install. Run
`npm run fetch-binaries --prefix desktop` once after installing (and after reinstalling).

`desktop/` has its own `package.json` and lockfile on purpose: installing the CLI or running
CI for the web app never downloads Electron.

## Build the installers

```bash
npm run build                    # repo root: CLI, server and dashboard into dist/
npm run dist:unsigned --prefix desktop # test installers for this computer into desktop/release/
npm run smoke --prefix desktop   # start the packaged app as a new user would and check it
```

- `npm run package --prefix desktop` builds only the unpacked app (faster, enough for the smoke test).
- `scripts/stage-app.mjs` puts the server, dashboard and templates into the app exactly as
  `npm install -g @bertonha/getthingsdone` lays them out: the repo is packed with `npm pack` and
  installed with production dependencies only (no optional native modules, no install scripts).
  The app runs that copy from its resources folder.
- Each platform builds on its own machine: portable git is downloaded for the computer running
  `npm install`. CI builds Apple Silicon, Intel Mac and Windows x64 installers and keeps test
  artifacts for 14 days. Test builds are unsigned (ad-hoc signed on Mac), show OS warnings and
  never check for updates.

## Releases and signing

A version tag runs `release.yml`. After build and test verification, the desktop workflow
(`desktop.yml`) runs in parallel with npm publishing. Installers go to a **draft** GitHub release,
which becomes public only after both the desktop and npm jobs succeed. The desktop version is set
from the tag. PR, `main` and manual desktop builds stay unsigned and never receive credentials.

**macOS (required for a release).** Both Mac builds (Apple Silicon and Intel) must be signed with
the Developer ID certificate and notarized; without the secrets below the release fails and stays
a draft. The workflow signs the apps and DMGs, then checks the signature, the stapled notarization
ticket and the Gatekeeper assessment.

**Windows.** Two modes:
- *SignPath configured:* the app files are submitted to SignPath, then the NSIS installer built
  from the signed files, and `scripts/win-update-manifest.mjs` recalculates `latest.yml` for the
  signed installer. SignPath's free program for open source needs a person to **approve every
  signing request** in SignPath, so each request waits up to 3 hours for that approval. If it
  times out, the release stays a draft: approve in SignPath, then re-run the failed job.
- *Not configured:* the installer is attached unsigned as `…-unsigned-preview.exe`, without an
  update manifest, and the release notes explain the SmartScreen warning. Preview builds never
  check for or receive updates.

**Test the Apple setup before tagging:** Actions → *Desktop app* → *Run workflow*, check **sign**.
The Mac builds are signed, notarized and checked exactly as in a release, and kept as workflow
artifacts; nothing is published to GitHub Releases or npm.

Repository **secrets** (Settings → Secrets and variables → Actions). Never commit any of these.

| Platform | Secret | Value |
| --- | --- | --- |
| Mac | `MAC_CERT_P12` | Developer ID Application certificate with its private key, exported as `.p12`, base64-encoded |
| Mac | `MAC_CERT_PASSWORD` | The `.p12` export password |
| Mac | `APPLE_API_KEY` | App Store Connect API key for notarization (contents of the `.p8` file) |
| Mac | `APPLE_API_KEY_ID` | That key's ID |
| Mac | `APPLE_API_ISSUER` | The issuer ID shown above the keys list |
| Windows | `SIGNPATH_API_TOKEN` | API token of a SignPath CI user allowed to submit to the signing policy |

Repository **variables** for Windows (SignPath): `SIGNPATH_ORGANIZATION_ID`,
`SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` (the release signing policy) and
`SIGNPATH_PUBLISHER_NAME` (the exact subject name of the signing certificate; the installed app
checks that every update is signed by it). Optional: `SIGNPATH_APP_CONFIGURATION` and
`SIGNPATH_INSTALLER_CONFIGURATION`, the artifact configuration slugs, by default `app` (all
`.exe` and `.dll` files of the unpacked app, deep) and `installer` (the single setup `.exe`).
Windows signing turns on when `SIGNPATH_API_TOKEN` and `SIGNPATH_ORGANIZATION_ID` are set.

Apple Silicon uses the `latest-arm64` update channel; Intel Mac and Windows use `latest`, so the
two Mac manifests cannot overwrite each other. `gtdSignedRelease: true` is embedded only in signed
builds; unsigned, preview and source builds do not request updates.

Signed installed apps check GitHub Releases at startup and every six hours. A downloaded update
adds a tray restart action and offers Restart now / Later. Restart stops the server before handing
control to the installer; Later leaves installation until quit. Downgrades are disabled.
`GTD_DISABLE_UPDATES=1` disables checks for isolated smoke tests.

Before declaring Phase 1 complete, configure the accounts, run the signed workflow, install on
clean Mac (both architectures) and Windows 10/11 machines, and exercise an update between two
signed versions. Signing alone does not prove that Windows SmartScreen shows no warning: a new
certificate or publisher builds reputation over time.
See [the Phase 1 audit](../docs/phase-1-audit.md) for current evidence and remaining gates.
