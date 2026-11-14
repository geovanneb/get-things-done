#!/usr/bin/env node
/**
 * README images from the actual built dashboard, using only fictional seed data.
 * npm run build; npm i --no-save playwright; npx playwright install chromium
 * node scripts/readme-screenshots.mjs [--gif]
 * --gif also writes docs/images/memory-loop.gif from the same demo (needs ffmpeg on PATH).
 * CAPTURE_BROWSER_CHANNEL=chrome uses an installed Chrome instead of Playwright's Chromium.
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
  // The GIF at the top of the README: one still per step of the loop, cross-faded. Every still is
  // a real dashboard state of this fictional demo; the step caption is the only thing drawn on it.
  async function captureGif() {
    const frames = path.join(tmp, 'gif');
    await fs.mkdir(frames);
    const ctx = await browser.newContext({ viewport: { width: 1120, height: 700 }, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'Asia/Tokyo' });
    await ctx.addInitScript(() => localStorage.setItem('gtd:theme', 'light'));
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    const review = `/context/updates/${updates.find(u => u.title === 'Weekly logistics sync').id}`;
    const proposal = 'Record the signed second carrier';
    const scenes = [
      { route: `/meetings/${ids[0]}`, ready: 'The second carrier contract is signed.', step: '1', text: 'Record a meeting. It is transcribed on your computer.' },
      { route: review, ready: proposal, focus: proposal, step: '2', text: 'The agent proposes what the memory should learn.' },
      { action: () => p.getByLabel(proposal, { exact: true }).check(), step: '2', text: 'You decide what goes in.' },
      { route: '/profile', step: '3', text: 'The memory keeps your voice and how you write,' },
      { route: '/context', step: '3', text: 'your projects, decisions and risks,' },
      { route: '/stakeholders', ready: 'Priya', step: '3', text: 'and the people you work with.' },
      { route: `/board/task/${task.id}`, ready: 'Deliverables', step: '4', text: 'Give a task. Your agent already knows the background.' },
      { route: '/board', ready: 'Backlog', step: '↻', text: 'Every meeting and correction makes the next draft better.', hold: 3.2 },
    ];
    for (const [i, scene] of scenes.entries()) {
      if (scene.route) {
        await p.goto(base + scene.route);
        if (scene.ready) await p.getByText(scene.ready, { exact: false }).first().waitFor({ timeout: 15000 });
        else await p.locator('h1').first().waitFor({ timeout: 15000 });
        await p.evaluate(() => document.fonts.ready);
        await p.waitForTimeout(900);
      }
      if (scene.focus) await p.getByText(scene.focus, { exact: true }).evaluate(el => el.scrollIntoView({ block: 'center' }));
      if (scene.action) { await scene.action(); await p.waitForTimeout(600); }
      await p.evaluate(([step, text]) => {
        document.getElementById('readme-caption')?.remove();
        const box = document.createElement('div');
        box.id = 'readme-caption';
        box.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:12px;white-space:nowrap;padding:12px 22px 12px 12px;border-radius:999px;background:#111827;color:#fff;font:600 19px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 8px 28px rgba(17,24,39,.28)';
        const badge = document.createElement('span');
        badge.style.cssText = 'flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#4f46e5;font-size:17px';
        badge.textContent = step;
        const label = document.createElement('span');
        label.textContent = text;
        box.append(badge, label);
        document.body.append(box);
      }, [scene.step, scene.text]);
      await p.waitForTimeout(150);
      await p.screenshot({ path: path.join(frames, `${String(i).padStart(2, '0')}.png`), animations: 'disabled' });
    }
    await ctx.close();
    // Each still holds, then cross-fades into the next; offsets add up the time already shown.
    const fade = 0.4;
    const inputs = [];
    const chain = [];
    let offset = 0;
    let last = '[0:v]';
    scenes.forEach((scene, i) => {
      const hold = (scene.hold ?? 2.3) + fade;
      inputs.push('-loop', '1', '-t', String(hold), '-i', path.join(frames, `${String(i).padStart(2, '0')}.png`));
      if (i === 0) { offset = hold - fade; return; }
      chain.push(`${last}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(2)}[x${i}]`);
      last = `[x${i}]`;
      offset += hold - fade;
    });
    const gif = path.join(root, 'docs/images/memory-loop.gif');
    const filter = `${chain.join(';')};${last}fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[pal];[b][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-loop', '0', gif], { stdio: 'inherit' });
    console.log(`memory-loop.gif: ${Math.round((await fs.stat(gif)).size / 1024)} KB`);
  }
  browser = await chromium.launch({ channel: process.env.CAPTURE_BROWSER_CHANNEL || undefined, args: ['--font-render-hinting=none', '--disable-lcd-text', '--disable-font-subpixel-positioning', '--force-color-profile=srgb'] });
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
  await dark.close();
  if (process.argv.includes('--gif')) await captureGif();
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
