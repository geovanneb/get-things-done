import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep the test away from the real ~/.gtd config.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-chat-stream-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
delete process.env['ESB_WORKSPACE_PATH'];

/** A barrier a test opens when it chooses: `reached` resolves once something waits at it. */
function barrier() {
  let open!: () => void;
  let arrive!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { arrive = r; });
  return { open, reached, wait: () => { arrive(); return gate; } };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test('a chat stream is only for the workspace the page shows, and an open one never holds the server\'s shutdown', async (t) => {
  const { startServer } = await import('../src/server');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-chat-stream-ws-')));
  fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
  t.after(() => { for (const d of [home, workspace]) fs.rmSync(d, { recursive: true, force: true }); });

  const running = await startServer({ port: await freePort(), workspacePath: workspace, logRequests: false });
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // After a failure: the page goes away, so the server can close and the test run can end.
  t.after(async () => { if (!closed) { await reader?.cancel().catch(() => {}); await running.close(); } });
  const created = await fetch(`${running.url}/api/chat/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GTD-Workspace': encodeURIComponent(workspace) }, body: JSON.stringify({ provider: 'codex' }),
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  const streamUrl = `${running.url}/api/chat/conversations/${id}/stream`;

  // A page still showing another workspace (another tab switched it) is refused, before anything is read.
  const other = await fetch(`${streamUrl}?workspace=${encodeURIComponent(path.join(workspace, 'other'))}`);
  assert.equal(other.status, 409);
  const sent = await fetch(`${running.url}/api/chat/conversations/${id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GTD-Workspace': encodeURIComponent(path.join(workspace, 'other')) }, body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(sent.status, 409, 'a message is refused the same way');
  const refusal = (await sent.json()) as { message: string; details?: { code?: string } };
  assert.equal(refusal.details?.code, 'other_workspace', 'with a code the chat turns into its own words');
  assert.match(refusal.message, /^This update is in another workspace/, 'the text other pages show is unchanged');

  const stream = await fetch(`${streamUrl}?workspace=${encodeURIComponent(workspace)}`);
  assert.equal(stream.status, 200);
  reader = stream.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"conversation"/, 'the stream starts with the whole conversation');

  // The open stream is ended by the shutdown, so closing does not wait for the page to go away.
  let guard: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error('close() waited for the open chat stream')), 8000); });
  try {
    await Promise.race([running.close(), hung]);
    closed = true;
  } finally {
    clearTimeout(guard);
  }
  for (let r = await reader.read(); !r.done; r = await reader.read()) { /* the rest, until the server ended it */ }
});

test('a stream that starts while the dashboard stops is ended too, and follows the workspace it was opened in', async (t) => {
  const { default: router, endChatStreams } = await import('../src/routes/chat');
  const { ChatService } = await import('../src/services/chat/chatService');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-chat-stream-late-')));
  process.env['ESB_WORKSPACE_PATH'] = workspace;
  const original = ChatService.prototype.get;
  const reading = barrier();
  t.after(() => { ChatService.prototype.get = original; delete process.env['ESB_WORKSPACE_PATH']; fs.rmSync(workspace, { recursive: true, force: true }); });
  const { id } = await new ChatService().create({ provider: 'codex' });
  // The conversation read is held until the shutdown has ended the streams it knew of.
  ChatService.prototype.get = async function (this: InstanceType<typeof ChatService>, ...args: Parameters<typeof original>) {
    await reading.wait();
    return original.apply(this, args);
  };
  const layer = (router as unknown as { stack: { route?: { path: string; stack: { handle: (req: unknown, res: unknown) => Promise<void> }[] } }[] }).stack
    .find((l) => l.route?.path === '/conversations/:id/stream')!;
  const writes: string[] = [];
  let ends = 0;
  const handlers: Record<string, () => void> = {};
  const res = {
    writableLength: 0, writableEnded: false, statusCode: 200,
    status() { return res; }, json() { return res; }, setHeader() {},
    write(chunk: string) { writes.push(chunk); return true; },
    end() { ends++; res.writableEnded = true; handlers['finish']?.(); },
    on(event: string, fn: () => void) { handlers[event] = fn; return res; },
  };
  const req = { params: { id }, query: {}, on(event: string, fn: () => void) { handlers[`req:${event}`] = fn; } };
  const handled = layer.route!.stack[0]!.handle(req, res);
  await reading.reached;
  endChatStreams();
  reading.open();
  await handled;
  assert.equal(ends, 1, 'ended by the shutdown');
  assert.deepEqual(writes, [], 'nothing is sent or followed after it');
  // Switching workspace during a read: the stream still follows the workspace it was opened in.
  const listeners: string[] = [];
  const subscribe = ChatService.prototype.subscribe;
  ChatService.prototype.subscribe = function (this: InstanceType<typeof ChatService>, sid: string, l: Parameters<typeof subscribe>[1], ws?: string) {
    listeners.push(ws ?? '');
    return subscribe.call(this, sid, l, ws);
  };
  t.after(() => { ChatService.prototype.subscribe = subscribe; });
  const switching = barrier();
  ChatService.prototype.get = async function (this: InstanceType<typeof ChatService>, ...args: Parameters<typeof original>) {
    await switching.wait();
    return original.apply(this, args);
  };
  const res2 = { ...res, writableEnded: false, write(chunk: string) { writes.push(chunk); return true; }, end() { ends++; } };
  res2.status = () => res2; res2.json = () => res2;
  res2.on = (event: string, fn: () => void) => { handlers[`2:${event}`] = fn; return res2; };
  const handled2 = layer.route!.stack[0]!.handle(req, res2);
  await switching.reached;
  process.env['ESB_WORKSPACE_PATH'] = path.join(workspace, 'other');
  switching.open();
  await handled2;
  assert.deepEqual(listeners, [workspace], 'subscribed to the workspace the stream was opened in');
  handlers['req:close']?.();
  endChatStreams();
});
