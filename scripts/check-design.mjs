#!/usr/bin/env node
// Design harness: static checks that keep the dashboard on its design system.
// The rules and how to work with them are in docs/design-system.md.
//
//   node scripts/check-design.mjs                  check (CI runs this through `npm test`)
//   node scripts/check-design.mjs --update-baseline record the current counts of the ratchet rules
//
// Strict rules fail on any new occurrence. A line can opt out with a comment on the same line
// or the line above that names the reason:  // design-exception: <why>
// Ratchet rules cover legacy patterns that are still common: each file may keep its recorded
// count (scripts/design-baseline.json) but never add more. Lower a count when you clean a file.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = path.join(root, 'ui/src');
const baselinePath = path.join(root, 'scripts/design-baseline.json');
const update = process.argv.includes('--update-baseline');

// Paths the colour and type rules do not govern, with the reason. Keep this list short.
const ART_AND_DATA = [
  ['components/agentic/', 'pixel-art scene: a fixed palette and bitmap font by design'],
  ['views/AgentFloorView.tsx', 'the pixel-art scene and its status bar share one fixed palette'],
  ['components/insights/', 'chart marks and axis labels: palette.ts and the --chart-* tokens hold the colours'],
  ['utils/theme.ts', 'accent swatches are computed from each accent hue'],
  ['components/common/Avatar.tsx', 'avatar colour is derived from the name'],
  ['components/layout/WorkspaceAvatar.tsx', 'workspace colour is derived from its path'],
];

// Files allowed to render their own modal dialog markup, with the reason.
const DIALOG_OWNERS = {
  'components/common/Modal.tsx': 'the shared dialog',
  'components/common/SearchOverlay.tsx': 'command palette with its own layout',
  'components/common/GitIndicator.tsx': 'non-modal popover dialog',
  'views/TaskDetailView.tsx': 'record dialog, uses the gtd-modal classes',
  'components/board/NewTaskModal.tsx': 'record dialog, uses the gtd-modal classes',
  'views/MeetingDetailView.tsx': 'record dialog, uses the gtd-modal classes',
};

// Routed views that do not use <Page>, with the reason.
const PAGE_EXEMPT = {
  'views/SetupView.tsx': 'first-run flow outside the app shell',
  'views/AgentFloorView.tsx': 'experimental full-bleed canvas',
  'views/ContextView.tsx': 'split view (gtd-split), owns its panes',
  'views/TaskDetailView.tsx': 'a dialog over the board, not a page',
  'views/MeetingDetailView.tsx': 'a dialog over the Meetings list, not a page',
};

const H1_OWNERS = ['components/layout/Header.tsx', 'views/SetupView.tsx'];

