# UI consistency audit — November 2026

Base: `upstream/main` at `2576077`. Fix branch: `fix/ui-consistency-audit`.

## Scope and method

Reviewed the dashboard's route inventory, design tokens and primitive styles, shared
controls, page/section/card composition, task and meeting dialogs, attachment lists,
and stakeholder/organization-chart controls against `docs/design-system.md`.
The Electron shell hosts the same dashboard; native menus, OS dialogs, microphone
capture and audio drivers need separate platform testing.

The browser harness uses a disposable workspace populated by `seed-demo.mjs`. Its
route matrix now includes Agent Floor, stakeholder details, context-update details
and meeting details, in addition to the previously covered screens. Every route is
checked at 390, 768 and 1280px in light and dark themes for overflow, one page h1,
field labels, action names and uncaught JavaScript errors. Token contrast checks
cover both themes and all six accents. Shared dialog and tab keyboard checks and
stable-screen screenshot comparisons complement those structural checks. Chart tabs
also receive keyboard checks at each width and in each theme.

## Confirmed findings and changes

| Finding | Change |
| --- | --- |
| Compact-card descendant selectors changed the padding of nested cards, regardless of their own variant. | Scope compact header/body/footer rules to direct children. Add a browser regression using a nested card. |
| Long unbroken card titles could exceed the available width. | Allow shared card titles to wrap anywhere. |
| Showcase cards under h2 sections also rendered h2 headings. | Use h3 for those nested cards. |
| Embedded stakeholder detail cards introduced h2 headings inside another record. | Use h3 when embedded and h2 on the standalone page. |
| Settings and stakeholder details maintained wrappers that only repeated `Card`. | Use the shared component directly. |
| Organization-chart view tabs duplicated tab rendering and did not implement arrow/Home/End navigation or roving focus. | Use shared `Tabs`; add arrow and End browser regressions. |
| Chart create actions typed `+` into labels; chart deletion used a ghost button with an inline red override. | Use shared plus icons, explicit action names and the danger variant. |
| Task draft and attachment remove actions had inconsistent icons and 20–24px targets. | Reuse `IconButton` with its 28px target and danger feedback; downloads use the same icon-action dimensions while remaining links. |
| Task Markdown edit controls bypassed shared button sizing and states. | Use small ghost buttons, explicit edit labels and “Discard changes”. |
| Meeting detail headings used uppercase overline styling; profile, stakeholder, update and organization headings used weight 700 reserved for page metrics. | Use sentence-case section headings and weight 600 for record titles. |
| The showcase's visible search label did not focus its input. | Expose `SearchInput.id`, associate the label, and test both markup and browser focus. |
| Attachment fetch errors silently displayed “No files attached.” | Show a critical notice with a retry action. Add a browser failure/recovery regression. |
| Switching attachment URLs did not reset loading or protect against an old request resolving later. | Reset request state and ignore results after effect cleanup. |
| Attachment header actions could crowd the label on narrow screens. | Allow the header to wrap with shared spacing. |
| The route browser matrix only exercised light mode and omitted several detail routes. | Run structural checks in both themes and discover detail IDs from fictional seed data. |

The design ratchet is lowered for removed raw buttons and JavaScript hover handlers;
no limit is raised. Domain-specific components (task forms, chart canvases, recording
controls) remain where they provide distinct behavior. Consolidation does not mean
forcing every visual surface into the same layout or removing intentional art/chart
exceptions.

## Verification and limits

The checks below do not prove
that every possible UI state is defect-free. In particular, automated token contrast
does not inspect every rendered text/background combination; native assistive
technology, 200% zoom, actual recording hardware and all combinations of user content
remain manual checks. Existing design-ratchet entries are still migration work, not
an assertion that all historical styling has been eliminated.

- `npm run build`: passed.
- `npm test`: passed, including design/boundary checks, unit suites and API smoke tests.
- `npm run lint`: no errors; 18 existing warnings remain.
- `npm run test:visual`: passed all 120 route/theme/width combinations, token
  contrast, dialog/consent behavior, tab navigation, attachment retry and all 12
  existing screenshot comparisons.
- `npm run test:visual -- --update`: passed, including chart keyboard navigation
  in all six width/theme combinations; refreshed the intended showcase/profile baselines.
- `git diff --check`: passed.

Screenshot baselines are refreshed on macOS for the intended title-weight and
showcase changes. Route screenshots are local review artifacts under
`.visual-output/routes/`; stable-screen comparisons remain in
`ui/visual-baselines/darwin/`. No real workspace data is used.
