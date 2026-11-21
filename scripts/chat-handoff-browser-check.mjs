/**
 * Chat handoff ("Continue in assistant"), called by visual-check.mjs against its disposable workspace.
 * No AI tool and no terminal is started: the tool check and the launcher are answered by stubs, and the launcher stub
 * refuses a request for a workspace that is not the open one, as the server does.
 */
/* global document, window -- callbacks execute in the browser */
import fs from 'node:fs';
import path from 'node:path';

export async function checkChatHandoff({ open, base, check, settle, ws }) {
  const id = 'chat-handoffcheck01';
  const dir = path.join(ws, '.situation-board', 'chat');
  const file = path.join(dir, `${id}.json`);
  const at = '2026-11-20T00:00:00.000Z';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    id, title: 'Fictional handoff chat', provider: 'claude-code', model: null, effort: null, carry_over: false, created_at: at, updated_at: at, usage: null,
    messages: [
      { id: 'm1', role: 'user', text: 'What is due this week?', created_at: at },
      { id: 'm2', role: 'assistant', text: 'TASK-2026-0001 is due Friday.', created_at: at, status: 'done' },
      { id: 'm3', role: 'user', text: 'Who owns it?', created_at: at },
      { id: 'm4', role: 'assistant', text: 'See stakeholders/people/STK-0001.md. Private note to remove.', created_at: at, status: 'done' },
    ],
  }));
  const reviewed = (await (await fetch(`${base}/api/workspace`)).json()).path;
  const { context, page, errors } = await open(1280);
  try {
    await page.route('**/api/chat/providers*', (r) => r.fulfill({ json: { providers: [{ id: 'claude-code', label: 'Claude Code', installed: true, ready: true, plan: null, models: [], limits: null, notes: [], problems: [] }] } }));
    // The workspace the "server" has open; another tab switching it is simulated by changing this.
    let openWorkspace = reviewed;
    const launches = [];
    await page.route('**/api/workspace/open-assistant', (r) => {
      const header = r.request().headers()['x-gtd-workspace'];
      launches.push(header === undefined ? null : decodeURIComponent(header));
      if (header === undefined) return r.fulfill({ status: 500, json: { error: 'unpinned launch' } });
      if (decodeURIComponent(header) !== openWorkspace) {
        return r.fulfill({ status: 409, json: { error: 'Conflict', message: 'This update is in another workspace. Switch to it, then open the update.', details: { code: 'other_workspace' } } });
      }
      return r.fulfill({ json: { opened: true, tool: 'claude-code', via: 'terminal', command: 'x' } });
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });

    await page.goto(base + '/situation');
    await settle(page);
    const openChat = async () => {
      await page.getByRole('button', { name: 'Ask the assistant', exact: true }).click();
      await page.getByRole('button', { name: 'Chats', exact: true }).click();
      await page.getByText('Fictional handoff chat').first().click();
    };
    await openChat();
    const action = page.getByRole('button', { name: 'Continue in assistant', exact: true });
    await action.waitFor();
    check('chat handoff: one action, on the latest answer', (await action.count()) === 1);
    await action.click();
    const dialog = page.getByRole('dialog', { name: 'Continue in your assistant' });
    await dialog.waitFor();
    const preview = dialog.getByLabel('Text to paste in the assistant', { exact: true });
    const request = dialog.getByLabel('Your next request', { exact: true });
    check('chat handoff: the latest exchange by default', (await preview.inputValue()).includes('> Who owns it?') && !(await preview.inputValue()).includes('What is due'));
    check('chat handoff: the request field takes focus', await request.evaluate((el) => el === document.activeElement));

    await request.fill('Add the owner to the task.');
    await dialog.getByRole('button', { name: 'Copy handoff', exact: true }).click();
    check('chat handoff: Copy puts the preview on the clipboard', (await page.evaluate(() => navigator.clipboard.readText())) === await preview.inputValue());

    // Pinned to the reviewed workspace.
    const openButton = dialog.getByRole('button', { name: 'Open Claude Code', exact: true });
    await openButton.click();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    check('chat handoff: Open sends the reviewed workspace', launches.length === 1 && launches[0] === reviewed, JSON.stringify(launches));
    openWorkspace = `${reviewed}-other`;
    await page.evaluate(() => { window.__writes = 0; const write = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.__writes++; return write(t); }; });
    await openButton.click();
    await dialog.getByText('has another workspace open now', { exact: false }).waitFor();
    check('chat handoff: another workspace open, the launch is refused and said in the dialog', launches.length === 2 && await preview.isVisible());
    check('chat handoff: and nothing is copied over the handoff', (await page.evaluate(() => window.__writes)) === 0);
    openWorkspace = reviewed;

    // A removal survives Escape, closing the panel, and Settings.
    const redacted = (await preview.inputValue()).replace(' Private note to remove.', '');
    await preview.fill(redacted);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    check('chat handoff: Escape closes the dialog, not the chat', await action.isVisible());
    check('chat handoff: focus goes back to the action', await action.evaluate((el) => el === document.activeElement));
    await page.getByRole('button', { name: 'Chat settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to the chat', exact: true }).first().click();
    await page.getByRole('button', { name: 'Close the assistant', exact: true }).first().click();
    await page.getByRole('button', { name: 'Ask the assistant', exact: true }).click();
    await action.click();
    await dialog.waitFor();
    check('chat handoff: a removal survives closing the panel and Settings', (await preview.inputValue()) === redacted && !(await preview.inputValue()).includes('Private note'));
    check('chat handoff: and so does the request', (await request.inputValue()) === 'Add the owner to the task.');

    // Clipboard refused: the text stays, selected.
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
    await dialog.getByRole('button', { name: 'Copy handoff', exact: true }).click();
    await dialog.getByText('Could not copy to the clipboard.', { exact: false }).waitFor();
    check('chat handoff: a failed copy leaves the text selected', await preview.evaluate((el) => el === document.activeElement && el.selectionStart === 0 && el.selectionEnd === el.value.length));
    check('chat handoff: no page errors', errors.length === 0, errors.join('\n'));
  } finally {
    await context.close();
    fs.rmSync(file, { force: true });
  }
}
