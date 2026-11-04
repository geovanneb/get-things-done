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
  stdio: 'ignore',
});

let browser;
try {
  let healthy = false;
  for (let i = 0; i < 50 && !healthy; i++) {
    try { healthy = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!healthy) throw new Error('the server did not start');
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

  // ---- Behaviour on every page and width ----------------------------------
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
