/**
 * Unit tests for the desktop bridge and its browser fallback. Run with `npm run test:desktop-bridge --workspace=ui`.
 */
import { canShowInFolder, folderFromServer, followDesktopUpdate, hasDesktopUpdates, isDesktopApp, openWorkspaceFolder, pickFolder, readDesktopUpdate, restartToUpdate, showInFolder, workspaceFullPath } from './desktop';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const g = globalThis as Record<string, unknown>;
const calls: string[] = [];
g.fetch = async (url: string) => {
  calls.push(url);
  const body = url.endsWith('/pick-folder') ? { path: '/Users/demo/Northwind' } : { opened: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function main() {
  // Browser: no bridge, the server routes are used.
  check('a browser tab is not the desktop app', !isDesktopApp());
  check('the browser picker asks the server', (await pickFolder()) === '/Users/demo/Northwind' && calls.includes('/api/workspace/pick-folder'));
  await openWorkspaceFolder();
  check('the browser opens the folder through the server', calls.includes('/api/workspace/open'));

  // Desktop: the bridge is used and the server is not called.
  calls.length = 0;
  g.gtdDesktop = {
    version: 1,
    pickFolder: async () => 'C:\\Users\\demo\\Northwind',
    openWorkspaceFolder: async () => ({ opened: false, error: 'Folder not found' }),
  };
  check('the bridge marks the desktop app', isDesktopApp());
  check('the desktop picker uses the native dialog', (await pickFolder()) === 'C:\\Users\\demo\\Northwind');
  let error = '';
  try { await openWorkspaceFolder(); } catch (err) { error = (err as Error).message; }
  check('a failed open shows the reason', error === 'Folder not found', error);
  check('the desktop app does not call the server routes', calls.length === 0, calls.join(', '));

  // Something else on window named gtdDesktop is ignored.
  g.gtdDesktop = { pickFolder: 'nope' };
  check('an object without a version is not the bridge', !isDesktopApp());

  // The app's own update (#284): what the page accepts from the bridge.
  check('a ready update is read', JSON.stringify(readDesktopUpdate({ phase: 'ready', version: '0.11.0', percent: null, error: null, dismissed: '0.10.5' })) === JSON.stringify({ phase: 'ready', version: '0.11.0', percent: null, error: null, dismissed: '0.10.5' }));
  check('progress is kept between 0 and 100', readDesktopUpdate({ phase: 'downloading', version: '0.11.0', percent: 140.2 })?.percent === 100);
  check('an unknown phase or no object is no state', readDesktopUpdate({ phase: 'install-now' }) === null && readDesktopUpdate(null) === null && readDesktopUpdate('ready') === null);
  check('odd fields are dropped', readDesktopUpdate({ phase: 'error', version: 7, error: 'x'.repeat(400) })?.error === null);
  check('a browser has no desktop updates', !hasDesktopUpdates() && (await restartToUpdate()) === 'Only the desktop app restarts itself');
  const seen: string[] = [];
  let push: (s: unknown) => void = () => undefined;
  g.gtdDesktop = {
    version: 1,
    updateState: async () => ({ phase: 'downloading', version: '0.11.0', percent: 10 }),
    onUpdateState: (l: (s: unknown) => void) => { push = l; return () => { push = () => undefined; }; },
    restartToUpdate: async () => 'A transcription is running: restart to update when it is done',
  };
  const stop = followDesktopUpdate((s) => seen.push(`${s.phase}:${s.percent ?? ''}`));
  await new Promise((r) => setTimeout(r, 0));
  push({ phase: 'ready', version: '0.11.0' });
  push({ phase: 'bogus' });
  stop();
  push({ phase: 'idle' });
  check('the state now, then each change, until stopped', seen.join(',') === 'downloading:10,ready:', seen.join(','));
  check('a restart that has to wait says why', hasDesktopUpdates() && (await restartToUpdate()) === 'A transcription is running: restart to update when it is done');
  // A change pushed before the first answer arrives is newer: the late answer is dropped.
  let answer: (s: unknown) => void = () => undefined;
  const order: string[] = [];
  (g.gtdDesktop as Record<string, unknown>)['updateState'] = () => new Promise((r) => { answer = r; });
  const stop2 = followDesktopUpdate((s) => order.push(s.phase));
  push({ phase: 'ready', version: '0.11.0' });
  answer({ phase: 'downloading', version: '0.11.0', percent: 90 });
  await new Promise((r) => setTimeout(r, 0));
  stop2();
  check('an older first answer never replaces a newer pushed state', order.join(',') === 'ready', order.join(','));
  delete g.gtdDesktop;

  // Show in folder: only the desktop app opens a folder; the page passes only the workspace-relative path.
  check('a browser cannot show a folder itself', !canShowInFolder());
  let shown = '';
  try { await showInFolder('meetings/MQ-2026-0001'); } catch (err) { shown = (err as Error).message; }
  check('in a browser, showing a folder says it could not', shown === 'Could not open the folder.', shown);
  const asked: string[] = [];
  g.gtdDesktop = { version: 1, pickFolder: async () => null, openWorkspaceFolder: async () => ({ opened: true }),
    showInFolder: async (p: string) => { asked.push(p); return p === 'gone' ? { opened: false, error: 'It is not there any more' } : { opened: true }; } };
  check('the desktop app can show a folder', canShowInFolder());
  await showInFolder('context-updates/CU-2026-0001/materials/MQ-2026-0002-b.vtt');
  check('the bridge gets the relative path as it is', asked.join() === 'context-updates/CU-2026-0001/materials/MQ-2026-0002-b.vtt', asked.join());
  let failed = '';
  try { await showInFolder('gone'); } catch (err) { failed = (err as Error).message; }
  check('a failed show gives the app\'s reason', failed === 'It is not there any more', failed);
  g.gtdDesktop = { version: 1, pickFolder: async () => null, openWorkspaceFolder: async () => ({ opened: true }) };
  check('an older desktop app without the call shows the path instead', !canShowInFolder());
  delete g.gtdDesktop;

  // The full path a browser shows, in the workspace path's own style.
  check('a macOS or Linux path', workspaceFullPath('/Users/demo/Northwind', 'meetings/MQ-2026-0001') === '/Users/demo/Northwind/meetings/MQ-2026-0001');
  check('a trailing slash is not doubled', workspaceFullPath('/Users/demo/Northwind/', 'meetings') === '/Users/demo/Northwind/meetings');
  check('a Windows path uses backslashes', workspaceFullPath('C:\\Users\\demo\\Northwind', 'context-updates/meeting-queue/MQ-2026-0003') === 'C:\\Users\\demo\\Northwind\\context-updates\\meeting-queue\\MQ-2026-0003');
  check('a network share stays one', workspaceFullPath('\\\\server\\share\\Northwind', 'meetings') === '\\\\server\\share\\Northwind\\meetings');
  check('the root folder', workspaceFullPath('/', 'meetings') === '/meetings');

  // A folder only the server knows (a task's, active or archived): asked when clicked, a gone item is a notice.
  const before = g.fetch;
  const folderCalls: string[] = [];
  g.fetch = async (url: string) => {
    folderCalls.push(url);
    if (url.includes('TASK-2026-0009')) return new Response(JSON.stringify({ error: 'Not Found', message: 'Task not found: TASK-2026-0009' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('TASK-2026-0010')) return new Response(JSON.stringify({ error: 'Error', message: 'Invalid path traversal: symbolic link at tasks/archive' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ folder: 'tasks/archive/TASK-2026-0001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const found = await folderFromServer('/api/tasks/TASK-2026-0001/folder');
  check('the server\'s folder is used as it is', found.path === 'tasks/archive/TASK-2026-0001' && !found.missing && folderCalls[0] === '/api/tasks/TASK-2026-0001/folder', JSON.stringify(found));
  const gone = await folderFromServer('/api/tasks/TASK-2026-0009/folder');
  check('an item no longer there is a notice, not an error', gone.missing === 'This folder is no longer in the workspace: it may have been moved or deleted.', JSON.stringify(gone));
  let refused = '';
  try { await folderFromServer('/api/tasks/TASK-2026-0010/folder'); } catch (err) { refused = (err as Error).message; }
  check('a refused folder is still an error with the server\'s reason', refused.startsWith('Invalid path traversal'), refused);
  g.fetch = before;

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll desktop bridge checks passed');
}

void main();
