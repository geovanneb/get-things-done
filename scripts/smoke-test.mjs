#!/usr/bin/env node
/**
 * End-to-end smoke test against the built package (run `npm run build` first).
 *
 * Creates a throwaway workspace with the real CLI, starts the bundled server,
 * fills it with the demo data and checks the main API surfaces. Everything runs
 * in a temp directory with its own HOME, so it never touches your config.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-smoke-'));
const home = path.join(tmp, 'home');
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(home);
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, USERPROFILE: home };

// Node 20's fetch can reuse a keep-alive socket the server has just closed:
// the demo seed runs in its own process for longer than the server's 5-second
// idle timeout, so the connection this script opened earlier is gone by the
// time it asks again. Newer Node versions retry this themselves. Retry a GET
// once in that case; anything else still fails as it should.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  try {
    return await nativeFetch(url, init);
  } catch (err) {
    const closed = ['UND_ERR_SOCKET', 'ECONNRESET'].includes(err?.cause?.code);
    if (!closed || (init.method ?? 'GET').toUpperCase() !== 'GET') throw err;
    return nativeFetch(url, init);
  }
};

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

execFileSync(process.execPath, [path.join(root, 'bin/gtd.js'), 'init', '-y', '-d', ws,
  '--name', 'Alex Morgan', '--role', 'COO', '--org', 'Northwind Labs', '--ai', 'claude-code,copilot,codex'],
  { env, stdio: 'pipe' });
check('gtd init creates a workspace', fs.existsSync(path.join(ws, 'workspace.yaml')));
check('gtd init writes the Claude Code setup', fs.existsSync(path.join(ws, 'CLAUDE.md')));

const server = spawn(process.execPath, [path.join(root, 'dist/server/index.js')], {
  env: { ...env, ESB_WORKSPACE_PATH: ws, ESB_UI_PATH: path.join(root, 'dist/ui'), PORT: String(port), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

try {
  let healthy = false;
  for (let i = 0; i < 50 && !healthy; i++) {
    try { healthy = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server answers /health', healthy);
  if (!healthy) throw new Error('server did not start');

  const forbidden = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { Origin: 'https://untrusted.example' } });
  check('untrusted origins are rejected before routes run', forbidden.status === 403);
  const page = await fetch(`${base}/`);
  const pageCsp = page.headers.get('content-security-policy') ?? '';
  check('the dashboard is served with a restrictive CSP',
    pageCsp.includes("script-src 'self'") && pageCsp.includes("frame-ancestors 'none'"), pageCsp);
  check('API requests are rate limited', Boolean(page.headers.get('ratelimit-policy')));
  const setupStatus = await (await fetch(`${base}/api/setup`)).json();
  check('setup reports the open workspace, so the dashboard skips the setup screen',
    setupStatus.configured === true && setupStatus.ai_tools?.length === 3);
  const malformed = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  check('malformed JSON returns a client error', malformed.status === 400);
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'private fixture');
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(ws, 'outside-link.txt'));
  const escaped = await fetch(`${base}/api/workspace/files/outside-link.txt`);
  check('workspace downloads reject symlinks outside the workspace', escaped.status === 400);
  fs.unlinkSync(path.join(ws, 'outside-link.txt'));
  fs.writeFileSync(path.join(ws, 'preview.html'), '<script>fetch("/api/tasks")</script>');
  const htmlPreview = await fetch(`${base}/api/workspace/files/preview.html`);
  check('workspace HTML is sandboxed without script or same-origin privileges',
    htmlPreview.ok && htmlPreview.headers.get('content-security-policy')?.includes('sandbox;') &&
    !htmlPreview.headers.get('content-security-policy')?.includes('allow-scripts') &&
    !htmlPreview.headers.get('content-security-policy')?.includes('allow-same-origin'));

  const ui = await fetch(`${base}/board`);
  check('UI is served for app routes', ui.ok && (await ui.text()).includes('<div id="root">'));

  const missing = await fetch(`${base}/api/does-not-exist`);
  check('unknown API paths return a JSON 404', missing.status === 404);

  execFileSync(process.execPath, [path.join(root, 'scripts/seed-demo.mjs'), base], { env, stdio: 'pipe' });

  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  check('tasks are listed', tasks.length === 14, `count=${tasks.length}`);

  const people = await (await fetch(`${base}/api/stakeholders`)).json();
  check('stakeholders are listed', people.length === 6, `count=${people.length}`);

  const search = await (await fetch(`${base}/api/search?q=carrier`)).json();
  check('search finds seeded content', (search.results ?? []).length > 0);

  const insights = await (await fetch(`${base}/api/insights`)).json();
  check('insights count work waiting on review', insights.summary?.awaiting_review === 1);

  const calendar = await (await fetch(`${base}/api/insights/calendar?days=90`)).json();
  const busiest = (calendar.days ?? []).reduce((best, d) => (d.activity > (best?.activity ?? 0) ? d : best), null);
  check('activity calendar covers the same 90 days as the filter',
    calendar.days?.length === 90 && calendar.days?.at(-1)?.date === calendar.today && busiest !== null,
    `days=${calendar.days?.length} busiest=${busiest?.date}`);
  const history = await (await fetch(`${base}/api/insights/calendar?days=all`)).json();
  check('all-time calendar runs from the first activity to today',
    history.days?.[0]?.activity > 0 && history.days?.at(-1)?.date === history.today, `from=${history.from}`);
  const calendarDay = busiest ? await (await fetch(`${base}/api/insights/calendar/day/${busiest.date}`)).json() : {};
  check('calendar day lists the tasks behind the busiest day', (calendarDay.tasks ?? []).length > 0);
  const badCalendar = await fetch(`${base}/api/insights/calendar?days=14`);
  check('activity calendar rejects a window the filter does not offer', badCalendar.status === 400);

  // Live updates: an agent editing a task file on disk must reach the dashboard over SSE.
  const sse = await fetch(`${base}/api/events`);
  const reader = sse.body.getReader();
  let streamed = '';
  const sawChange = (async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until && !streamed.includes('event: file_change')) {
      const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({}), 500))]);
      if (done) break;
      if (value) streamed += new TextDecoder().decode(value);
    }
    return streamed.includes('event: file_change');
  })();
  await new Promise((r) => setTimeout(r, 1000)); // let the watcher settle
  const edited = path.join(ws, 'tasks', 'active', tasks[0].id, 'task.md');
  fs.appendFileSync(edited, '\nEdited outside the app.\n');
  check('editing a task file on disk pushes a live update', await sawChange);
  await reader.cancel();

  const situation = await (await fetch(`${base}/api/situation`)).json();
  const editedRow = situation.recent_activity?.find((a) => a.path === `tasks/active/${tasks[0].id}/task.md`);
  check('recent activity names the changed task, not just task.md', editedRow?.title === tasks[0].title,
    JSON.stringify(editedRow ?? null));

  const task = tasks.find((t) => t.status === 'ready');
  const moved = await (await fetch(`${base}/api/tasks/${task.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  })).json();
  check('moving a task to done stamps done_date', Boolean(moved.done_date));

  // A task reopened by editing task.md keeps a stale done_date on disk; the app
  // must not carry it over when the task is completed again.
  const reopened = tasks.find((t) => t.status === 'backlog' && t.id !== task.id);
  const reopenedFile = path.join(ws, 'tasks', 'active', reopened.id, 'task.md');
  const stale = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(reopenedFile, fs.readFileSync(reopenedFile, 'utf8').replace(/^status: .*$/m, (m) => `${m}\ndone_date: '${stale}'`));
  const recompleted = await (await fetch(`${base}/api/tasks/${reopened.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  })).json();
  check('completing a task again replaces a stale done_date', Boolean(recompleted.done_date) && recompleted.done_date !== stale,
    `done_date=${recompleted.done_date}`);

  // Creating a task through the API keeps the optional schema fields it is given (they used to be dropped).
  const contextRef = (await (await fetch(`${base}/api/context`)).json())[0]?.id;
  const fields = {
    title: 'Smoke task with optional fields', body: 'Fictional zephyrbrief objective.', slug: 'smoke-optional-fields', task_type: 'analysis',
    contexts: [{ ref: contextRef, relevance: 'required' }], confidentiality: 'confidential',
    review_date: '2026-12-01', estimated_hours: 0,
  };
  const createdTask = await (await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  })).json();
  const readBack = await (await fetch(`${base}/api/tasks/${createdTask.id}`)).json();
  const kept = (t) => t.slug === fields.slug && t.task_type === 'analysis' && t.contexts?.[0]?.ref === contextRef
    && t.confidentiality === 'confidential' && t.review_date === '2026-12-01' && t.estimated_hours === 0;
  check('creating a task keeps its optional fields (type, contexts, confidentiality, ...)',
    Boolean(contextRef) && kept(createdTask) && kept(readBack), JSON.stringify({ ...readBack, body: undefined }).slice(0, 300));

  const objectiveSearch = await (await fetch(`${base}/api/search?q=zephyrbrief`)).json();
  const objectiveFilter = await (await fetch(`${base}/api/tasks?search=zephyrbrief`)).json();
  check('Markdown task objectives remain searchable',
    objectiveSearch.results.some((task) => task.id === createdTask.id)
    && objectiveFilter.some((task) => task.id === createdTask.id));

  // "Prepare meeting" relies on the shipped meeting brief template and meeting-prep agent, and a task that keeps them.
  {
    const brief = (await (await fetch(`${base}/api/outputs/templates`)).json()).find((t) => t.slug === 'meeting-brief');
    const prepAgent = (await (await fetch(`${base}/api/agents`)).json()).some((a) => a.name === 'meeting-prep');
    const prep = await (await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Prepare: meeting with Priya Natarajan', preferred_agent: 'meeting-prep',
        deliverables: [{ id: 'DEL-01', format: brief?.format, template_ref: brief?.id, status: 'pending' }] }),
    })).json();
    const back = await (await fetch(`${base}/api/tasks/${prep.id}`)).json();
    check('a meeting prep task keeps the meeting brief template and the meeting-prep agent',
      brief?.format === 'md' && prepAgent && back.preferred_agent === 'meeting-prep' && back.deliverables?.[0]?.template_ref === 'OUT-meeting-brief',
      JSON.stringify({ brief: brief?.id, prepAgent, agent: back.preferred_agent, deliverables: back.deliverables }));
  }

  // Scheduled and manual creates can arrive together; neither may overwrite the other.
  {
    const titles = Array.from({ length: 8 }, (_, i) => `Concurrent smoke task ${i}`);
    const created = await Promise.all(titles.map(async (title) => {
      const res = await fetch(`${base}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      });
      return { ok: res.status === 201, task: await res.json() };
    }));
    const saved = await (await fetch(`${base}/api/tasks`)).json();
    check('concurrent task creates keep distinct IDs and all task bodies',
      created.every((r) => r.ok) && new Set(created.map((r) => r.task.id)).size === titles.length
      && titles.every((title) => saved.some((task) => task.title === title)));
    const before = fs.readdirSync(path.join(ws, 'tasks', 'active'));
    const invalid = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Invalid routine marker', routine_ref: '../bad' }),
    });
    check('invalid routine markers return 400 without creating task folders', invalid.status === 400
      && JSON.stringify(fs.readdirSync(path.join(ws, 'tasks', 'active'))) === JSON.stringify(before));
  }

  // The New Task modal uploads the files picked before saving right after the task is created.
  {
    const form = new FormData();
    form.append('file', new Blob(['fictional brief']), 'brief.txt');
    const up = await fetch(`${base}/api/tasks/${createdTask.id}/files`, { method: 'POST', body: form });
    const listed = await (await fetch(`${base}/api/tasks/${createdTask.id}/files`)).json();
    check('a new task accepts files right after it is created',
      up.status === 201 && Array.isArray(listed) && listed.some((f) => f.name === 'brief.txt'), `${up.status} ${JSON.stringify(listed).slice(0, 200)}`);
  }

  // An Office file agents cannot read is reported on upload, in the list, by validation and in the execution package,
  // also when an agent wrote it straight into the task folder. (Encrypted packages are covered by the server tests.)
  {
    const form = new FormData();
    form.append('file', new Blob(['not an office file']), 'broken.docx');
    const saved = await (await fetch(`${base}/api/tasks/${createdTask.id}/files`, { method: 'POST', body: form })).json();
    fs.writeFileSync(path.join(ws, 'tasks', 'active', createdTask.id, 'deliverables', 'agent.xlsx'), '');
    const listed = await (await fetch(`${base}/api/tasks/${createdTask.id}/files`)).json();
    const issues = await (await fetch(`${base}/api/workspace/validate`)).json();
    const unreadable = (await (await fetch(`${base}/api/tasks/${createdTask.id}/execution-package/preview`)).json()).unreadable_files ?? [];
    const names = unreadable.map((f) => path.basename(f.path)).sort().join(',');
    check('an unreadable Office file is flagged on upload, in the file list, by validation and in the execution package',
      saved.officeCheck === 'unsupported_container' && listed.find((f) => f.name === 'broken.docx')?.officeCheck === 'unsupported_container'
        && listed.find((f) => f.name === 'brief.txt')?.officeCheck === undefined
        && issues.some((i) => i.rule === 'unreadable_office_file' && i.level === 'warning' && i.path.endsWith('agent.xlsx'))
        && names === 'agent.xlsx,broken.docx',
      JSON.stringify({ saved, names, issues: issues.filter((i) => i.rule === 'unreadable_office_file') }).slice(0, 400));
    fs.rmSync(path.join(ws, 'tasks', 'active', createdTask.id, 'broken.docx'));
    fs.rmSync(path.join(ws, 'tasks', 'active', createdTask.id, 'deliverables', 'agent.xlsx'));
  }

  // Routines: a schedule that puts a task on the backlog, from the dashboard and from the CLI.
  {
    const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    check('gtd init creates the routines folder and schema',
      fs.existsSync(path.join(ws, 'routines')) && fs.existsSync(path.join(ws, '.schemas', 'routine.schema.json')));
    const schedule = { frequency: 'weekly', interval: 2, weekdays: ['mon'], time: '08:00', starts_on: '2026-10-26' };
    const preview = await (await post('/api/routines/preview', { schedule, due_offset_days: 2 })).json();
    check('a routine schedule previews as a sentence with the next runs',
      preview.summary === 'Every 2 weeks on Monday at 08:00' && preview.next_runs?.length === 5, JSON.stringify(preview).slice(0, 200));
    const routineRes = await post('/api/routines', {
      schedule, task: { title: 'Prepare steering sync ({{due_date}})', priority: 'high', due_offset_days: 2, body: 'Fictional prep.' },
    });
    const routine = await routineRes.json();
    check('a routine is created with a summary and a next run', routineRes.status === 201 && routine.id === 'RT-0001' && Boolean(routine.next_run_at),
      `status=${routineRes.status}`);
    const run = await (await post(`/api/routines/${routine.id}/run`)).json();
    const created = run.created?.[0] ? await (await fetch(`${base}/api/tasks/${run.created[0]}`)).json() : {};
    check('run now puts the task on the backlog, linked to its routine',
      created.routine_ref === routine.id && created.status === 'backlog' && /^Prepare steering sync \(\d{4}-\d{2}-\d{2}\)$/.test(created.title ?? ''),
      JSON.stringify(run));
    const fieldsRoutine = await (await post('/api/routines', {
      schedule, paused_until: '2099-01-01',
      task: { title: 'Smoke routine fields', task_type: 'presentation', preferred_agent: 'meeting-prep', confidentiality: 'internal', body: 'See [@TASK-2026-0001](/tasks/active/TASK-2026-0001/task.md).' },
    })).json();
    const fieldsRun = await (await post(`/api/routines/${fieldsRoutine.id}/run`)).json();
    const fieldsTask = fieldsRun.created?.[0] ? await (await fetch(`${base}/api/tasks/${fieldsRun.created[0]}`)).json() : {};
    check('a routine task keeps its type, agent, confidentiality and mention links; a pause moves the next run',
      fieldsTask.task_type === 'presentation' && fieldsTask.preferred_agent === 'meeting-prep' && fieldsTask.confidentiality === 'internal'
        && String(fieldsTask.body).includes('[@TASK-2026-0001](/tasks/active/TASK-2026-0001/task.md)')
        && fieldsRoutine.next_run_at >= '2099-01-01', JSON.stringify({ ...fieldsTask, body: undefined }).slice(0, 300));
    const badId = await fetch(`${base}/api/routines/..%2Fworkspace`);
    const badSchedule = await post('/api/routines', { schedule: { frequency: 'hourly' }, task: { title: 'x' } });
    check('routine ids and schedules are validated', badId.status === 400 && badSchedule.status === 400, `${badId.status}/${badSchedule.status}`);
    const badOffset = await post('/api/routines/preview', { schedule, due_offset_days: 366 });
    check('routine previews reject invalid due offsets', badOffset.status === 400, String(badOffset.status));
    fs.writeFileSync(path.join(ws, 'routines', 'RT-0009.md'), '---\nschedule: broken\n---\n');
    const deletedBroken = await fetch(`${base}/api/routines/RT-0009`, { method: 'DELETE' });
    check('broken routines can be deleted through the API', deletedBroken.status === 204
      && !fs.existsSync(path.join(ws, 'routines', 'RT-0009.md')), String(deletedBroken.status));
    const history = await (await fetch(`${base}/api/routines/history`)).json();
    check('the run history lists the run', history.some((r) => r.routine_id === routine.id && r.trigger === 'manual'));
    const cli = execFileSync(process.execPath, [path.join(root, 'bin/gtd.js'), 'routines', 'list'], { env, encoding: 'utf8' });
    const cliRun = execFileSync(process.execPath, [path.join(root, 'bin/gtd.js'), 'routines', 'run'], { env, encoding: 'utf8' });
    check('gtd routines list and run work without the dashboard', cli.includes('RT-0001') && cliRun.includes('No routine is due'), cli + cliRun);
  }

  // System cleanup: the built-in routine. By default weekly, suggestions only.
  {
    const send = (method, url, body) => fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const job = await (await fetch(`${base}/api/routines/system-cleanup`)).json();
    check('system cleanup defaults to weekly, memory review on and no file rule',
      job.summary === 'Every Monday at 09:00' && job.settings?.enabled === true && job.settings.memory_review.enabled === true
        && Object.values(job.settings.rules).every((r) => r.enabled === false), JSON.stringify(job).slice(0, 300));
    check('the workspace .gitignore keeps the trash out of git',
      fs.readFileSync(path.join(ws, '.gitignore'), 'utf8').includes('.situation-board/trash/'));
    const badRule = await send('PUT', '/api/routines/system-cleanup', { rules: { kaizen: { enabled: true, action: 'archive' } } });
    check('system cleanup settings are validated', badRule.status === 400, String(badRule.status));
    const invalidKaizen = await send('PATCH', '/api/kaizen/KZN-001', { status: 'invalid' });
    check('kaizen rejects invalid statuses', invalidKaizen.status === 400, String(invalidKaizen.status));


    const note = path.join(ws, 'context', 'glossary', 'smoke-term');
    fs.mkdirSync(note, { recursive: true });
    fs.writeFileSync(path.join(note, 'note.md'), '---\nid: CTX-smoke-term\ntype: context\ntitle: Smoke term\ncategory: glossary\n---\nA fictional term.\n');
    const tasksBefore = fs.readdirSync(path.join(ws, 'tasks', 'active')).sort().join(',');
    const preview = await (await send('POST', '/api/routines/system-cleanup/preview')).json();
    check('a system cleanup preview lists no file by default', preview.plan?.items?.length === 0 && preview.memory?.notes >= 1, JSON.stringify(preview).slice(0, 300));
    const runRes = await send('POST', '/api/routines/system-cleanup/run');
    const run = await runRes.json();
    const review = run.context_update ? await (await fetch(`${base}/api/context-updates/${run.context_update}`)).json() : {};
    check('run now opens a memory review tagged as coming from system cleanup, and touches no task',
      runRes.status === 201 && review.origin === 'system-cleanup' && review.kind === 'memory-review'
        && review.material_files?.some((f) => f.name === 'memory-scan.md')
        && fs.readdirSync(path.join(ws, 'tasks', 'active')).sort().join(',') === tasksBefore, JSON.stringify(run).slice(0, 300));
    const again = await (await send('POST', '/api/routines/system-cleanup/run')).json();
    check('a second run waits for the open review instead of opening another', !again.context_update && /still open/.test(again.message), again.message);
    const manualTrash = path.join(ws, '.situation-board/trash/2020-01-01T00-00-00-000Z-manual.md');
    fs.mkdirSync(path.dirname(manualTrash), { recursive: true });
    fs.writeFileSync(manualTrash, 'Fictional manually retained file');
    await send('PUT', '/api/routines/system-cleanup', { memory_review: { enabled: false }, rules: { trash: { enabled: true } } });
    const trashRun = await send('POST', '/api/routines/system-cleanup/run');
    check('cleanup preserves date-prefixed manual trash files', trashRun.status === 201 && fs.existsSync(manualTrash));
    await send('PUT', '/api/routines/system-cleanup', { memory_review: { enabled: true }, rules: { trash: { enabled: false } } });
    await fetch(`${base}/api/context-updates/${run.context_update}`, { method: 'DELETE' });
    fs.rmSync(note, { recursive: true, force: true });
  }

  const group = await fetch(`${base}/api/stakeholders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smoke group', type: 'groups' }),
  });
  check('a stakeholder group can be created', group.ok);

  const issues = await (await fetch(`${base}/api/workspace/validate`)).json();
  const errors = issues.filter((i) => i.level === 'error');
  check('a workspace edited through the app (incl. a group) has no validation errors', errors.length === 0,
    errors.length ? JSON.stringify(errors.slice(0, 3)) : '');

  // Files kept with a template or a context note can be opened and downloaded, never anything outside their folder.
  {
    const templates = await (await fetch(`${base}/api/outputs/templates`)).json();
    const notes = await (await fetch(`${base}/api/context`)).json();
    for (const [label, files] of [['template', `/api/outputs/templates/${templates[0].id}/files`], ['context note', `/api/context/${notes[0].id}/files`]]) {
      const form = new FormData();
      form.append('file', new Blob(['hello from the smoke test'], { type: 'text/plain' }), 'smoke-note.txt');
      const up = await fetch(`${base}${files}`, { method: 'POST', body: form });
      const open = await fetch(`${base}${files}/smoke-note.txt`);
      check(`a ${label} file opens in the browser`, up.status === 201 && open.ok && (await open.text()) === 'hello from the smoke test'
        && !(open.headers.get('content-disposition') ?? '').includes('attachment'), `upload=${up.status} open=${open.status}`);
      check(`a ${label} preview is sandboxed`, open.headers.get('content-security-policy')?.includes('sandbox;'));
      const protectedUpload = new FormData();
      protectedUpload.append('file', new Blob(['bad']), label === 'template' ? 'output.md' : 'note.md');
      const rejected = await fetch(`${base}${files}`, { method: 'POST', body: protectedUpload });
      check(`a ${label} upload cannot replace entity metadata`, rejected.status === 400);
      const dl = await fetch(`${base}${files}/smoke-note.txt?download=1`);
      check(`a ${label} file downloads as an attachment`, dl.ok && /^attachment; filename="?smoke-note\.txt"?$/.test(dl.headers.get('content-disposition') ?? ''),
        dl.headers.get('content-disposition') ?? 'no header');
      const missing = await fetch(`${base}${files}/no-such-file.txt`);
      const escape = await fetch(`${base}${files}/..%2F..%2F..%2Fworkspace.yaml`);
      check(`a ${label} file route returns 404 for a missing file and 400 outside the folder`, missing.status === 404 && escape.status === 400,
        `missing=${missing.status} escape=${escape.status}`);
      await fetch(`${base}${files}/smoke-note.txt`, { method: 'DELETE' });
    }

    // Subfolders are listed and can be opened; remove only works on top-level files.
    const tplDir = path.dirname(templates[0].path);
    fs.mkdirSync(path.join(tplDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tplDir, 'assets', 'logo.txt'), 'nested');
    fs.writeFileSync(path.join(tplDir, '.hidden'), 'secret');
    fs.writeFileSync(path.join(tplDir, 'logo.txt'), 'top level');
    const tplFiles = `/api/outputs/templates/${templates[0].id}/files`;
    const listed = (await (await fetch(`${base}${tplFiles}`)).json()).map((f) => f.name);
    check('template files in subfolders are listed, hidden files are not',
      listed.includes('assets/logo.txt') && listed.includes('logo.txt') && !listed.some((n) => n.startsWith('.') || n === 'output.md'), JSON.stringify(listed));
    const nested = await fetch(`${base}${tplFiles}/assets/logo.txt`);
    check('a file in a subfolder opens', nested.ok && (await nested.text()) === 'nested');
    const delNested = await fetch(`${base}${tplFiles}/assets%2Flogo.txt`, { method: 'DELETE' });
    check('removing a file in a subfolder is refused and leaves the top-level file alone',
      delNested.status === 400 && fs.existsSync(path.join(tplDir, 'logo.txt')) && fs.existsSync(path.join(tplDir, 'assets', 'logo.txt')), `status=${delNested.status}`);
    // "Download all": the whole folder, including output.md and subfolders, as one valid ZIP.
    const zipRes = await fetch(`${base}/api/outputs/templates/${templates[0].id}/archive`);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-zip-'));
    fs.writeFileSync(path.join(zipDir, 'all.zip'), zipBuf);
    let unzipped = [];
    try {
      execFileSync('unzip', ['-q', 'all.zip'], { cwd: zipDir });
      const folder = path.basename(tplDir);
      unzipped = ['output.md', 'logo.txt', 'assets/logo.txt'].map((f) => fs.existsSync(path.join(zipDir, folder, f)));
    } catch (e) { unzipped = [String(e)]; }
    check('a template downloads as one ZIP with output.md and its subfolders',
      zipRes.ok && (zipRes.headers.get('content-type') ?? '').includes('application/zip')
      && (zipRes.headers.get('content-disposition') ?? '').includes('.zip') && unzipped.every((x) => x === true),
      `status=${zipRes.status} ${JSON.stringify(unzipped)}`);
    const noteZip = await fetch(`${base}/api/context/${notes[0].id}/archive`);
    check('a context note downloads as one ZIP', noteZip.ok && (noteZip.headers.get('content-type') ?? '').includes('application/zip'));
    fs.rmSync(zipDir, { recursive: true, force: true });
    fs.rmSync(path.join(tplDir, 'assets'), { recursive: true, force: true });
    fs.rmSync(path.join(tplDir, '.hidden'), { force: true });
    fs.rmSync(path.join(tplDir, 'logo.txt'), { force: true });
  }

  // Context updates: import material, simulate the analysis command, review, close.
  {
    check('gtd init writes the context update commands',
      ['gtd-context-analyze.md', 'gtd-context-apply.md'].every((f) => fs.existsSync(path.join(ws, '.claude', 'commands', f)))
      && fs.existsSync(path.join(ws, 'context-updates')) && fs.existsSync(path.join(ws, '.schemas', 'context-update.schema.json')));
    const json = (method, url, body) => fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const created = await (await json('POST', '/api/context-updates', { title: 'Fictional steering committee', source_date: '2026-10-20', text: 'Transcript of a fictional meeting' })).json();
    check('a context update is created as ready, with pasted text saved as material',
      /^CU-\d{4}-\d{4}$/.test(created.id) && created.status === 'ready' && created.materials.some((m) => m.name === 'pasted-text.md'), JSON.stringify(created).slice(0, 200));
    const invalidDate = await json('POST', '/api/context-updates', { source_date: '2026-02-30' });
    check('context updates reject impossible source dates', invalidDate.status === 400);
    const parallelUploads = await Promise.all(['first', 'second'].map(async (content) => {
      const upload = new FormData();
      upload.append('file', new Blob([content]), 'meeting.txt');
      const response = await fetch(`${base}/api/context-updates/${created.id}/materials`, { method: 'POST', body: upload });
      return { status: response.status, file: await response.json() };
    }));
    const uploadedContents = await Promise.all(parallelUploads.map(async ({ file }) =>
      (await fetch(`${base}/api/context-updates/${created.id}/materials/${file.name}`)).text()));
    check('simultaneous material uploads keep distinct names and contents',
      parallelUploads.every((r) => r.status === 201) && new Set(parallelUploads.map((r) => r.file.name)).size === 2
      && uploadedContents.join(',') === 'first,second');
    const form = new FormData();
    form.append('file', new Blob(['slide text']), 'deck.txt');
    const up = await fetch(`${base}/api/context-updates/${created.id}/materials`, { method: 'POST', body: form });
    check('material uploads to a context update', up.status === 201);
    const escape = await fetch(`${base}/api/context-updates/${created.id}/materials/..%2Fupdate.md`);
    check('material downloads cannot leave the materials folder', escape.status === 400, `status=${escape.status}`);
    const badId = await fetch(`${base}/api/context-updates/..%2Fcontext`);
    check('a context update id that is not CU-YYYY-NNNN is refused', badId.status === 400, `status=${badId.status}`);

    // What /gtd-context-analyze writes.
    const dir = path.join(ws, 'context-updates', created.id);
    const [note] = await (await fetch(`${base}/api/context`)).json();
    const target = path.relative(ws, note.path).split(path.sep).join('/');
    const md = fs.readFileSync(path.join(dir, 'update.md'), 'utf-8');
    fs.writeFileSync(path.join(dir, 'update.md'), md.replace('status: ready', `status: in_review\nanalyzed_at: '${new Date(Date.now() + 5000).toISOString()}'\nsummary: Fictional summary.`)
      .replace('proposals: []', `proposals:\n  - id: P-01\n    action: update\n    target: ${target}\n    title: Refresh the note\n    rationale: A fictional reason`));
    fs.mkdirSync(path.join(dir, 'proposals'));
    fs.writeFileSync(path.join(dir, 'proposals', 'P-01.md'), 'Proposed content\n');
    const detail = await (await fetch(`${base}/api/context-updates/${created.id}`)).json();
    check('review shows the proposal with current and proposed content',
      detail.status === 'in_review' && detail.proposals[0]?.proposed === 'Proposed content\n' && typeof detail.proposals[0]?.current === 'string' && !detail.proposals[0]?.problem,
      JSON.stringify(detail.proposals?.[0] ?? detail).slice(0, 200));
    const late = await fetch(`${base}/api/context-updates/${created.id}/materials`, { method: 'POST', body: form });
    check('material cannot be added while proposals are under review', late.status === 409, `status=${late.status}`);
    await Promise.all([
      json('PUT', `/api/context-updates/${created.id}/decisions`, { decisions: { 'P-01': { decision: 'accepted' } } }),
      json('PUT', `/api/context-updates/${created.id}/decisions`, { decisions: { 'P-01': { reviewer_note: 'Keep the definition' } } }),
    ]);
    const reviewed = await (await fetch(`${base}/api/context-updates/${created.id}`)).json();
    check('simultaneous review saves keep the decision and reviewer note',
      reviewed.proposals[0].decision === 'accepted' && reviewed.proposals[0].reviewer_note === 'Keep the definition');
    const approved = await (await json('POST', `/api/context-updates/${created.id}/approve`)).json();
    check('approving locks the selection', approved.status === 'approved' && approved.proposals[0].decision === 'accepted');
    await json('POST', `/api/context-updates/${created.id}/back-to-review`);
    const before = fs.readFileSync(path.join(ws, target), 'utf-8');
    const closed = await (await json('POST', `/api/context-updates/${created.id}/close`)).json();
    check('closing without changes keeps the record, deletes the materials and leaves the context alone',
      closed.status === 'done' && closed.materials.length === 4 && !fs.existsSync(path.join(dir, 'materials'))
      && fs.readFileSync(path.join(ws, target), 'utf-8') === before);
    const kept = await (await json('POST', '/api/context-updates', { title: 'Fictional board recording', text: 'Fictional recording transcript' })).json();
    const badKeep = await json('PUT', `/api/context-updates/${kept.id}/keep-materials`, { keep: 'yes' });
    await json('PUT', `/api/context-updates/${kept.id}/keep-materials`, { keep: true });
    const keptDir = path.join(ws, 'context-updates', kept.id);
    const keptMd = fs.readFileSync(path.join(keptDir, 'update.md'), 'utf-8');
    fs.writeFileSync(path.join(keptDir, 'update.md'), keptMd.replace('status: ready', 'status: in_review'));
    await json('POST', `/api/context-updates/${kept.id}/close`);
    const keptDetail = await (await fetch(`${base}/api/context-updates/${kept.id}`)).json();
    const keptFile = await fetch(`${base}/api/context-updates/${kept.id}/materials/pasted-text.md`);
    const released = await json('PUT', `/api/context-updates/${kept.id}/keep-materials`, { keep: false });
    check('kept materials survive a finished update until the user releases them',
      badKeep.status === 400 && keptDetail.status === 'done' && keptDetail.keep_materials === true
      && keptFile.status === 200 && released.status === 200 && !fs.existsSync(path.join(keptDir, 'materials')),
      `bad=${badKeep.status} file=${keptFile.status} released=${released.status}`);
    // A meeting that changes no context: the record alone is confirmed, and approving finishes the update.
    const meeting = await (await json('POST', '/api/context-updates', { title: 'Fictional weekly sync', text: 'Fictional transcript' })).json();
    const meetingDir = path.join(ws, 'context-updates', meeting.id);
    fs.writeFileSync(path.join(meetingDir, 'update.md'), fs.readFileSync(path.join(meetingDir, 'update.md'), 'utf-8')
      .replace('status: ready', 'status: in_review\nmeeting_records:\n  - id: M-01\n    title: Weekly sync\n    meeting_date: \'2026-10-20\'\n    decisions:\n      - Fictional decision'));
    const { revision } = (await (await fetch(`${base}/api/context-updates/${meeting.id}`)).json()).meeting_records[0];
    const badRecord = await json('PUT', `/api/context-updates/${meeting.id}/meeting-records`, { records: { 'M-01': { confirmation: 'yes', revision } } });
    const staleRecord = await json('PUT', `/api/context-updates/${meeting.id}/meeting-records`, { records: { 'M-01': { confirmation: 'confirmed', revision: 'old' } } });
    await json('PUT', `/api/context-updates/${meeting.id}/meeting-records`, { records: { 'M-01': { confirmation: 'confirmed', revision } } });
    const meetingDone = await (await json('POST', `/api/context-updates/${meeting.id}/approve`)).json();
    check('a confirmed meeting record alone finishes the update and stays as the record',
      badRecord.status === 400 && staleRecord.status === 409 && meetingDone.status === 'done' && meetingDone.meeting_records?.[0]?.confirmation === 'confirmed'
      && !fs.existsSync(path.join(meetingDir, 'materials')),
      `bad=${badRecord.status} stale=${staleRecord.status} status=${meetingDone.status}`);
    const vttForm = new FormData();
    vttForm.append('file', new Blob(['WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Fictional Speaker>Fictional words.</v>\n']), 'sync.vtt');
    const vttUpdate = await (await json('POST', '/api/context-updates', { title: 'Fictional sync' })).json();
    const vttUp = await fetch(`${base}/api/context-updates/${vttUpdate.id}/materials`, { method: 'POST', body: vttForm });
    const vttSaved = await vttUp.json();
    const vttAgain = await fetch(`${base}/api/context-updates/${vttUpdate.id}/materials`, { method: 'POST', body: vttForm });
    const readable = vttSaved.transcript ? await (await fetch(`${base}/api/context-updates/${vttUpdate.id}/materials/${vttSaved.transcript}`)).text() : '';
    check('a WebVTT upload gets a readable transcript next to it, and the same file twice is refused',
      vttUp.status === 201 && vttSaved.transcript === 'sync.transcript.md' && readable.includes('Fictional Speaker\n  Fictional words.') && vttSaved.transcript_complete === true && vttAgain.status === 409,
      `up=${vttUp.status} again=${vttAgain.status} transcript=${vttSaved.transcript}`);
    const contextIds = (await (await fetch(`${base}/api/context`)).json()).map((n) => n.id);
    check('context updates never appear as context notes', !contextIds.some((id) => String(id).startsWith('CU-')));
  }

  // @-mentions in a task's Objective (picker, execution package, archived tasks, validation).
  const cands = await (await fetch(`${base}/api/mentions?q=`)).json();
  const kinds = new Set(cands.map((c) => c.type));
  check('the mention picker searches stakeholders, templates, context notes and tasks',
    ['stakeholder', 'template', 'context', 'task'].every((k) => kinds.has(k)), [...kinds].join(','));
  const put = (id, body) => fetch(`${base}/api/tasks/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const preview = async (id) => (await (await fetch(`${base}/api/tasks/${id}/execution-package/preview`)).json()).files
    .map((f) => f.path.split(path.sep).join('/'));
  const host = tasks.find((t) => t.status === 'in_review') ?? tasks.find((t) => t.id !== task.id && t.id !== reopened.id);
  const toArchive = tasks.find((t) => t.status === 'blocked' || (t.status === 'in_progress' && t.id !== host.id));
  const stk = cands.find((c) => c.type === 'stakeholder' && !(host.stakeholder_refs ?? []).includes(c.id));
  const before = await preview(host.id);
  await fetch(`${base}/api/tasks/${toArchive.id}/archive`, { method: 'POST' });
  const objective = `${host.body ?? ''}\n\nSee [@${stk.label}](${stk.href}), [@${toArchive.id}](/tasks/active/${toArchive.id}/task.md) `
    + `and again [@${stk.label}](${stk.href}).`;
  await put(host.id, { body: objective });
  const after = await preview(host.id);
  check('a mentioned stakeholder is added to the execution package', after.some((p) => p.endsWith(stk.href)), stk.href);
  check('a mentioned task still resolves after it was archived',
    after.some((p) => p.endsWith(`tasks/archive/${toArchive.id}/task.md`)));
  check('mentions only add files: everything from before is still in the package', before.every((p) => after.includes(p)));
  check('the execution package has no duplicate files', new Set(after).size === after.length);
  await put(host.id, { body: `${objective} Also [@Gone](/context/company/does-not-exist/note.md).` });
  const issues2 = await (await fetch(`${base}/api/workspace/validate`)).json();
  check('a broken mention is reported as a validation warning (not an error)',
    issues2.some((i) => i.rule === 'broken_mention' && i.level === 'warning') && !issues2.some((i) => i.level === 'error'),
    JSON.stringify(issues2.filter((i) => i.level !== 'info').slice(0, 3)));

  const resolve = async (href) => (await (await fetch(`${base}/api/mentions/resolve?href=${encodeURIComponent(href)}`)).json()).exists;
  check('mention chips can tell an existing file from a deleted one',
    (await resolve(stk.href)) === true && (await resolve('/context/company/does-not-exist/note.md')) === false);

  // Org charts: titles survive every save, new unknown ids are rejected, 1.1 only when needed.
  {
    const json = (method, url, body) => fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const people = (await (await fetch(`${base}/api/stakeholders`)).json()).filter((p) => p.id.startsWith('STK-'));
    const [p1, p2, p3] = people.map((p) => p.id);
    const temp = await (await json('POST', '/api/stakeholders', { name: 'Smoke Temp', role: 'Temporary' })).json();
    const chartRes = await json('POST', '/api/org-charts', {
      name: 'Smoke chart', organization: 'Smoke Org',
      members: [{ ref: p1 }, { ref: p2, reports_to: p1, title: 'Chief of Smoke' }, { ref: temp.id, reports_to: p2 }, { ref: p3, reports_to: temp.id, title: 'Analyst' }],
    });
    const smokeChart = await chartRes.json();
    const chartFile = () => fs.readFileSync(path.join(ws, 'stakeholders', 'org-charts', `${smokeChart.id.toLowerCase()}.md`), 'utf8');
    check('an org chart with titles is created and written as schema 1.1',
      chartRes.status === 201 && /schema_version: ['"]?1\.1/.test(chartFile()) && /title: Chief of Smoke/.test(chartFile()));
    const movedRes = await json('PUT', `/api/org-charts/${smokeChart.id}`, {
      members: smokeChart.members.map((m) => (m.ref === p2 ? { ...m, reports_to: undefined } : m)),
    });
    const moved = await movedRes.json();
    check('moving someone keeps their title', moved.members.find((m) => m.ref === p2)?.title === 'Chief of Smoke' && !moved.members.find((m) => m.ref === p2).reports_to);
    const positions = await (await fetch(`${base}/api/org-charts?stakeholder=${p3}`)).json();
    const pos = positions.find((x) => x.chart.id === smokeChart.id);
    check('the position API returns the title in this chart', pos?.title === 'Analyst', JSON.stringify(pos ?? null));
    await fetch(`${base}/api/stakeholders/${temp.id}`, { method: 'DELETE' });
    const afterDelete = await (await fetch(`${base}/api/org-charts/${smokeChart.id}`)).json();
    const p3m = afterDelete.members.find((m) => m.ref === p3);
    check('deleting a stakeholder moves their reports up and keeps the reports\' titles',
      p3m?.reports_to === p2 && p3m?.title === 'Analyst', JSON.stringify(p3m ?? null));
    const unknown = await json('PUT', `/api/org-charts/${smokeChart.id}`, { members: [...afterDelete.members, { ref: 'STK-9999' }] });
    check('adding an unknown stakeholder id to a chart is rejected', unknown.status === 400);
    fs.writeFileSync(path.join(ws, 'stakeholders', 'org-charts', `${smokeChart.id.toLowerCase()}.md`),
      chartFile().replace(/members:\n/, 'members:\n  - ref: STK-9998\n'));
    const stale = await (await fetch(`${base}/api/org-charts/${smokeChart.id}`)).json();
    const staleSave = await json('PUT', `/api/org-charts/${smokeChart.id}`, { members: stale.members.map((m) => (m.ref === p3 ? { ...m, title: 'Senior Analyst' } : m)) });
    check('a chart that already lists a missing stakeholder can still be edited', staleSave.status === 200, `status=${staleSave.status}`);
    const plain = await (await json('POST', '/api/org-charts', { name: 'Plain chart', members: [{ ref: p1 }, { ref: p2, reports_to: p1 }] })).json();
    // Units: membership containers; reporting lines are untouched.
    const unitTemp = await (await json('POST', '/api/stakeholders', { name: 'Smoke Head', role: 'Head' })).json();
    const uChart = await (await json('POST', '/api/org-charts', {
      name: 'Unit chart',
      members: [{ ref: p1, unit: 'U-1' }, { ref: unitTemp.id, reports_to: p1, unit: 'U-2' }, { ref: p2, reports_to: unitTemp.id, unit: 'U-2' }, { ref: p3, reports_to: p1, unit: 'U-9' }],
      units: [{ id: 'U-1', name: 'Operations', head: p1 }, { id: 'U-2', name: 'Logistics', parent: 'U-1', head: unitTemp.id }, { name: 'Unnamed id' }, { id: 'U-3', name: 'Ghost', head: 'STK-9999' }],
    })).json();
    const uFile = () => fs.readFileSync(path.join(ws, 'stakeholders', 'org-charts', `${uChart.id.toLowerCase()}.md`), 'utf8');
    check('a chart with units is written as schema 1.1 with its units',
      /schema_version: ['"]?1\.1/.test(uFile()) && /name: Logistics/.test(uFile()) && uChart.units?.length === 4, JSON.stringify(uChart.units));
    check('a unit without an id gets the next free one', uChart.units?.find((u) => u.name === 'Unnamed id')?.id === 'U-4');
    check('a member in an unknown unit is kept, without the unit', uChart.members.find((m) => m.ref === p3) && !uChart.members.find((m) => m.ref === p3).unit);
    check('a unit head who is not in the chart is dropped', !uChart.units.find((u) => u.id === 'U-3').head);
    const uLoop = await json('PUT', `/api/org-charts/${uChart.id}`, { units: [{ id: 'U-1', name: 'A', parent: 'U-2' }, { id: 'U-2', name: 'B', parent: 'U-1' }] });
    check('units nested in a loop are rejected', uLoop.status === 400);
    const uPos = (await (await fetch(`${base}/api/org-charts?stakeholder=${p2}`)).json()).find((x) => x.chart.id === uChart.id);
    check('the position API returns the unit path and head',
      uPos?.unit?.path?.join('/') === 'Operations/Logistics' && uPos.unit.head?.id === unitTemp.id && uPos.manager?.id === unitTemp.id, JSON.stringify(uPos?.unit ?? null));
    const headPos = (await (await fetch(`${base}/api/org-charts?stakeholder=${p1}`)).json()).find((x) => x.chart.id === uChart.id);
    check('the position API lists the units someone leads', headPos?.head_of?.map((u) => u.name).join(',') === 'Operations');
    await fetch(`${base}/api/stakeholders/${unitTemp.id}`, { method: 'DELETE' });
    const uAfter = await (await fetch(`${base}/api/org-charts/${uChart.id}`)).json();
    check('deleting a unit head keeps the unit without a head, and their reports move up with their unit',
      uAfter.units.find((u) => u.id === 'U-2') && !uAfter.units.find((u) => u.id === 'U-2').head
      && uAfter.members.find((m) => m.ref === p2)?.reports_to === p1 && uAfter.members.find((m) => m.ref === p2)?.unit === 'U-2');
    const titleOnly = await (await json('PUT', `/api/org-charts/${uChart.id}`, { members: uAfter.members.map((m) => (m.ref === p2 ? { ...m, title: 'Coordinator' } : m)) })).json();
    check('saving members only keeps the units', titleOnly.units?.length === 4 && titleOnly.members.find((m) => m.ref === p2)?.unit === 'U-2');

    // Placeholders: chart-local people (P-n) who can manage, lead a unit and be swapped for a stakeholder later.
    const phRes = await json('POST', '/api/org-charts', {
      name: 'Placeholder chart',
      members: [{ ref: p1 }, { ref: 'P-1', name: 'Head of Sales (vacant)', title: 'Head of Sales', reports_to: p1, unit: 'U-1' },
        { ref: p2, reports_to: 'P-1', name: 'ignored for stakeholders' }, { ref: 'P-2', reports_to: 'P-1' }],
      units: [{ id: 'U-1', name: 'Sales', head: 'P-1' }],
    });
    const phChart = await phRes.json();
    const phFile = fs.readFileSync(path.join(ws, 'stakeholders', 'org-charts', `${phChart.id.toLowerCase()}.md`), 'utf8');
    check('a chart with placeholders is accepted and written as schema 1.1',
      phRes.status === 201 && /schema_version: ['"]?1\.1/.test(phFile) && /name: Head of Sales \(vacant\)/.test(phFile), `status=${phRes.status}`);
    check('a placeholder can lead a unit and manage people', phChart.units?.[0]?.head === 'P-1' && phChart.members.find((m) => m.ref === p2)?.reports_to === 'P-1');
    check('a placeholder without a name gets a default one; stakeholders never get a name field',
      phChart.members.find((m) => m.ref === 'P-2')?.name === 'Unnamed placeholder' && !('name' in phChart.members.find((m) => m.ref === p2)));
    const phPos = (await (await fetch(`${base}/api/org-charts?stakeholder=${p2}`)).json()).find((x) => x.chart.id === phChart.id);
    check('the position API marks a placeholder manager', phPos?.manager?.placeholder === true && phPos.manager.name === 'Head of Sales (vacant)'
      && phPos.manager.role === 'Head of Sales', JSON.stringify(phPos?.manager ?? null));
    const phIssues = await (await fetch(`${base}/api/workspace/validate`)).json();
    check('validation does not report placeholders as unknown stakeholders', !phIssues.some((i) => /P-\d/.test(i.message ?? '')),
      JSON.stringify(phIssues.filter((i) => /P-\d/.test(i.message ?? ''))));
    const swapped = await json('PUT', `/api/org-charts/${phChart.id}`, {
      members: phChart.members.map((m) => (m.ref === 'P-1' ? { ref: p3, reports_to: p1, unit: 'U-1', title: 'Head of Sales' } : m.reports_to === 'P-1' ? { ...m, reports_to: p3 } : m)),
      units: [{ id: 'U-1', name: 'Sales', head: p3 }],
    });
    const swappedChart = await swapped.json();
    check('a placeholder can be swapped for a stakeholder', swapped.status === 200 && swappedChart.members.find((m) => m.ref === p2)?.reports_to === p3
      && swappedChart.units[0].head === p3 && !swappedChart.members.some((m) => m.ref === 'P-1'));

    check('a chart without titles is still written as schema 1.0',
      /schema_version: ['"]?1\.0/.test(fs.readFileSync(path.join(ws, 'stakeholders', 'org-charts', `${plain.id.toLowerCase()}.md`), 'utf8')));
  }

  // Git integration: the dashboard can show status, stage and commit in a workspace repo.
  const git = (...args) => execFileSync('git', ['-C', ws, ...args], { env, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Smoke Test');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'commit.gpgsign', 'false');
  const post = (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const status = await (await fetch(`${base}/api/workspace/git/status`)).json();
  check('git status sees the workspace files', status.is_repo === true && status.untracked.length > 0,
    `is_repo=${status.is_repo} untracked=${status.untracked?.length}`);
  check('git stage works', (await post('/api/workspace/git/stage', { file: 'README.md' })).ok);
  check('git commit works', (await post('/api/workspace/git/commit', { message: 'Smoke test commit' })).ok);
  const log = await (await fetch(`${base}/api/workspace/git/log`)).json();
  check('git log shows the commit', log[0]?.message === 'Smoke test commit', `log=${JSON.stringify(log[0] ?? null)}`);
} catch (err) {
  check('smoke test ran to the end', false, `${err}${err?.cause ? ` (cause: ${err.cause.code ?? ''} ${err.cause.message ?? err.cause})` : ''}`);
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed. Server log:\n${serverLog}`);
  process.exit(1);
}
console.log('\nALL PASS');
