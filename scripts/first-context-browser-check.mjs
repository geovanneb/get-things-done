/** Onboarding regressions, called by visual-check.mjs against its disposable workspace. */
/* global document, innerWidth -- callbacks execute in the browser */
import path from 'node:path';

export async function checkFirstContext({ open, base, check, settle, outDir }) {
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const update = await (await post('/api/first-context/update', { title: 'Fictional onboarding files' })).json();
  const form = new FormData();
  form.append('file', new Blob(['Fictional user notes, not a generated interview.']), 'first-context-interview.md');
  const uploaded = await fetch(`${base}/api/context-updates/${update.id}/materials`, { method: 'POST', body: form });
  if (!uploaded.ok) throw new Error(`Onboarding fixture upload: ${uploaded.status}`);

  for (const theme of ['light', 'dark'])
    for (const width of [390, 768, 1280]) {
      const { context, page, errors } = await open(width, theme);
      const at = `@${width} ${theme}`;
      try {
        await page.goto(base + '/get-started');
        await settle(page);
        check(
          `onboarding: a same-named user file enables submission ${at}`,
          await page.getByRole('button', { name: 'Organize my workspace', exact: true }).isEnabled(),
        );
        const edit = page.getByRole('button', { name: 'Edit Add your files', exact: true });
        await edit.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: 'Add your files', exact: true }).waitFor();
        check(
          `onboarding: keyboard navigation focuses the step heading ${at}`,
          await page.locator('h1').evaluate((el) => el === document.activeElement),
        );
        check(
          `onboarding: the user file remains visible ${at}`,
          await page.getByText('first-context-interview.md', { exact: true }).isVisible(),
        );
        check(
          `onboarding: files fit the viewport ${at}`,
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        );
        await page.screenshot({ path: path.join(outDir, `first-context-files-${width}-${theme}.png`) });
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Edit You and your work', exact: true }).click();
        const question = page.getByRole('textbox', { name: 'What are your priorities right now?', exact: true });
        // A failed autosave must retain the text and prevent Finish later from navigating away.
        await page.route('**/api/first-context', (route) =>
          route.request().method() === 'PUT'
            ? route.fulfill({ status: 503, json: { message: 'Fictional save failure' } })
            : route.continue(),
        );
        await question.fill(`Fictional delivery plan ${width} ${theme}`);
        await page.getByRole('button', { name: 'Finish later', exact: true }).click();
        await page.getByText('Your latest answers could not be saved.', { exact: false }).waitFor();
        check(
          `onboarding: failed saves keep the draft on screen ${at}`,
          page.url().endsWith('/get-started') && (await question.inputValue()).includes('Fictional delivery plan'),
        );
        await page.unroute('**/api/first-context');
        await page.getByRole('button', { name: 'Finish later', exact: true }).click();
        await page.waitForURL('**/situation');
        const prompt = page.locator('.gtd-notice').filter({ hasText: 'Give Claude Code a head start' });
        await prompt.waitFor();
        check(
          `onboarding: the resume prompt leaves room for its message ${at}`,
          await prompt.evaluate(
            (el) =>
              el.querySelector('.gtd-notice__body').getBoundingClientRect().width >
              el.getBoundingClientRect().width / 2,
          ),
        );
        const saved = await (await fetch(base + '/api/first-context')).json();
        check(
          `onboarding: retry saves before leaving ${at}`,
          saved.answers.work.priorities === `Fictional delivery plan ${width} ${theme}`,
        );
        check(`onboarding: no browser errors ${at}`, errors.length === 0, errors.join('; '));
      } finally {
        await context.close();
      }
    }
}
