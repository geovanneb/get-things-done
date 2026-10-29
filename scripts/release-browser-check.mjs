/**
 * Opt-in browser regression against a disposable workspace seeded by seed-demo.mjs.
 * See docs/phase-1-audit.md for setup. Never point this at real data.
 */
/* global document -- callbacks below execute inside the browser */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base = process.env.GTD_TEST_URL;
const workspace = process.env.GTD_TEST_WORKSPACE;
if (!base || !workspace) throw new Error('Set GTD_TEST_URL and GTD_TEST_WORKSPACE to a disposable seeded workspace');
const url = new URL(base);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Browser regressions require a local server');
const config = await (await fetch(base + '/api/workspace')).json();
assert.equal(config.path, workspace, 'The server must use the explicitly selected test workspace');
const artifacts = process.env.GTD_TEST_ARTIFACTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-browser-results-')));
await fs.mkdir(artifacts, { recursive: true });
console.log('Browser artifacts:', artifacts);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [],
  checks = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
async function shot(name) {
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
}
async function focusCycle(dialog) {
  for (const key of ['Shift+Tab', ...Array(35).fill('Tab'), ...Array(35).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    assert(await dialog.evaluate((el) => el.contains(document.activeElement)), `Focus escaped on ${key}`);
  }
}
try {
  await page.goto(base + '/routines');
  const card = page.getByRole('article', { name: 'System cleanup' });
  await card.getByRole('button', { name: 'Settings', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await focusCycle(dialog);
  check('Cleanup dialog traps forward and reverse focus');
  await dialog.getByLabel('How often').selectOption('biweekly');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.waitForTimeout(300);
  await shot('cleanup-preview');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.match(await card.innerText(), /Every 2 weeks/);
  check('Cleanup preview and schedule save');
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await card.getByRole('link', { name: /CU-/ }).waitFor();
  check('Run cleanup creates memory review');
  await card.getByRole('link', { name: /CU-/ }).click();
  await page.getByRole('region', { name: 'Next step', exact: true }).waitFor();
  await shot('memory-review');
  check('Memory review opens with next-step command');
  await page.goto(base + '/stakeholders');
  await page.getByText('Daniel Okafor', { exact: true }).click();
  await page.getByRole('button', { name: /Prepare.*meeting/i }).click();
  dialog = page.getByRole('dialog', { name: 'New Task' });
  assert.equal(
    await dialog.getByPlaceholder('What needs to get done?').inputValue(),
    'Prepare: meeting with Daniel Okafor',
  );
  assert.equal(await dialog.getByLabel('Preferred agent').inputValue(), 'meeting-prep');
  await focusCycle(dialog);
  check('Meeting prep prepopulates title, stakeholder and agent and traps focus');
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  await page.waitForURL(/\/board\/task\/TASK-/);
  dialog = page.getByRole('dialog', { name: 'Task details' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).waitFor();
  await focusCycle(dialog);
  await shot('created-task');
  check('Meeting task creation and task-detail keyboard navigation');
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  check('Escape closes task details');
  await page.goto(base + '/context/updates');
  await page.getByRole('button', { name: 'Import update', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Import context update' });
  await dialog.getByLabel('Title', { exact: true }).fill('Fictional browser regression import');
  await dialog
    .getByLabel('Pasted text')
    .fill('Fictional release planning notes. The team will review the draft next week.');
  await dialog.getByRole('button', { name: 'Save and get command' }).click();
  await page.waitForURL(/\/context\/updates\/CU-/);
  const keep = page.getByRole('checkbox');
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/keep-materials') && r.request().method() === 'PUT'),
    keep.click(),
  ]);
  await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked);
  await page.waitForTimeout(300);
  await page.reload();
  await keep.waitFor();
  assert(await keep.isChecked());
  check('Context import and keep-materials choice persist through reload');
  await shot('retained-materials');
  await page.goto(base + '/insights');
  for (const label of ['7 days', '90 days', 'All time', '30 days']) {
    await page.getByRole('group', { name: 'Time window' }).getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
  }
  check('All four Insights time windows');
  await page.goto(base + '/stakeholders');
  await page.getByRole('tab', { name: /Org charts/ }).click();
  assert.match(page.url(), /tab=charts/);
  await page.goto(base + '/board');
  await page.goBack();
  await page.waitForURL(/tab=charts/);
  assert.match(page.url(), /tab=charts/);
  check('Org-chart tab survives browser Back');
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['situation', 'board', 'routines', 'context/updates']) {
      await page.goto(base + '/' + route);
      await page.locator('main').waitFor();
      await page.waitForTimeout(250);
      if (route === 'board') {
        const column = page.getByText('Backlog', { exact: true }).first();
        assert((await column.boundingBox()).width > 0);
      }
      await shot(`${route.replaceAll('/', '-')}-${width}`);
    }
  }
  check('Captured tablet and narrow-width layouts');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(base + '/board');
  await page.locator('main').waitFor();
  await page.waitForTimeout(200);
  await shot('board-dark');
  check('Dark theme rendered');
  assert.deepEqual(errors, []);
  check('No browser JavaScript errors');
} finally {
  await fs.writeFile(path.join(artifacts, 'regression-results.json'), JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
}
