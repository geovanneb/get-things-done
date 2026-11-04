#!/usr/bin/env node
/**
 * README images from the actual built dashboard, using only fictional seed data.
 * npm run build; npm i --no-save playwright; npx playwright install chromium
 * node scripts/readme-screenshots.mjs
 * Creates its own HOME/workspace/server and removes them on exit. Never accepts a workspace URL.
 */
/* global document */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-readme-'));
const home = path.join(tmp, 'home');
const workspace = path.join(tmp, 'workspace');
await fs.mkdir(home);
const env = { ...process.env, HOME: home, USERPROFILE: home };
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const out = path.join(root, 'docs/screenshots');
let server;
let browser;
const errors = [];
try {
  execFileSync(process.execPath, [path.join(root, 'bin/gtd.js'), 'init', '-y', '-d', workspace,
    '--name', 'Alex Morgan', '--role', 'Project lead', '--org', 'Northwind Labs', '--workspace-name', 'Northwind work memory', '--ai', 'claude-code,codex,copilot'], { env, stdio: 'pipe' });
  server = spawn(process.execPath, [path.join(root, 'dist/server/index.js')], {
    env: { ...env, ESB_WORKSPACE_PATH: workspace, ESB_UI_PATH: path.join(root, 'dist/ui'), PORT: String(port), NODE_ENV: 'production', GTD_DISABLE_UPDATES: '1' }, stdio: 'ignore',
  });
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    healthy = await fetch(`${base}/health`).then(r => r.ok, () => false);
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!healthy) throw new Error('Temporary demo server did not start');
  execFileSync(process.execPath, [path.join(root, 'scripts/seed-demo.mjs'), base], { env, stdio: 'pipe' });
  const api = async (method, route, body) => {
    const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  // Same fictional people and project as seed-demo.mjs. These are imported sample words,
  // never represented as a real recording, transcription benchmark or AI-generated result.
  await api('PUT', '/api/routines/system-cleanup', { meetings: { keep_text: true } });
  const today = new Date().toISOString().slice(0, 10);
  const examples = [
    ['Weekly logistics sync', [
      ['Sofia Lindqvist', 'The second carrier contract is signed. Dual Lane is our name for the rollout.'],
      ['Daniel Okafor', 'We will move forty percent of outbound volume to the new carrier by the end of Q1.'],
      ['Alex Morgan', 'Keep the carrier risk open until the migration is proven. Update the risk note after this meeting.'],
      ['Sofia Lindqvist', 'For the customer update, lead with the delivery impact and put the milestones next.'],
      ['Alex Morgan', 'Daniel, prepare the rollout brief. Use the weekly update format and flag any assumptions.'],
    ]],
    ['Customer rollout planning', [['Sofia Lindqvist', 'The next update should include milestones, owners and the remaining risks.']]],
  ];
  const ids = [];
  for (const [title, lines] of examples) {
    const meeting = await api('POST', '/api/meeting-queue', { title, meeting_date: today, participants: lines.slice(0, 3).map(([name]) => ({ name })) });
    ids.push(meeting.id);
    const vtt = 'WEBVTT\n\n' + lines.map(([who, text], i) => {
      const minute = String(i).padStart(2, '0');
      return `00:${minute}:01.000 --> 00:${minute}:15.000\n<v ${who}>${text}</v>\n`;
    }).join('\n');
    const form = new FormData();
    form.append('file', new Blob([vtt], { type: 'text/vtt' }), 'fictional-meeting.vtt');
    const uploaded = await fetch(`${base}/api/meeting-queue/${meeting.id}/files`, { method: 'POST', body: form });
    if (!uploaded.ok) throw new Error(`Sample transcript upload failed: ${uploaded.status}`);
    await api('POST', `/api/meeting-queue/${meeting.id}/queue`);
  }
  const people = await api('GET', '/api/stakeholders');
  const task = await api('POST', '/api/tasks', {
    title: 'Draft the customer rollout update', priority: 'high',
    description: 'Explain the Dual Lane rollout to the customer. Lead with delivery impact, then milestones, owners and open risks. Use the latest reviewed carrier decision and flag assumptions.',
    stakeholders: people.filter(p => ['Sofia Lindqvist', 'Daniel Okafor'].includes(p.name)).map(p => ({ ref: p.id, role: 'reviewer' })),
    deliverables: [{ id: 'D1', format: 'md', template_ref: 'OUT-plain-text', status: 'pending', file_path: 'deliverables/customer-update.md' }],
  });
  const updates = await api('GET', '/api/context-updates');
  browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--disable-font-subpixel-positioning', '--force-color-profile=srgb'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'Asia/Tokyo' });
  await context.addInitScript(() => { localStorage.setItem('gtd:theme', 'light'); localStorage.setItem('gtd:agentic-visual-mode', '1'); });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await fs.mkdir(out, { recursive: true });
  const capture = async (name, route, ready) => {
    await page.goto(base + route);
    await page.getByText(ready, { exact: false }).first().waitFor({ timeout: 15000 }).catch(async error => { await page.screenshot({ path: '/tmp/gtd-readme-capture-error.png' }); console.log(await page.locator('body').innerText()); throw error; });
    await page.evaluate(() => document.fonts.ready);
    // Let background fetches and the layout finish; the SSE connection never becomes idle.
    await page.waitForTimeout(name === 'agent-floor' ? 4000 : 900);
    if (name === 'context-review') {
      await page.getByText('Record the signed second carrier', { exact: true }).evaluate(el => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' });
    console.log(`${name}.png: 1440x900`);
  };
  await capture('meeting-transcript', `/meetings/${ids[0]}`, 'The second carrier contract is signed.');
  await capture('meetings', '/meetings', 'Weekly logistics sync');
  await capture('context-review', `/context/updates/${updates.find(u => u.title === 'Weekly logistics sync').id}`, 'Record the signed second carrier');
  await capture('board', '/board', 'Backlog');
  await capture('task-detail', `/board/task/${task.id}`, 'Deliverables');
  await capture('stakeholders', '/stakeholders', 'Priya');
  await capture('situation', '/situation', 'attention');
  await capture('insights', '/insights', 'Insights');
  await capture('agent-floor', '/agent-floor', 'Agent Floor');
  await context.close();
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await dark.addInitScript(() => localStorage.setItem('gtd:theme', 'dark'));
  const darkPage = await dark.newPage();
  await darkPage.goto(base + '/board');
  await darkPage.getByText('Backlog', { exact: true }).first().waitFor();
  await darkPage.evaluate(() => document.fonts.ready);
  await darkPage.waitForTimeout(900);
  await darkPage.screenshot({ path: path.join(out, 'board-dark.png'), animations: 'disabled' });
  console.log('board-dark.png: 1440x900');
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timeout);
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
