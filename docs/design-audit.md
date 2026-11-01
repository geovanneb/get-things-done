# Design audit, November 2026

An audit of every page and major interaction of the dashboard against the design system that
came out of it ([design-system.md](design-system.md)). It was done on the fictional demo
workspace (`scripts/seed-demo.mjs`), in the browser at 390, 768 and 1280px wide, in light and
dark, and in the source. Status: **Fixed** (changed and verified in the browser), **Guarded**
(fixed and now enforced by a check), **Open** (known, not changed here).

## Strongest existing patterns kept

- The oklch colour tokens with light and dark themes, six accents and a text-size preference.
- `Button`, `Modal` with `useDialogFocus` (focus trap, Escape, focus return), `Badge`, `Toggle`.
- The app header as the page title, the collapsible sidebar, the Insights `Panel` and `StatTile`.
- The Situation page's container-query layout and Insights' "one filter scopes every panel" rule.

## Matrix

| Page / component | Issue found | Impact | Shared standard | Status |
| --- | --- | --- | --- | --- |
| All pages | Five content widths (720 to 1400px), three paddings (16, 24, "24px 28px"), some centred, some left-aligned | Pages felt unrelated; content jumped between screens | `Page` with four width variants and one gutter token | Guarded (`page-frame`) |
| Stakeholders, Outputs, Routines, Agents, Context | A second `h1` repeating the header title, in different casing ("Output Templates" vs "Output templates") | Duplicate title; two h1s for screen readers | Header is the only h1; `PageHeader` holds description and actions | Guarded (`h1`, browser check) |
| Situation, Meetings, Insights, Profile, Settings | No description; no consistent place for page actions | Purpose of the page not stated | `PageHeader` description + actions, primary last | Fixed |
| Task detail (phone) | Main column collapsed to about one character wide | Task unreadable on a phone | `gtd-detail` layout: sidebar under the content below 760px; full-screen dialog | Fixed, browser check |
| New task (phone) | Same fixed 316px sidebar | Form unusable on a phone | Same as task detail | Fixed |
| Output templates (phone) | Fixed 3-column grid; cards and "New template" ran off screen | Content cut off | `CardGrid` (auto-fill, one column on a phone) | Fixed, browser check |
| Settings (phone) | Label column fixed at 140px; inputs crushed, path cut | Settings unusable on a phone | `FieldRow` stacks below 640px | Fixed, browser check |
| Context (phone) | Toolbar wrapped into a ragged right-aligned column | Hard to scan | `gtd-split` + page-header actions wrap to full width | Fixed |
| Stakeholders, Agents | Visually hidden table header text widened the window (absolutely positioned outside the scroll box) | Keyboard focus could shift the whole app sideways on a phone | `.gtd-table-wrap` is the positioning context | Guarded (browser check) |
| Insights (phone) | Two-column grid with a 340px minimum overflowed | Sideways scroll | `minmax(min(100%, 340px), 1fr)` | Guarded (browser check) |
| Section cards | Seven local versions (`SectionCard` x3, `cardStyle` x3, `Panel`), paddings 14/16/18/20/24px, titles uppercase in one, sentence case in others | Equivalent content looked different | `Card` (md / compact / none), `Section` | Fixed; ratchet on new hand-made surfaces |
| Error messages | 20 hand-typed red boxes; some `<p role="alert">`, some bare text | Inconsistent, some not announced | `Notice` with icon and role | Fixed; ratchet (`inline-banner`) |
| Destructive actions | 23 `window.confirm` and 9 `alert()` calls | Unstyled browser dialogs, "OK/Cancel" wording, no recovery | `useConfirm` (danger tone, focus on Cancel), `useNotify` toasts | Guarded (`native-dialog`) |
| Buttons | No hover or active state; a `<style>` tag injected per instance; Cancel sometimes secondary, sometimes first | Weak affordance; inconsistent hierarchy | Class-based states, `aria-busy` while loading, Cancel ghost and first | Guarded (`style-tag`) |
| Icon buttons | Two local `IconButton`s, a 16px "+" on Kanban columns, "×" text buttons | Below the 24px target size; no shared hover | `IconButton` with required label, 28px minimum | Fixed; ratchet (`raw-button`) |
| Forms | Labels not tied to fields (Context, Outputs, Profile, Task sidebar); `outline: none` on inputs; four `selectStyle` copies | Fields unnamed for screen readers; no visible focus | `Field`, `Input`, `Select`, `Textarea`; `.gtd-control` focus ring | Guarded (`outline-none`, browser label check) |
| Tabs and toggles | Five tab or segmented looks (Board, Stakeholders, Task, Insights window, calendar mode, Markdown editor, Settings) | Same job, different controls | `Tabs` (views, arrow keys) and `SegmentedControl` (options) | Fixed, browser check (arrow keys) |
| Sortable tables | Clickable `th` without a button or `aria-sort` | Sorting not possible by keyboard | `gtd-sort-btn` in the `th`, `aria-sort` | Fixed |
| Clickable cards | Template cards were clickable `div`s | Not reachable by keyboard | The title is a button; the card is the mouse target | Fixed |
| Stakeholder detail | "Back" was a button inside a link; the name was a second h1 | Invalid nesting, double announcement | Link styled as a button; name is h2 | Fixed |
| Board list | Empty state "Create task" did nothing; failed drag was silently ignored | Dead end; card snapped back without a reason | Working action, filter-aware empty state, error toast | Fixed |
| Situation | "Blocked" tile used a fixed colour that ignored the theme | Wrong colour in dark mode | `--color-critical` (icon tells it apart) | Guarded (`raw-color`) |
| Colour tokens (light) | Muted text 2.6 to 2.9:1, warning 3.4 to 3.7:1, success and info 4.1:1, field borders 1.9:1 | Fails WCAG 1.4.3 and 1.4.11 | New values; `--color-border-control` for field edges | Guarded (browser contrast check, both themes, six accents) |
| Fonts | Weight 700 used but not loaded | Faux bold | 700 loaded; weights limited to 400/500/600/700 | Guarded (`font-weight`) |
| Layers | z-index 50, 500, 900, 1000, 1100, 2000 chosen ad hoc | Overlays could stack wrongly | `--z-*` scale | Guarded (`z-index`) |
| Dialog focus | Focus did not return to the opener when a field inside had `autoFocus` | Keyboard users lost their place | Opener captured before autofocus | Fixed, browser check |
| Writing | Title case in buttons and dialog titles ("Create Template", "Re-initialize Workspace"), "+ New" labels, "Failed to …" errors | Inconsistent voice | Sentence case, verb + object, errors say what to do | Fixed |
| Meetings: Record a meeting dialog | Opened at the confirmation size (420px) for a ten-field form; its own smaller inputs and borders; raw checkboxes; actions scrolled away with the body; no grouping | Cramped, unlike every other form dialog; Start could be off screen | `lg` dialog, `FormSection` (Meeting, Audio), shared fields, `Checkbox`, highlighted consent, footer with the reason Start is disabled | Fixed, browser check |
| Meetings: queue | Grey rounded boxes per meeting, its own search box, problems and results as plain coloured text, state as coloured words | Looked unlike every other list | Card list with divider rows (`gtd-list`), `SearchInput`, `Notice`, a `Badge` per state, empty state with "Record a meeting" | Fixed |
| Meetings: transcript reader and live transcript | Title in a small grey line, raw Save/Cancel text links, a hand-styled input, errors as plain text, a hover-grey text box | Hard to scan; inconsistent controls | A `Card` with title and actions, `gtd-reading-box`, `gtd-chip` for speakers, shared buttons and `Notice` | Fixed |
| Recording panel (bottom right) | Hand-made surface and select, inline link colours | Inconsistent with cards and fields | `gtd-card`, `gtd-control`, `gtd-link`, `Notice` for a failure | Fixed |
| Stakeholder picker | Labelled like a section heading, larger than the fields around it | Broke the label hierarchy in the task sidebar and the Record dialog | Field label and `gtd-control` | Fixed |
| Agent Floor | Pixel-art palette and fonts | Intentional | Documented exception | Exception |
| Setup | Centred wizard card outside the app shell | Intentional (first run) | Documented exception; uses `Notice` | Exception |

