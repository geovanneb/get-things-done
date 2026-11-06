# Localization

Issue [#286](https://github.com/geovanneb/get-things-done/issues/286) is a staged migration.
The dashboard is translated: every screen, dialog and notice in `ui/src`, plus the fixed text
the server sends for models, languages, schedules and run checks. Translated READMEs are concise.
`/design-system` stays English: it is a developer showcase. Settings says some text may remain
English, because the gaps listed under "Next independently reviewable slices" still exist.

## Language policy

- Supported locales: `en`, `ja`, `pt-BR`, `es-419`; preference `auto` is distinct from any locale.
- Automatic uses Electron's `app.getPreferredSystemLanguages()` through a trusted,
  main-frame-only IPC method, or `navigator.languages` in the browser. Older desktop
  bridges fall back to the browser list.
- Try each preferred tag in order: canonical full tag, then base language. Thus `pt-PT`
  matches `pt-BR`, `es-MX` matches `es-419`, and an unsupported list falls back to English.
- An explicit choice wins over detection. It updates the current window after a successful
  save and catalog load, without restarting. `<html lang>` follows the rendered catalog.
- Other windows refresh on focus, visibility and browser `languagechange`, and every
  15 seconds while visible. This works across browser origins and separate desktop servers;
  it is eventual synchronization, not an instantaneous broadcast. Returning to Automatic
  resolves each window's own preferred languages.
- An unavailable settings endpoint keeps the current interface usable and offers retry.
  A failed save keeps the previous selection and displays a translated error.

## Boundaries and persistence

`server/src/services/userConfig.ts` owns `~/.gtd/config.json` read-change-write operations.
Language, CLI configuration and workspace history writers share the existing cross-process
file lock and `atomicWrite`. Changes preserve unknown fields; malformed JSON is refused
rather than replaced. The CLI loads the compiled service beside the scaffolder, using the
same packaging convention. Legacy migration uses exclusive copy and cannot overwrite an
existing config.

Atomic replacement alone does not prevent lost updates: cooperation through the lock does.
External editors or older app versions that ignore this lock can still overwrite changes.
The existing lock's documented stale-guard race remains; see `utils/fileLock.ts`. Config
writes are not claimed durable against power loss. The UI does not store a competing
localStorage preference, and no language is written into a shared workspace.

`GET /api/app/language` returns `{ language }`; `PUT` accepts only the supported canonical
values or `auto`. Both work before workspace setup. Invalid input returns 400 without a write.

## Catalogs and builds

`server/src/i18n/` is the single source for **pure, host-independent** locale policy and
catalogs. It has no Node, Express, React or Electron imports. The existing server build
ships it in `dist/server/i18n/`; Vite imports this pure source and splits translated
catalogs into dynamic chunks. Desktop staging already packs `dist/`, so the same compiled
catalogs are available for the later native-menu and CLI migrations. Do not copy catalogs
into each host or import server services into the browser.

English defines keys, placeholder names and whether a message is a string or a plural.
Other catalogs satisfy the same mapped type. Translation calls require the corresponding
arguments; tests check non-empty translations and placeholder parity in every plural form.
Missing or empty strings fall back to English. Each plural contains whole phrases keyed by
CLDR category, with `other` required; `Intl.PluralRules` selects a form and
`Intl.NumberFormat` formats the count. This deliberately small format is **not ICU syntax**.
A plural may carry other placeholders besides `count`. For a sentence with an element inside it,
`ui/src/i18n/rich.tsx` places React nodes at named placeholders, so the whole sentence stays one
message. Never split a sentence around a `<strong>` or a value.
Use a maintained ICU library if nested selects or ordinals become necessary.
Never implement an ICU parser or assemble grammar with English singular conditionals.

Translator notes for this slice:

- `automatic`: the interface language detected on this device, not transcription detection.
- `context`: saved background for the AI; `memory`: the navigation group containing it.
- `outputs`: reusable output templates, not generated deliverables.
- `newTask`: opens the task creation dialog; `openClaude`: opens a local terminal.
- `validationErrors` / `validationWarnings`: workspace validation counts, not failed jobs.
- Keep Get Things Done, Claude Code and Agent Floor as product names.

Japanese uses natural Japanese punctuation and a system CJK font stack. Portuguese and
Spanish use sentence case and natural accents. Language choices use their native names,
without flags. Short translated READMEs link to the full English guide and record their
source revision. Native review, especially Spanish, remains welcome before release.

## Three rules for translated code

- Components use `useLanguage`. Code outside React uses `tr` from `ui/src/i18n/current.ts`, called when
  the text is needed: a module constant holding text must be a function, or it keeps its first language.
- Stored values are data, not labels. Note categories, default board columns and status ids stay English
  on disk and are translated at display time (`categoryLabel`, `columnLabel`).
- Fixed server English goes through `ui/src/i18n/serverText.ts`, which matches `server.*` messages and reads
  the schedule sentence from `describeSchedule` back. Changing either text on the server needs the same
  change there, or the text falls back to English.

## Next independently reviewable slices

- Add a hard-coded-string ratchet and a development-only expanded pseudo-locale.
- Translate HTTP errors at the response edge **after** status classification and logging,
  using stable ids and request-local locale. Saved job errors need ids and arguments too.
- Translate native menus, dialogs and notifications; rebuild them on preference changes.
  Bundle macOS `.lproj` permission strings, which follow OS language rather than this setting.
- Translate the CLI and full user guides; add a non-blocking stale-doc report.

Agent instructions and data keys remain English. Spoken language and the profile's output
language are separate preferences. Quoted source evidence keeps its original bytes.

## Validation

`npm test` covers matching, catalog keys/placeholders/plurals, concurrent config changes,
malformed config preservation and API smoke cases. `npm run test:visual` checks Japanese
Settings at 390, 768 and 1280 px in both themes, keyboard focus, immediate overrides, reloads, desktop
preference precedence, Spanish switching and save failures. Test data and config live in
temporary fictional workspaces. Native OS integration and keyboard selection inside native select popups still need macOS/Windows release QA; headless Chromium on macOS does not simulate that popup.
