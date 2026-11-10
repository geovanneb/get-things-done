#!/usr/bin/env node
/**
 * Browser checks for the dashboard's design system (docs/design-system.md).
 *
 * Starts the built app on a throwaway demo workspace (its own HOME, never your config),
 * then for every page at phone, tablet and desktop widths:
 *   - layout: no sideways scroll of the page
 *   - structure: exactly one h1
 *   - names: every button and link has an accessible name, every field a label
 *   - errors: no uncaught page errors
 * and once:
 *   - contrast: text and field-edge colour tokens meet WCAG AA in both themes and every accent
 *   - keyboard: a dialog takes focus, keeps Tab inside, closes on Escape and gives focus back;
 *     tabs move with the arrow keys
 *   - visual: screenshots of stable screens compared with ui/visual-baselines/<platform>/
 *
 * Needs a build (`npm run build`) and Playwright with Chromium:
 *   npm i --no-save playwright && npx playwright install chromium
 *
 *   npm run test:visual                 run every check
 *   npm run test:visual -- --update     rewrite the screenshot baselines for this platform
 *
 * Screenshots differ between operating systems (font rendering), so baselines are kept per
 * platform. With no baseline for this platform, screenshots are written to .visual-output/
 * for review and only the behaviour checks decide the result.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const update = process.argv.includes('--update');
const outDir = path.join(root, '.visual-output');
const baselineDir = path.join(root, 'ui/visual-baselines', process.platform);
// A screenshot may differ by this share of pixels (anti-aliasing) before it counts as changed.
const MAX_DIFF_RATIO = 0.004;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'dist/ui/index.html'))) {
  console.error('No build found. Run `npm run build` first.');
  process.exit(1);
}

// Every routed page. `compare` marks the ones whose content does not depend on today's date or the temp folder.
const PAGES = [
  { path: '/design-system', compare: true },
  { path: '/situation' },
  { path: '/board' },
  { path: '/board/task/TASK-2026-0001' },
  { path: '/meetings' },
  { path: '/insights' },
  { path: '/context' },
  { path: '/context/updates' },
  { path: '/stakeholders', compare: true },
  { path: '/stakeholders?tab=groups' },
  { path: '/stakeholders?tab=charts' },
  { path: '/outputs', compare: true },
  { path: '/agents' },
  { path: '/agent-floor' },
  { path: '/routines' },
  { path: '/profile', compare: true },
  { path: '/settings' },
];
const WIDTHS = [390, 768, 1280];

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// ---- A throwaway demo workspace -------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-visual-'));
const home = path.join(tmp, 'home');
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(home);
const port = 4100 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, USERPROFILE: home };
execFileSync(process.execPath, [path.join(root, 'bin/gtd.js'), 'init', '-y', '-d', ws,
  '--name', 'Alex Morgan', '--role', 'COO', '--org', 'Northwind Labs', '--ai', 'claude-code'], { env, stdio: 'pipe' });
const server = spawn(process.execPath, [path.join(root, 'dist/server/index.js')], {
  env: { ...env, ESB_WORKSPACE_PATH: ws, ESB_UI_PATH: path.join(root, 'dist/ui'), PORT: String(port), NODE_ENV: 'production', GTD_DISABLE_UPDATES: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverLog = (serverLog + chunk).slice(-8000); });

let browser;
try {
  let healthy = false;
  // A busy CI runner can take well over ten seconds to load the server for the first time.
  const startDeadline = Date.now() + 60_000;
  while (!healthy && Date.now() < startDeadline) {
    try { healthy = (await fetch(`${base}/health`)).ok; } catch { /* not listening yet */ }
    if (!healthy) await new Promise((r) => setTimeout(r, 200));
  }
  if (!healthy) throw new Error(`the server did not start: ${serverLog}`);
  execFileSync(process.execPath, [path.join(root, 'scripts/seed-demo.mjs'), base], { env, stdio: 'pipe' });
  for (const [endpoint, prefix] of [['/api/stakeholders', '/stakeholders/'], ['/api/context-updates', '/context/updates/']]) {
    const records = await (await fetch(base + endpoint)).json();
    if (records[0]) PAGES.push({ path: prefix + records[0].id });
  }
  // Two fictional meetings in the queue, so the Meetings page shows its list.
  for (const [title, date] of [['Weekly logistics sync', '2026-10-30'], ['Q4 board prep', '2026-10-31']]) {
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const meeting = await (await post('/api/meeting-queue', { title, meeting_date: date, participants: [{ name: 'Kim Park' }] })).json();
    if (title === 'Weekly logistics sync') PAGES.push({ path: `/meetings/${meeting.id}` });
    const form = new FormData();
    form.append('file', new Blob(['WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Speaker 1>Fictional words.</v>\n']), 'notes.vtt');
    await fetch(`${base}/api/meeting-queue/${meeting.id}/files`, { method: 'POST', body: form });
    await post(`/api/meeting-queue/${meeting.id}/queue`);
  }

  // Same text rendering on every run: no sub-pixel anti-aliasing or hinting, one colour profile.
  const args = ['--font-render-hinting=none', '--disable-lcd-text', '--disable-font-subpixel-positioning', '--force-color-profile=srgb'];
  browser = await chromium.launch({ args, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  fs.mkdirSync(outDir, { recursive: true });
  if (update) fs.mkdirSync(baselineDir, { recursive: true });

  const open = async (width, theme = 'light') => {
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addInitScript((t) => { try { localStorage.setItem('gtd:theme', t); } catch { /* storage blocked */ } }, theme);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, errors };
  };
  const settle = async (page) => {
    // The live-events stream keeps the network busy, so wait for the page itself instead.
    await page.waitForLoadState('load');
    // A lazy route may not have mounted yet; absence of a spinner alone is not readiness.
    // Still run the heading assertion if it never appears, rather than silently skipping the page.
    await page.locator('h1').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('[role="status"] .gtd-spin'), null, { timeout: 8000 }).catch(() => {});
    // Load every weight the UI uses before measuring or taking a picture, so a late font swap cannot change it.
    await page.evaluate(async () => {
      const faces = ['400', '500', '600', '700'].map((w) => `${w} 14px "IBM Plex Sans"`).concat(['400 14px "IBM Plex Mono"', '600 14px "IBM Plex Mono"']);
      await Promise.all(faces.map((f) => document.fonts.load(f).catch(() => [])));
      await document.fonts.ready;
    });
    await page.waitForTimeout(300);
  };

  // Selecting Archived is still an unsaved edit; only a saved archived task is read-only.
  for (const theme of ['light', 'dark']) for (const width of WIDTHS) {
    const { context, page } = await open(width, theme);
    await page.goto(base + '/board/task/TASK-2026-0001');
    await settle(page);
    const status = page.getByRole('combobox', { name: 'Status', exact: true });
    await status.selectOption('archived');
    const editable = await status.isEnabled();
    check(`a draft archived status can still be saved or changed @${width} ${theme}`,
      editable && await page.getByRole('button', { name: 'Save changes', exact: true }).isVisible());
    if (editable) {
      await status.focus();
      await page.keyboard.press('d');
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => [...document.querySelectorAll('select')].some((field) => field.value === 'done'));
      check(`a draft archived status can be changed with the keyboard @${width} ${theme}`, await status.inputValue() === 'done');
    }
    await page.route('**/api/tasks/TASK-2026-0001', async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), status: 'archived' } });
    });
    await page.reload();
    await settle(page);
    check(`a saved archived task remains read-only @${width} ${theme}`,
      await status.isDisabled() && await page.getByRole('button', { name: 'Save changes', exact: true }).count() === 0);
    await context.close();
  }

  // Release regressions: old results must not be actionable while a new query is pending.
  for (const theme of ['light', 'dark']) for (const width of WIDTHS) {
    const { context, page } = await open(width, theme);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/api/search?*', async route => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === 'second') await pending;
      await route.fulfill({ json: q === 'first' ? [{ id: 'TASK-2026-0001', type: 'task', title: 'Fictional first result' }] : [] });
    });
    await page.goto(base + '/board');
    await settle(page);
    await page.getByRole('button', { name: 'Open search', exact: true }).focus();
    await page.keyboard.press('Enter');
    const field = page.getByRole('dialog').getByRole('textbox');
    await field.fill('first');
    await page.getByRole('option', { name: /Fictional first result/ }).waitFor();
    await field.fill('second');
    await field.press('Enter');
    check(`search: Enter cannot open a result from the previous query @${width} ${theme}`, await page.getByRole('dialog', { name: 'Search', exact: true }).isVisible());
    release();
    await context.close();
  }

  // A slower comparison must never replace the file selected most recently.
  for (const theme of ['light', 'dark']) for (const width of WIDTHS) {
    const { context, page } = await open(width, theme);
    const rows = ['AGENTS.md', 'CLAUDE.md'].map(path => ({ path, state: 'ready', mine_sha256: 'mine', app_sha256: 'app' }));
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/api/app/instruction-updates', route => route.fulfill({ json: rows }));
    await page.route('**/api/app/instruction-updates/compare?*', async route => {
      const file = new URL(route.request().url()).searchParams.get('path');
      if (file === 'AGENTS.md') await pending;
      await route.fulfill({ json: { ...rows.find(row => row.path === file), mine: 'Fictional original', app: `Fictional new ${file}` } });
    });
    await page.goto(base + '/settings');
    await settle(page);
    const panel = page.locator('#instruction-updates');
    const firstRequest = page.waitForRequest('**/api/app/instruction-updates/compare?path=AGENTS.md');
    await panel.getByRole('button', { name: 'Compare', exact: true }).first().focus();
    await page.keyboard.press('Enter');
    await firstRequest;
    await panel.getByRole('button', { name: 'Compare', exact: true }).last().focus();
    await page.keyboard.press('Enter');
    await panel.getByText('Fictional new CLAUDE.md', { exact: true }).waitFor();
    const response = page.waitForResponse('**/api/app/instruction-updates/compare?path=AGENTS.md');
    release();
    await response;
    await page.waitForTimeout(100);
    check(`instructions: a late comparison cannot replace the latest selection @${width} ${theme}`, await panel.getByText('Fictional new CLAUDE.md', { exact: true }).isVisible());
    await context.close();
  }

  // Clearing a stakeholder's email and notes in the edit form removes them, rather than keeping the old values;
  // fields left as loaded are not sent.
  {
    const { context, page } = await open(1280);
    const send = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const person = await (await send('POST', '/api/stakeholders', { name: 'Fictional Clearing', email: 'fictional.clearing@example.test', notes: 'Fictional note.' })).json();
    await page.goto(`${base}/stakeholders`);
    await settle(page);
    await page.getByRole('button', { name: 'Edit Fictional Clearing', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const email = dialog.getByRole('textbox', { name: 'Email', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] input')].some((i) => i.value === 'fictional.clearing@example.test'));
    await email.fill('');
    await dialog.getByRole('textbox', { name: 'Notes', exact: true }).fill('');
    await dialog.getByRole('button', { name: /save/i }).click();
    await dialog.waitFor({ state: 'hidden' });
    const saved = await (await fetch(`${base}/api/stakeholders/${person.id}`)).json();
    check('stakeholders: clearing email and notes in the form removes them', saved.email === undefined && saved.notes === undefined,
      JSON.stringify({ email: saved.email, notes: saved.notes }));
    // Fields left as loaded are not sent, so what an agent writes while the dialog is open is kept.
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes(`/api/stakeholders/${person.id}`)) puts.push(r.postDataJSON()); });
    await page.getByRole('button', { name: 'Edit Fictional Clearing', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Role', exact: true }).fill('Fictional role');
    await send('PUT', `/api/stakeholders/${person.id}`, { email: 'fictional.agent@example.test', notes: 'Fictional agent note.' });
    await dialog.getByRole('button', { name: /save/i }).click();
    await dialog.waitFor({ state: 'hidden' });
    const kept = await (await fetch(`${base}/api/stakeholders/${person.id}`)).json();
    check('stakeholders: an unchanged empty email and notes are not sent, so other writes are kept',
      puts.length === 1 && !('email' in puts[0]) && !('notes' in puts[0]) && kept.role === 'Fictional role'
        && kept.email === 'fictional.agent@example.test' && kept.notes?.trim() === 'Fictional agent note.',
      JSON.stringify({ sent: puts, email: kept.email, notes: kept.notes, role: kept.role }));
    await send('DELETE', `/api/stakeholders/${person.id}`);
    await context.close();
  }

  // ---- Behaviour on every page and width ----------------------------------
  if (!process.argv.includes('--language-only')) {
  for (const theme of ['light', 'dark']) {
    for (const width of WIDTHS) {
      const { context, page, errors } = await open(width, theme);
      for (const { path: route } of PAGES) {
        await page.goto(base + route);
        await settle(page);
        const report = await page.evaluate(() => {
          const main = document.querySelector('main') ?? document.body;
          const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()
            || [...el.querySelectorAll('[aria-label],[title]')].map((x) => x.getAttribute('aria-label') || x.getAttribute('title')).join('').trim()
            || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim());
          const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
          const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea')].filter(visible);
          const unlabelled = fields.filter((el) => !(el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label')));
          const unnamed = [...document.querySelectorAll('button, a[href], [role="tab"]')].filter(visible).filter((el) => !name(el));
          return {
            // What a person can actually scroll: the content area, and the window itself.
            overflow: Math.max(0, main.scrollWidth - main.clientWidth, (window.scrollTo(10000, 0), window.scrollX)),
            h1: document.querySelectorAll('h1').length,
            unlabelled: unlabelled.map((el) => el.outerHTML.slice(0, 90)),
            unnamed: unnamed.map((el) => el.outerHTML.slice(0, 90)),
          };
        });
        if (route === '/design-system') {
          await page.getByText('Search', { exact: true }).click();
          check(`search label focuses its field @${width} ${theme}`, await page.locator('#showcase-search').evaluate((el) => el === document.activeElement));
          const nested = await page.evaluate(() => {
            const original = document.querySelector('.gtd-card');
            const outer = document.createElement('div');
            outer.className = 'gtd-card gtd-card--compact';
            const clone = original.cloneNode(true);
            outer.append(clone); original.after(outer);
            const before = getComputedStyle(original.querySelector('.gtd-card__body')).padding;
            const after = getComputedStyle(clone.querySelector('.gtd-card__body')).padding;
            outer.remove();
            return before === after;
          });
          check(`nested cards keep their own padding @${width} ${theme}`, nested);
        }
        if (route === '/board') {
          const edit = page.getByRole('button', { name: 'Edit columns…' });
          await edit.focus();
          await page.keyboard.press('Enter');
          const dialog = page.getByRole('dialog', { name: 'Edit columns', exact: true });
          await dialog.waitFor();
          const press = async (name) => {
            await dialog.getByRole('button', { name, exact: true }).focus();
            await page.keyboard.press('Enter');
            // Reordering/removal restores focus on the next animation frame. Let it finish before the next key.
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          };
          await press('Add column');
          await page.waitForFunction(() => document.querySelectorAll('.gtd-modal input').length === 5 && document.activeElement === [...document.querySelectorAll('.gtd-modal input')].at(-1));
          const names = dialog.getByRole('textbox', { name: 'Name' });
          await names.last().focus();
          await page.keyboard.press('ControlOrMeta+A');
          await page.keyboard.type('Fictional waiting');
          await press('Move Fictional waiting up');
          check(`board editor: keyboard adds and reorders @${width} ${theme}`,
            await names.nth(3).inputValue() === 'Fictional waiting');
          const overflow = await dialog.locator('.gtd-modal__panel').evaluate((el) => el.scrollWidth - el.clientWidth);
          check(`board editor: no sideways scroll @${width} ${theme}`, overflow <= 1, `${overflow}px overflow`);
          await press('Save columns');
          await dialog.waitFor({ state: 'hidden' });
          const saved = await (await page.request.get(`${base}/api/workspace/board`)).json();
          check(`board editor: saves the edited order @${width} ${theme}`,
            saved.columns.length === 5 && saved.columns[3].label === 'Fictional waiting');
          await edit.focus();
          await page.keyboard.press('Enter');
          await dialog.waitFor();
          await press('Remove Fictional waiting');
          await press('Cancel');
          await dialog.waitFor({ state: 'hidden' });
          const kept = await (await page.request.get(`${base}/api/workspace/board`)).json();
          check(`board editor: Cancel preserves saved columns @${width} ${theme}`, kept.columns.length === 5);
          await page.request.delete(`${base}/api/workspace/board`);
        }
        if (route === '/stakeholders?tab=charts') {
          await page.getByRole('tab', { name: 'Chart', exact: true }).focus();
          await page.keyboard.press('ArrowRight');
          check(`chart keyboard navigation @${width} ${theme}`, await page.getByRole('tab', { name: 'Outline', exact: true }).getAttribute('aria-selected') === 'true');
          await page.keyboard.press('Home');
        }
        const routeShots = path.join(outDir, 'routes');
        fs.mkdirSync(routeShots, { recursive: true });
        await page.screenshot({ path: path.join(routeShots, `${route.replace(/\W+/g, '-')}-${width}-${theme}.png`) });
        const where = `${route} @${width} ${theme}`;
        check(`${where}: no sideways scroll`, report.overflow <= 1, `${report.overflow}px wider than the window`);
        check(`${where}: one h1`, report.h1 === 1, `${report.h1} h1 elements`);
        check(`${where}: every field has a label`, report.unlabelled.length === 0, report.unlabelled.join(' | '));
        check(`${where}: every button and link has a name`, report.unnamed.length === 0, report.unnamed.join(' | '));
      }
      check(`no page errors @${width} ${theme}`, errors.length === 0, errors.slice(0, 3).join(' | '));
      await context.close();
    }
  }

  // ---- Contrast of the colour tokens, per theme and accent ------------------
  for (const theme of ['light', 'dark']) {
    const { context, page } = await open(1280, theme);
    await page.goto(`${base}/design-system`);
    await settle(page);
    for (const accent of ['blue', 'violet', 'teal', 'green', 'amber', 'rose']) {
      const low = await page.evaluate((acc) => {
        document.documentElement.setAttribute('data-accent', acc);
        const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d', { willReadFrequently: true });
        const rgb = (token) => {
          const probe = document.createElement('div'); probe.style.color = `var(${token})`; document.body.appendChild(probe);
          const value = getComputedStyle(probe).color; probe.remove();
          g.clearRect(0, 0, 1, 1); g.fillStyle = value; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const lum = (v) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]); };
        const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        // [foreground, background, minimum]: 4.5 for text (WCAG 1.4.3), 3 for a field's edge (WCAG 1.4.11).
        const pairs = [
          ['--color-text', '--color-surface', 4.5], ['--color-text-secondary', '--color-bg', 4.5],
          ['--color-text-muted', '--color-surface', 4.5], ['--color-text-muted', '--color-bg', 4.5], ['--color-text-muted', '--color-surface-hover', 4.5],
          ['--color-accent', '--color-surface', 4.5], ['--color-accent', '--color-accent-subtle', 4.5], ['--color-text-on-accent', '--color-accent', 4.5],
          ['--color-critical', '--color-critical-subtle', 4.5], ['--color-warning', '--color-warning-subtle', 4.5],
          ['--color-success', '--color-success-subtle', 4.5], ['--color-info', '--color-info-subtle', 4.5],
          ['--color-border-control', '--color-surface', 3], ['--color-border-control', '--color-bg', 3],
          ['--nav-text', '--nav-bg', 4.5],
        ];
        return pairs.map(([f, b, min]) => [f, b, ratio(f, b), min]).filter(([, , r, min]) => r < min - 0.005)
          .map(([f, b, r, min]) => `${f} on ${b} ${r.toFixed(2)} < ${min}`);
      }, accent);
      check(`contrast: ${theme} theme, ${accent} accent`, low.length === 0, low.join('; '));
    }
    await context.close();
  }

  // ---- Keyboard: dialogs and tabs -----------------------------------------
  {
    const { context, page } = await open(1280);
    await page.goto(`${base}/design-system`);
    await settle(page);
    const trigger = page.getByRole('button', { name: 'Destructive confirmation' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="alertdialog"]');
    const focusInDialog = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]')));
    check('keyboard: a confirmation takes focus', focusInDialog);
    check('keyboard: a destructive confirmation starts on Cancel', (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancel');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    check('keyboard: Tab stays inside the dialog', await page.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]'))));
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="alertdialog"]', { state: 'detached' });
    check('keyboard: Escape closes the dialog and focus goes back to its button',
      (await page.evaluate(() => document.activeElement?.textContent)) === 'Destructive confirmation');

    // The Record a meeting dialog is a long form: the large size, and Start waits for consent.
    await page.goto(`${base}/meetings`);
    await settle(page);
    await page.getByRole('button', { name: 'Record a meeting' }).first().click();
    const recordPanel = page.locator('.gtd-modal__panel');
    await recordPanel.waitFor();
    const panelWidth = (await recordPanel.boundingBox())?.width ?? 0;
    check('dialogs: Record a meeting opens at the large form size', panelWidth >= 700, `${Math.round(panelWidth)}px wide`);
    const startButton = page.getByRole('button', { name: 'Start recording' });
    check('dialogs: Start recording waits until everyone was told', await startButton.isDisabled());
    await page.getByLabel(/told everyone/i).check();
    check('dialogs: Start recording is enabled once consent is given', await startButton.isEnabled());
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.goto(`${base}/design-system`);
    await settle(page);

    const firstTab = page.getByRole('tab', { name: 'Kanban' });
    await firstTab.focus();
    await page.keyboard.press('ArrowRight');
    check('keyboard: arrow keys move between tabs',
      await page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement?.getAttribute('aria-selected') === 'true' && document.activeElement.textContent?.startsWith('List')));
    await page.goto(`${base}/stakeholders?tab=charts`);
    await settle(page);
    await page.getByRole('tab', { name: 'Chart', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    check('keyboard: chart views use the shared tab navigation', await page.getByRole('tab', { name: 'Outline', exact: true }).getAttribute('aria-selected') === 'true');
    await page.keyboard.press('End');
    check('keyboard: End reaches the last chart view', await page.getByRole('tab', { name: 'Units', exact: true }).getAttribute('aria-selected') === 'true');
    await context.close();
  }

  // A failed attachment fetch must offer recovery, never claim the folder is empty.
  {
    const { context, page } = await open(390);
    let failFiles = true;
    await page.route('**/api/outputs/templates/*/files', async (route) => {
      if (failFiles) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary failure' }) });
      else await route.continue();
    });
    await page.goto(`${base}/outputs`);
    await settle(page);
    await page.getByRole('button', { name: /^Edit / }).first().click();
    await page.getByText('Could not load attached files.', { exact: true }).waitFor();
    check('attachments: a failed request is not an empty folder', await page.getByText('No files attached.', { exact: true }).count() === 0);
    failFiles = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Attach file', exact: true }).waitFor();
    check('attachments: retry recovers without reopening the dialog', await page.getByText('Could not load attached files.', { exact: true }).count() === 0);
    await context.close();
  }

  // ---- Visual: screenshots of stable screens -------------------------------
  const haveBaselines = fs.existsSync(baselineDir) && fs.readdirSync(baselineDir).some((f) => f.endsWith('.png'));
  if (!haveBaselines && !update) {
    console.log(`No screenshot baselines for ${process.platform}. Screenshots are in .visual-output/ for review; run with --update to record them.`);
  }
  for (const theme of ['light', 'dark']) {
    for (const width of theme === 'dark' ? [1280] : [390, 1280]) {
      const { context, page } = await open(width, theme);
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
      for (const { path: route, compare } of PAGES) {
        if (!compare) continue;
        await page.goto(base + route);
        await settle(page);
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
        const file = `${route.replace(/\W+/g, '-').replace(/^-|-$/g, '')}-${width}-${theme}.png`;
        // <main> scrolls inside a fixed-height shell: let the shell grow so the whole page is captured.
        await page.evaluate(() => {
          const main = document.querySelector('main');
          for (let el = main; el && el !== document.documentElement; el = el.parentElement) { el.style.height = 'auto'; el.style.overflow = 'visible'; }
        });
        const shot = await page.locator('main').screenshot();
        fs.writeFileSync(path.join(outDir, file), shot);
        const baseline = path.join(baselineDir, file);
        if (update) { fs.writeFileSync(baseline, shot); continue; }
        if (!fs.existsSync(baseline)) continue;
        const ratio = await page.evaluate(async ([a, b]) => {
          const load = (data) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.src = `data:image/png;base64,${data}`; });
          const [x, y] = await Promise.all([load(a), load(b)]);
          if (x.width !== y.width || x.height !== y.height) return 1;
          const pixels = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
          const p = pixels(x), q = pixels(y);
          let diff = 0;
          for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 48) diff++;
          return diff / (p.length / 4);
        }, [shot.toString('base64'), fs.readFileSync(baseline).toString('base64')]);
        check(`visual: ${file} matches its baseline`, ratio <= MAX_DIFF_RATIO, `${(ratio * 100).toFixed(2)}% of pixels changed; see .visual-output/${file}`);
      }
      await context.close();
    }
  }
  }
  // Personal interface language: real browser detection, native bridge precedence, keyboard override,
  // persistence and failed saves. Each case uses the fictional workspace above.
  const setLanguage = async (language) => {
    const response = await fetch(`${base}/api/app/language`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) });
    if (!response.ok) throw new Error('Could not set test language');
  };
  await setLanguage('auto');
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 768, 1280]) {
      const context = await browser.newContext({ locale: 'ja-JP', viewport: { width, height: 900 } });
      await context.addInitScript(t => localStorage.setItem('gtd:theme', t), theme);
      const page = await context.newPage();
      await page.goto(`${base}/settings`);
      await page.waitForFunction(() => document.documentElement.lang === 'ja');
      const language = page.getByLabel('言語', { exact: true });
      await language.waitFor({ state: 'visible' });
      check(`language: Japanese automatic ${width} ${theme}`, await language.inputValue() === 'auto' && await page.locator('h1').textContent() === '設定');
      check(`language: Settings and the shell are translated ${width} ${theme}`, await page.getByRole('heading', { name: '通知', exact: true }).isVisible() && await page.getByRole('button', { name: 'ワークスペースを検証', exact: true }).isVisible());
      check(`language: no overflow ${width} ${theme}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await language.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(outDir, `language-ja-${width}-${theme}.png`) });
      await language.selectOption('en');
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      const english = page.getByLabel('Language', { exact: true });
      await english.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      check(`language: keyboard focus ${width} ${theme}`, await english.evaluate(element => element === document.activeElement));
      // Headless Chromium on macOS does not drive native select popups with arrow keys.
      // Exercise the native selection event separately; real OS popup selection remains manual QA.
      await english.selectOption('ja');
      await page.waitForFunction(() => document.documentElement.lang === 'ja');
      check(`language: immediate override ${width} ${theme}`, await language.inputValue() === 'ja');
      await page.reload();
      await page.waitForFunction(() => document.documentElement.lang === 'ja');
      check('language: preference survives reload', await page.getByLabel('言語', { exact: true }).inputValue() === 'ja');
      await setLanguage('auto');
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ locale: 'ja-JP' });
    await context.addInitScript(() => { window.gtdDesktop = { version: 1, preferredLanguages: async () => ['pt-PT'] }; });
    const page = await context.newPage();
    await page.goto(`${base}/settings`);
    await page.waitForFunction(() => document.documentElement.lang === 'pt-BR');
    check('language: desktop system preferences override browser language', await page.locator('h1').textContent() === 'Configurações');
    await page.route('**/api/app/language', async route => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      else await route.continue();
    });
    await page.getByLabel('Idioma', { exact: true }).selectOption('es-419');
    await page.getByText('Não foi possível salvar o idioma. Tente novamente.').waitFor();
    check('language: failed save retains previous language and choice', await page.getByLabel('Idioma', { exact: true }).inputValue() === 'auto' && await page.locator('html').getAttribute('lang') === 'pt-BR');
    await page.unroute('**/api/app/language');
    await page.getByLabel('Idioma', { exact: true }).selectOption('es-419');
    await page.waitForFunction(() => document.documentElement.lang === 'es-419');
    check('language: Spanish applies without restart', await page.locator('h1').textContent() === 'Configuración');
    await context.close();
    await setLanguage('auto');
  }
  if (update) console.log(`Baselines written to ${path.relative(root, baselineDir)}/`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} visual check failure(s)` : '\nAll visual checks passed');
process.exit(failures ? 1 : 0);
