/**
 * Unit tests for opening the workspace's assistant. Run with `npm run test:open-assistant --workspace=ui`.
 */
import { openAssistant } from './openAssistant';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

/** A stub launcher that, like the server, refuses a request for a workspace that is not the open one. */
function server(openWorkspace: { path: string }, fail = false) {
  const launched: string[] = [];
  const post = async (_path: string, _body: unknown, workspace?: string) => {
    if (workspace !== undefined && workspace !== openWorkspace.path) {
      throw Object.assign(new Error('This update is in another workspace.'), { status: 409, code: 'other_workspace' });
    }
    if (fail) throw Object.assign(new Error('Failed to open the assistant'), { status: 500 });
    launched.push(openWorkspace.path);
    return { via: 'terminal' as const };
  };
  return { post, launched };
}

const run = async () => {
  const copies: string[] = [];
  const copy = async (text: string) => { copies.push(text); };
  const base = { tool: 'claude-code' as const, fallbackPath: '/ws/a', windows: false, copy };

  // Two workspaces: the handoff was reviewed in A, another tab switched the dashboard to B.
  const open = { path: '/ws/a' };
  const s = server(open);
  const pinned = await openAssistant({ ...base, workspace: '/ws/a', keepClipboard: true, post: s.post });
  check('pinned to the open workspace: it opens there', pinned.opened && s.launched.join() === '/ws/a');
  open.path = '/ws/b';
  const refused = await openAssistant({ ...base, workspace: '/ws/a', keepClipboard: true, post: s.post });
  check('another workspace open: refused, nothing launched in it', !refused.opened && refused.reason === 'other_workspace' && s.launched.join() === '/ws/a');
  check('and no command is handed out or copied', !('command' in refused) && copies.length === 0);
  const unpinned = await openAssistant({ ...base, post: s.post });
  check('the header (no workspace given) opens whichever workspace is open, as before', unpinned.opened && s.launched.join() === '/ws/a,/ws/b');

  // A failed launch: the command, copied for the header, kept off the clipboard for the handoff.
  const broken = server({ path: '/ws/a' }, true);
  const header = await openAssistant({ ...base, post: broken.post });
  check('a failed launch from the header copies the command', !header.opened && header.reason === 'failed' && header.copied && copies[0] === header.command && header.command.includes('/ws/a') && header.command.endsWith('claude'));
  const handoff = await openAssistant({ ...base, workspace: '/ws/a', keepClipboard: true, post: broken.post });
  check('a failed launch from the handoff leaves the clipboard alone', !handoff.opened && handoff.reason === 'failed' && !handoff.copied && copies.length === 1);
  const noClipboard = await openAssistant({ ...base, post: broken.post, copy: async () => { throw new Error('denied'); } });
  check('no clipboard: the command is still given, not copied', !noClipboard.opened && noClipboard.reason === 'failed' && !noClipboard.copied && noClipboard.command.length > 0);
  const codex = await openAssistant({ ...base, tool: 'codex', post: broken.post });
  check('the fallback runs the workspace tool', !codex.opened && codex.reason === 'failed' && codex.command.endsWith('codex'));

  // Starting with a request: the server is asked for it, and says whether it typed it.
  const bodies: unknown[] = [];
  const typedPost = async (_p: string, body: unknown) => { bodies.push(body); return { via: 'terminal' as const, typed: true, text: '/gtd-task TASK-2026-0001' }; };
  const before = copies.length;
  const started = await openAssistant({ ...base, start: { request: 'task', id: 'TASK-2026-0001' }, post: typedPost });
  check('the request goes to the server with the tool', JSON.stringify(bodies[0]) === JSON.stringify({ tool: 'claude-code', request: { request: 'task', id: 'TASK-2026-0001' } }));
  check('typed by the assistant: nothing is copied', started.opened && started.typed && started.text === '/gtd-task TASK-2026-0001' && copies.length === before);

  const editorPost = async () => ({ via: 'editor' as const, typed: false, text: 'Execute task TASK-2026-0001' });
  const vscode = await openAssistant({ ...base, tool: 'copilot', start: { request: 'task', id: 'TASK-2026-0001' }, post: editorPost });
  check('VS Code cannot be handed the request: it is copied to paste', vscode.opened && !vscode.typed && vscode.copied === true && copies.at(-1) === 'Execute task TASK-2026-0001');

  const olderServer = async () => ({ via: 'terminal' as const });
  const older = await openAssistant({ ...base, tool: 'codex', start: { request: 'analyze', id: 'CU-2026-0001' }, post: olderServer });
  check('an older server that ignores the request: the text is copied to paste', older.opened && !older.typed && older.text === 'Analyze context update CU-2026-0001' && copies.at(-1) === 'Analyze context update CU-2026-0001');

  const failedStart = await openAssistant({ ...base, start: { request: 'apply', id: 'CU-2026-0001' }, post: broken.post });
  check('a failed launch hands over a command that starts with the request', !failedStart.opened && failedStart.reason === 'failed' && failedStart.command.endsWith("claude '/gtd-context-apply CU-2026-0001'") && failedStart.copied);
};

run().then(() => {
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll open assistant checks passed');
});
