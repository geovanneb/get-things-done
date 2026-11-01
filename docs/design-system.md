# Design system

How the dashboard (`ui/`) looks and behaves, and how to keep it that way. Read this before
you add or change UI. The checks that enforce it are listed under [The harness](#the-harness).

See it live: run the app and open **`/design-system`** (not in the sidebar). The showcase renders
every shared component with its variants and states, in the current theme.

## Where things live

| What | Where |
| --- | --- |
| Colour, type, radius, shadow and chart tokens (light and dark) | `ui/src/index.css` |
| Spacing, layout width, control height, layer and line-height tokens | `ui/src/index.css`, end of the first `:root` block |
| Interaction states and responsive rules of the primitives | `ui/src/styles/primitives.css` |
| Shared components | `ui/src/components/common/` |
| Showcase | `ui/src/views/DesignSystemView.tsx` (`/design-system`) |
| Static checks and their exceptions | `scripts/check-design.mjs`, `scripts/design-baseline.json` |
| Browser checks and screenshot baselines | `scripts/visual-check.mjs`, `ui/visual-baselines/<platform>/` |
| Component tests | `ui/src/components/common/primitives.test.tsx` |

Components are styled inline with tokens, as in the rest of the app. The primitives use classes
from `primitives.css` only where inline styles cannot work: hover, active, focus and disabled
states, and media or container queries. A view does not add classes there; it composes components.

## Tokens

Use the semantic token, never a literal value, for every governed property.

- **Colour**: `--color-bg`, `--color-surface` (+ `-hover`, `-active`), `--color-border` (+ `-strong`),
  `--color-text` (+ `-secondary`, `-muted`, `-on-accent`), `--color-accent` (+ `-hover`, `-subtle`),
  and the status pairs `--color-critical|warning|success|info` with `-subtle` backgrounds.
  Charts use `--chart-*`; priorities use `--priority-*`. Each theme redefines the values.
- **Type**: `--text-xs` 11px, `--text-sm` 13px, `--text-base` 14px (body), `--text-md` 16px,
  `--text-lg` 18px, `--text-xl` 22px. All scale with the text-size preference. Weights: 400 body,
  500 labels and buttons, 600 headings and emphasis, 700 page-level numbers only.
  Line heights: `--leading-tight` (headings), `--leading-normal` (UI text), `--leading-relaxed` (Markdown).
- **Spacing**: `--space-1` 4px, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-8` 32, `-10` 40, `-12` 48.
- **Radius**: `--radius-sm` chips and inner controls, `-md` buttons and fields, `-lg` cards,
  `-xl` dialogs, `-full` pills, avatars and counts.
- **Elevation**: `--shadow-sm` raised controls, `-md` popovers and floating panels, `-lg` dialogs.
- **Layers**: `--z-raised`, `--z-dropdown`, `--z-sticky`, `--z-floating`, `--z-modal`,
  `--z-popover`, `--z-command`, `--z-toast`, lowest to highest.
- **Controls**: `--control-height-sm` 28px, `-md` 34px, `-lg` 40px. Buttons, inputs and selects of
  the same size share a height, so they line up in a toolbar.

## Page layout

Every routed view renders inside `<Page>` (`components/common/Page.tsx`):

| Width | Max content width | Use for |
| --- | --- | --- |
| `narrow` | 800px | forms, settings, a profile, one record, a reading page |
| `default` | 1120px | lists, tables and card grids |
| `wide` | 1320px | dashboards with side-by-side panels (Situation, Insights) |
| `full` (+ `flush`) | none | boards, split views and canvases that own their padding |

The gutter is `--page-gutter` (24px, 16px on a phone). Sections are 24px apart.

**The app header is the page title and the only `h1`.** A view never repeats the title. It starts
with `<PageHeader>`: a one-line description of what the page is for, the page actions on the right
(primary last) and an optional toolbar row of filters. On a phone the actions wrap under the text
and a search box takes the full width.

Group the page with `<Section>` (an `h2` with an optional description and actions, no surface) or
with `<Card>`. Heading levels go h1 (header) > h2 (section or card) > h3 (card inside a section).

Split views (a list of sections beside the content, as in Context) use the `gtd-split` classes:
the list stacks above the content on a phone.

## Components: which one to use

| Task | Use | Variants |
| --- | --- | --- |
| A text action | `Button` | `primary` (one per group), `secondary` (default), `ghost` (low emphasis, Cancel), `danger` (destructive); sizes `sm` `md` `lg`; `loading`, `icon`, `block` |
| An icon-only action | `IconButton` | `label` is required (name and tooltip); `tone="danger"`; `outline`; sizes `sm` 28px, `md` 34px |
| A group of content | `Card` | `padding="md"` content, `"compact"` repeated cards, `"none"` lists and tables (header gets a divider); `title`, `description`, `actions`, `badge`, `footer`. A card with only a header keeps the same space below it |
| Equivalent cards | `CardGrid` | one column on a phone, more as the page widens |
| A titled group without a surface | `Section` | |
| A text field, select, textarea | `Input`, `Select`, `Textarea` | `label`, `required`, `optional`, `hint`, `error`, `size` |
| Any other control with a label | `Field` + `className="gtd-control"` | |
| A setting or record field, label beside value | `FieldRow` | stacks on a phone |
| A checkbox with a label (and a line of explanation) | `Checkbox` | for a choice that applies on submit; a setting that applies at once is a `Toggle` |
| Part of a longer form or dialog | `FormSection` | a heading and an optional description; groups are ruled off |
| A consent or confirmation the user must give before an action | `gtd-consent` around a `Checkbox` | the primary action stays disabled until it is checked; say so in the footer |
| Rows inside a card | `Card padding="none"` + `<ul className="gtd-list">` with `gtd-list__row` | divider lines; extra controls (search, notices) sit in a padded band above or below |
| Running text read in place (a transcript, a preview) | `gtd-reading-box` | scrolls inside itself |
| A small value with inline actions (a speaker and its name) | `gtd-chip` + `gtd-chip__action` | |
| Search a list | `SearchInput` | the placeholder names what is searched and is the accessible name |
| Switch views of a page | `Tabs` | arrow keys move between tabs |
| Pick one option that filters or formats | `SegmentedControl` | |
| A count | `CountBadge` | `neutral`, `accent`, `warning`, `critical` |
| A status or category | `Badge` | priority and status variants |
| A dialog | `Modal` | `sm` 420px confirmations, `md` 560px short forms, `lg` 720px longer forms, `xl` 960px editors and previews; `footer` for actions |
| Confirm before a destructive action | `useConfirm()` | `tone: 'danger'` |
| Feedback after an action | `useNotify()` (toast) | `success`, `info`, `warning`, `error` |
| A message about the page or a part of it | `Notice` | `info`, `success`, `warning`, `critical` |
| Nothing to show | `EmptyState` | `size="page"` or `"compact"` (inside a card) |
| Loading | `LoadingSpinner` | `text` says what loads |
| A table | `<div className="gtd-table-wrap"><table className="gtd-table">` in a `Card padding="none"` | sortable headers: a `gtd-sort-btn` button inside the `th`, `aria-sort` on the `th` |

**List, table or cards?** A table when people compare the same fields across rows (stakeholders,
skills, the task list). A list of cards when each item has its own shape or longer text (context
notes, routines). A card grid for a small set of equivalent things picked by eye (templates, agents).
The record's name is the link or button that opens it; row actions are icon buttons at the end.

## Buttons and actions

- One primary action per page header, card or dialog. Everything else is secondary or ghost.
- Order: secondary actions first, the primary action last, on the right. Cancel is a ghost button.
- Destructive actions use `danger` or `IconButton tone="danger"` and always confirm with
  `useConfirm({ tone: 'danger' })`. Focus starts on Cancel.
- An action that waits on the server sets `loading`: it disables the button and sets `aria-busy`,
  so it cannot be submitted twice.
- Name the action with a verb and its object: "New template", "Delete note", "Save changes".
  No "+" typed into the label; use `icon={icons.plus}`.

## Forms

- Every field has a visible label tied to it. A placeholder is an example, never the label.
- Required fields carry `required` (asterisk and `aria-required`). In a form where most fields are
  required, mark the optional ones with `optional` instead.
- A hint sits under the field; an error replaces it, says what to do ("Enter a name."), and the field
  gets `aria-invalid`. A save that fails shows a `Notice tone="critical"` at the top of the form.
- Dialogs with typing pass `keepWhileTyping`, so Escape in a field does not throw away the input.
- Two-column forms use `gtd-form-grid`; it becomes one column on a phone.
- A form with more than about six fields, or two kinds of fields, is split with `FormSection`s
  and opens in an `lg` dialog. `sm` is for confirmations only.

## Dialogs

`Modal` handles focus: it moves focus in, keeps Tab inside, closes on Escape and returns focus to
the button that opened it. The header holds the title (and an optional description); the body
scrolls; the footer stays visible. On a phone every dialog takes the full width at the bottom.
Large record dialogs (task detail, new task) use the same `gtd-modal` classes with the `detail` panel:
the field sidebar moves under the content on a phone. Do not hand-build overlays.

## States

Every view and card that loads data handles all four states:

- **Loading**: `LoadingSpinner` with what is loading.
- **Empty**: `EmptyState` that says what is missing and offers the action that fixes it. When a
  search or filter causes the empty list, say so and offer "Clear search".
- **Error**: `Notice tone="critical"` with a title that says what failed and, where possible, a
  "Try again" action. A failed background refresh keeps the data on screen and shows a warning.
- **Disabled**: explain why with a `title` or a hint when it is not obvious.

Status never rests on colour alone: notices have icons, badges have words, the selected swatch has a check.

## Writing

- Sentence case for titles, labels, buttons and tabs ("Output templates", "Save changes").
  Product names and status names keep their capitals (Claude Code, Agent Floor, In Progress).
- Uppercase is reserved for the overline: `--text-xs`, weight 600, letter-spaced, muted. Use it only
  for group labels in navigation, menus and sub-navigation, and for table column headers.
- Say what happened and what to do: "Could not delete the note. Try again." Not "Error" or "Failed".
- Destructive confirmations name the object, the consequence and whether it can be undone.
- Use an ellipsis character (…) in loading text and labels that open a dialog ("Browse…").

## Accessibility and responsive behaviour

The target is WCAG 2.2 AA. The shared components cover most of it; when you build anything else:

- Use real elements: `button` for actions, `a`/`Link` for navigation, `label` for fields.
  Never put a button inside a link.
- Keep the focus outline. `outline: none` fails the checks.
- Icon-only controls have a name; targets are at least 24×24px (use `IconButton`).
- Check every change at 390px, 768px and 1280px wide, in light and dark, and with the keyboard
  only. Nothing may scroll the page sideways; a wide table scrolls inside its card.
- Respect reduced motion: animations use the shared classes, which slow down for it.

## Adding or changing a pattern

1. Look for an existing component or variant that serves the same purpose. Reuse it.
2. If the need is real and distinct, add a variant to the shared component, not a local copy.
   A new component goes in `components/common/` with its states and accessible behaviour.
3. Add it to the showcase, to `primitives.test.tsx` when it has behaviour, and to this document.
4. Run the checks below and look at the showcase and the affected pages at all three widths.
5. If the visual baseline changes on purpose, update it (`npm run test:visual -- --update`) and
   say why in the pull request.

## Exceptions

Some places legitimately break a rule: chart marks, the pixel-art Agent Floor, avatar colours
derived from a name. Two ways to record one:

- **A line**: put `// design-exception: <reason>` on the line or the line above. The reason is required.
- **A path**: the lists at the top of `scripts/check-design.mjs` (`ART_AND_DATA`, `DIALOG_OWNERS`,
  `PAGE_EXEMPT`) name each exempt file or folder with its reason.

Current exceptions: `components/agentic/` and `views/AgentFloorView.tsx` (pixel-art palette and font),
`components/insights/` (chart colours and axis text), avatar and workspace colours, the accent
swatch check mark, the 24px avatar's fixed font size, two focus targets that only receive focus
from code, the Setup flow (outside the app shell), the Context split view and the two record dialogs.

## The harness

| Command | What it checks | Runs in |
| --- | --- | --- |
| `npm run test:design` | Static rules over `ui/src`: no literal colours, font sizes or z-index; only the four weights; no browser `alert`/`confirm`; no `<style>` tags; no extra `h1`; no hand-built modal; no removed focus outline; every view inside `<Page>`. Ratchet rules: JavaScript hover handlers, numeric radii, hand-made banners, raw buttons and hand-made card surfaces may not grow past `scripts/design-baseline.json`. | `npm test`, CI |
| `npm run test:primitives --workspace=ui` | Behaviour and accessibility of the primitives (names, labels, roles, busy and invalid states, heading levels). | `npm test`, CI |
| `npm run test:visual` | In a browser, on a seeded demo workspace: every page at 390, 768 and 1280px has no sideways scroll, one `h1`, labelled fields and named buttons, and no page errors; dialog focus and Escape, tab arrow keys; screenshots of stable screens (showcase, templates, stakeholders, profile) in light and dark against `ui/visual-baselines/<platform>/`. | CI job "Design (browser)" |
| `npm run design:baseline` | Records the ratchet counts after you remove legacy patterns. Never run it to make room for new ones. | by hand |

`test:visual` needs a build and Playwright: `npm i --no-save playwright && npx playwright install chromium`.
Screenshots differ by operating system, so baselines are per platform; where none exist yet (CI on
Linux, until a maintainer records them with `--update` on that platform), the screenshots are kept
as a CI artifact for review and only the behaviour checks decide.

**Still manual**: colour contrast of new token values, screen-reader wording, zoom to 200%, and
judging whether a new screen reads well. The pull-request checklist asks for these.