## Review by area

Pass means the area now follows the standard on every page; notes name what stays manual.

| Area | Result |
| --- | --- |
| Layout and spacing | Pass. One frame, spacing scale, no sideways scroll at 390/768/1280 (checked). Kanban stays a horizontal scroller by design. |
| Typography and hierarchy | Pass. One h1, h2 sections, six text sizes, four weights (checked). |
| Colour and surfaces | Pass. Tokens only; AA contrast for text and field edges in both themes and all accents (checked). Status also shown by icon or word. |
| Buttons and controls | Pass. Shared hierarchy, states, busy and target sizes. Legacy raw buttons remain in the org-chart editor (ratchet). |
| Lists, tables, cards | Pass. Criteria documented; tables scroll inside their card; empty, loading and error states on every list. |
| Forms | Pass. Labels, required markers, hints, errors (checked for labels). |
| Dialogs | Pass. Four sizes, sticky footer, focus handling (checked). Two record dialogs share a larger documented variant. |
| Navigation and IA | Pass. Header title, sub-navigation in Context, tabs for views. Nav labels unchanged (saved sidebar layouts rely on them). |
| Content and writing | Pass for the pages touched. Status names keep their capitals. |
| Accessibility | Automated checks pass; see the gaps below. Not a claim of full WCAG 2.2 AA conformance. |

## Open items and gaps

- **Org-chart editor** (`components/stakeholders/OrgChartsPanel.tsx`, `OrgChartTree.tsx`) keeps its own
  toolbar buttons and menus (19 raw buttons). It works and has keyboard support, but it is the largest
  remaining legacy area; the ratchet stops it growing.
- **Context updates** detail (`UpdateDetail.tsx`) and the routine editors still use the older inline
  form styles (now on the same tokens) rather than `Input`/`Select`.
- **JavaScript hover handlers** remain in 12 files (recorded in the baseline).
- **Not verified**: screen-reader wording with VoiceOver or NVDA, 200% zoom and 400% reflow, Windows
  high-contrast mode, the Electron desktop shell (only the browser build was checked), and screenshot
  baselines on Linux (CI keeps the screenshots as an artifact until a Linux baseline is recorded).
