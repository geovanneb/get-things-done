#!/usr/bin/env node
/** Speaker consent and moved-voice deletion UI regressions on an isolated fictional workspace.
 * Requires npm run build and Playwright. Voice API responses are simulated; no model or real audio is used.
 * Screenshots are review artifacts in .visual-output/voices; no baselines are updated.
 */
/* global document, innerWidth */
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.visual-output/voices');
await fs.mkdir(out, { recursive: true });
(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-voice-browser-'));
  let server, browser;
  const home = path.join(tmp, 'home'),
    ws = path.join(tmp, 'ws');
  await fs.mkdir(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, ESB_WORKSPACE_PATH: ws, GTD_DISABLE_UPDATES: '1' };
  try {
    execFileSync(
      process.execPath,
      [
        root + '/bin/gtd.js',
        'init',
        '-y',
        '-d',
        ws,
        '--name',
        'Alex Morgan',
        '--role',
        'COO',
        '--org',
        'Northwind Labs',
      ],
      { env, stdio: 'pipe' },
    );
    const listener = net.createServer();
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
    const port = listener.address().port;
    await new Promise((r) => listener.close(r));
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [root + '/dist/server/index.js'], {
      env: { ...env, PORT: String(port), ESB_UI_PATH: root + '/dist/ui', NODE_ENV: 'production' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(base + '/health').then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    execFileSync(process.execPath, [root + '/scripts/seed-demo.mjs', base], { env, stdio: 'pipe' });
    const people = await (await fetch(base + '/api/stakeholders?type=people')).json();
    const person = people[0];
    const fixture = String.raw`
 const {MeetingDigestService}=require(process.cwd()+'/dist/server/services/meetingDigestService.js');
 (async()=>{const q=new MeetingDigestService();const p=JSON.parse(process.argv[1]);
 const m=await q.createMeeting({title:'Fictional voice review',meeting_date:'2026-11-04',participants:[{name:p.name,ref:p.id}]});
 const data=Buffer.alloc(16000*2*12),h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+data.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);await q.addFile(m.id,'call.wav',Buffer.concat([h,data]));
 await q.addFile(m.id,'call.transcript.md',Buffer.from('\x60\x60\x60text\n[00:00:00 → 00:00:12] Speaker 1\n  Fictional launch review.\n\x60\x60\x60\n'));
 await q.withQueue(async()=>{const x=await q.loadMeeting(m.id);const sha=x.files.find(f=>f.name==='call.transcript.md').sha256;
 x.files.find(f=>f.name==='call.wav').recording={status:'done',transcript:'call.transcript.md',transcript_sha256:sha,seconds:12,speaker_names:{transcript_sha256:sha,names:[{label:'Speaker 1',name:p.name,ref:p.id}]},speaker_voices:{transcript_sha256:sha,voices:[{label:'Speaker 1',intervals:[[0.2,11.8]],seconds:11.6}]}};await q.saveMeeting(x);});console.log(m.id)})();`;
    const id = execFileSync(process.execPath, ['-e', fixture, JSON.stringify(person)], {
      env,
      encoding: 'utf8',
      cwd: root,
    }).trim();
    browser = await chromium.launch();
    for (const theme of ['light', 'dark'])
      for (const width of [390, 768, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        await context.addInitScript((t) => localStorage.setItem('gtd:theme', t), theme);
        await context.route('**/api/voiceprints', async (route) => {
          if (route.request().method() === 'GET')
            return route.fulfill({
              json: {
                enabled: true,
                setting: true,
                speaker_model: true,
                consent_version: 1,
                consent_text: '{person} agreed to remember their voice.',
                min_seconds: 10,
                prints: [],
                moved: [
                  {
                    key: 'a'.repeat(32),
                    workspace: '/fictional/moved-workspace',
                    prints: [{ ref: person.id, name: person.name }],
                  },
                ],
              },
            });
          const payload = route.request().postDataJSON();
          assert.equal(payload.consent_ref, person.id);
          assert.equal(payload.consent, true);
          return route.fulfill({
            status: 409,
            json: { error: 'Conflict', message: 'The speaker name changed; reopen Remember voice.' },
          });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/meetings/' + id);
        await page.getByRole('button', { name: 'Edit speakers', exact: true }).click();
        const button = page.getByRole('button', { name: 'Remember the voice of ' + person.name });
        await button.click();
        const dialog = page.getByRole('dialog', { name: /^Remember / });
        await dialog.waitFor();
        const submit = dialog.getByRole('button', { name: 'Remember voice', exact: true });
        assert.equal(await submit.isDisabled(), true);
        await dialog.getByRole('checkbox').check();
        assert.equal(await submit.isEnabled(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: path.join(out, `consent-${width}-${theme}.png`) });
        await submit.click();
        await dialog
          .getByRole('alert')
          .filter({ hasText: 'The speaker name changed; reopen Remember voice.' })
          .waitFor();
        await page.screenshot({ path: path.join(out, `consent-error-${width}-${theme}.png`) });
        assert.ok((await dialog.innerText()).includes('The speaker name changed; reopen Remember voice.'));
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await button.evaluate((el) => el === document.activeElement), true);
        assert.deepEqual(errors, []);
        let deletes = 0;
        await context.route('**/api/voiceprints/moved/*', async (route) => {
          deletes++;
          return route.fulfill({ status: 204 });
        });
        await page.goto(base + '/settings');
        await page.getByRole('button', { name: 'Forget them', exact: true }).click();
        const confirmation = page.getByRole('alertdialog');
        await confirmation.waitFor();
        assert.equal(deletes, 0);
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(deletes, 0);
        await page.getByRole('button', { name: 'Forget them', exact: true }).click();
        const deleted = page.waitForResponse(
          (response) => response.url().includes('/api/voiceprints/moved/') && response.request().method() === 'DELETE',
        );
        await confirmation.getByRole('button', { name: 'Forget voices', exact: true }).click();
        await confirmation.waitFor({ state: 'hidden' });
        await deleted;
        assert.equal(deletes, 1);
        assert.deepEqual(errors, []);
        console.log(
          `PASS moved-voice confirmation and speaker consent payload, enabled state, layout, Escape/focus @${width} ${theme}`,
        );
        await context.close();
      }
  } finally {
    await browser?.close();
    server?.kill();
    if (server) await new Promise((r) => server.once('exit', r));
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