const isArt = (rel) => ART_AND_DATA.some(([p]) => rel.startsWith(p));
const RAW_COLOR = /(['"`])#[0-9a-fA-F]{3,8}\1|\b(?:rgba?|hsla?)\(\s*\d|\boklch\(\s*[\d.]/;

/** Strict rules: [id, message, test(line, ctx) -> boolean]. */
const STRICT = [
  ['raw-color', 'Use a colour token (var(--color-*)), not a literal colour.', (l, c) => !isArt(c.rel) && RAW_COLOR.test(l)],
  ['font-size', "Use a type token (var(--text-*)), not a pixel size.", (l, c) => !isArt(c.rel) && /fontSize:\s*['"]?\d/.test(l)],
  ['font-weight', 'Use font weight 400, 500, 600 or 700.', (l) => /fontWeight:\s*['"]?(?!(?:400|500|600|700)\b)\d+/.test(l)],
  ['z-index', 'Use a layer token (var(--z-*)) for z-index 10 and above.', (l) => /zIndex:\s*\d{2,}/.test(l)],
  ['native-dialog', 'Use useConfirm() or useNotify(), not the browser dialog.', (l, c) => c.rel !== 'components/common/ConfirmDialog.tsx' && /\bwindow\.(?:confirm|alert|prompt)\(|(?<![\w.])alert\(/.test(l)],
  ['style-tag', 'Put keyframes and selectors in a stylesheet, not a <style> tag.', (l) => /<style[\s>]/.test(l)],
  ['h1', 'The app header is the page h1. Use h2 and below in a view.', (l, c) => !H1_OWNERS.includes(c.rel) && /<h1[\s>]/.test(l)],
  ['dialog-role', 'Use <Modal> (or useConfirm) for dialogs.', (l, c) => !(c.rel in DIALOG_OWNERS) && /aria-modal=/.test(l)],
  ['outline-none', 'Do not remove the focus outline; keyboard users need it.', (l) => /outline:\s*['"]none['"]|outline:\s*0\b/.test(l)],
];

/** Ratchet rules: counted per file, compared with the baseline. */
const RATCHET = [
  ['js-hover', 'Hover styles set from JavaScript (use a class with :hover, or a shared component).', (l) => /onMouse(?:Enter|Leave)=\{[^}]*style\./.test(l)],
  ['numeric-radius', 'A numeric border radius (use var(--radius-*)).', (l, c) => !isArt(c.rel) && /borderRadius:\s*['"]?\d/.test(l) && !/borderRadius:\s*['"]?0['"]?\s*[,}]/.test(l)],
  ['inline-banner', 'A hand-made status banner (use <Notice>).', (l) => /background(?:Color)?:\s*'var\(--color-(?:critical|warning)-subtle\)'/.test(l)],
  ['raw-button', 'A raw <button> (prefer Button, IconButton, Tabs or SegmentedControl).', (l) => /<button[\s>]/.test(l)],
  // A card signature: the surface colour with the card radius within a few lines of the same style object.
  ['inline-surface', 'A hand-made card surface (use <Card> or className="gtd-card").', (l, c) => /borderRadius:\s*'var\(--radius-lg\)'/.test(l)
    && c.lines.slice(Math.max(0, c.i - 4), c.i + 5).some((x) => /background(?:Color)?:\s*'var\(--color-surface\)'/.test(x))],
];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const exempt = (lines, i) => /design-exception:\s*\S/.test(lines[i]) || (i > 0 && /design-exception:\s*\S/.test(lines[i - 1]));

const failures = [];
const counts = {};
const files = await walk(src);

for (const full of files) {
  const rel = path.relative(src, full).split(path.sep).join('/');
  const text = await readFile(full, 'utf8');
  const lines = text.split('\n');

  if (rel.endsWith('.css')) {
    // index.css is the token source. Other stylesheets use tokens only.
    if (rel === 'index.css') continue;
    lines.forEach((l, i) => {
      if (exempt(lines, i) || /^\s*(\/\*|\*)/.test(l)) return;
      if (/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d|\boklch\(\s*[\d.]/.test(l)) failures.push([rel, i + 1, 'raw-color', 'Use a colour token in stylesheets.']);
      if (/font-size:\s*\d/.test(l)) failures.push([rel, i + 1, 'font-size', 'Use a type token in stylesheets.']);
      if (/z-index:\s*\d{2,}/.test(l)) failures.push([rel, i + 1, 'z-index', 'Use a layer token in stylesheets.']);
    });
    continue;
  }

  lines.forEach((l, i) => {
    const ctx = { rel, lines, i };
    if (/^\s*(\/\/|\*|\/\*)/.test(l) || exempt(lines, i)) return;
    for (const [id, message, test] of STRICT) if (test(l, ctx)) failures.push([rel, i + 1, id, message]);
    for (const [id, , test] of RATCHET) {
      if (!test(l, ctx)) continue;
      counts[id] ??= {};
      counts[id][rel] = (counts[id][rel] ?? 0) + 1;
    }
  });

  if (rel.startsWith('views/') && !(rel in PAGE_EXEMPT) && !/from '@\/components\/common\/Page'/.test(text)) {
    failures.push([rel, 1, 'page-frame', 'A routed view renders inside <Page> (components/common/Page.tsx).']);
  }
}

// Sort for a stable baseline file.
const sorted = Object.fromEntries(RATCHET.map(([id]) => [id, Object.fromEntries(Object.entries(counts[id] ?? {}).sort())]));

if (update) {
  await writeFile(baselinePath, JSON.stringify(sorted, null, 2) + '\n');
  const total = (id) => Object.values(sorted[id]).reduce((a, b) => a + b, 0);
  console.log('Design baseline updated:', RATCHET.map(([id]) => `${id} ${total(id)}`).join(', '));
} else {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8').catch(() => '{}'));
  const lowered = [];
  for (const [id, message] of RATCHET) {
    for (const [rel, n] of Object.entries(sorted[id])) {
      const allowed = baseline[id]?.[rel] ?? 0;
      if (n > allowed) failures.push([rel, 0, id, `${message} ${n} here, the baseline allows ${allowed}.`]);
      else if (n < allowed) lowered.push(`${id} ${rel}: ${allowed} -> ${n}`);
    }
    for (const [rel, allowed] of Object.entries(baseline[id] ?? {})) {
      if (!(rel in sorted[id]) && allowed > 0) lowered.push(`${id} ${rel}: ${allowed} -> 0`);
    }
  }
  if (lowered.length) {
    console.log(`Fewer legacy patterns than the baseline records (${lowered.length}). Run \`npm run design:baseline\` to lock in the progress.`);
  }
}

if (failures.length) {
  for (const [rel, line, id, message] of failures) console.error(`ui/src/${rel}${line ? `:${line}` : ''}  [${id}] ${message}`);
  console.error(`\n${failures.length} design check failure(s). See docs/design-system.md. A justified exception takes a "design-exception: <reason>" comment.`);
  process.exit(1);
}
if (!update) console.log(`Design checks OK (${files.length} files)`);
