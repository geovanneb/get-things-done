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

## Not here yet

The first-run wizard (item 8 in #123) and signed installers with auto-update (9). The portable
git is downloaded for the platform that runs `npm install`, so installers must be built on each
platform (item 9).
