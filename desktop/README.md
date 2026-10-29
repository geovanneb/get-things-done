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
- The window is sandboxed (`contextIsolation`, `sandbox`, no Node in the page). The page gets no
  permissions except clipboard writes for the copy buttons.
- The server reads the workspace from `~/.gtd/config.json`, the same as the CLI, so both
  see the same workspaces.

Server logs go to the app's log folder (`~/Library/Logs/Get Things Done/server.log` on macOS,
`%APPDATA%\Get Things Done\logs\server.log` on Windows).

## Run it from source

```bash
npm install                  # repo root, once
npm install --prefix desktop # downloads Electron, once
npm run desktop              # builds everything, then opens the app
```

`desktop/` has its own `package.json` and lockfile on purpose: installing the CLI or running
CI for the web app never downloads Electron.

## Not here yet

Native folder picker and downloads (item 6 in #123), bundled git (7), the first-run wizard (8)
and signed installers with auto-update (9).
