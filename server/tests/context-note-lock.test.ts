import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

/** The HTTP status the API answers with for this error, through the real error handler. */
async function statusOf(err: unknown): Promise<number> {
  const { errorHandler } = await import('../src/middleware/errorHandler');
  let status = 0;
  const res = { headersSent: false, status(code: number) { status = code; return res; }, json() { return res; } };
  const original = console.error;
  console.error = () => {};
  try {
    errorHandler(err as Error, { method: 'PUT', path: '/api/context/x', socket: {} } as never, res as never, () => {});
  } finally {
    console.error = original;
  }
  return status;
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-context-lock-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('two moves of the same note at once never fail with a server error', async (t) => {
  await workspace(t);
  const { ContextService } = await import('../src/services/contextService');

  for (let round = 0; round < 5; round++) {
    const title = `Vendor shortlist ${round}`;
    const note = await new ContextService().createContextNote({ category: 'company', title, body: 'Three vendors.\n' });
    const results = await Promise.allSettled([
      new ContextService().updateContextNote(note.id, { category: 'strategy' }),
      new ContextService().updateContextNote(note.id, { category: 'strategy' }),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') assert.equal(await statusOf(r.reason), 404, `round ${round}: ${r.reason}`);
    }
    const now = await new ContextService().getContextNote(note.id);
    assert.equal(now.category, 'strategy');
    assert.match(now.body ?? '', /Three vendors\./);
  }
});

test('an edit made while the note moves is kept, in the new category', async (t) => {
  await workspace(t);
  const { ContextService } = await import('../src/services/contextService');

  for (let round = 0; round < 5; round++) {
    const note = await new ContextService().createContextNote({ category: 'company', title: `Hiring plan ${round}`, body: 'Five roles.\n' });
    const results = await Promise.allSettled([
      new ContextService().updateContextNote(note.id, { category: 'organization' }),
      new ContextService().updateContextNote(note.id, { body: 'Six roles, one in design.\n' }),
    ]);
    for (const r of results) assert.equal(r.status, 'fulfilled', r.status === 'rejected' ? `round ${round}: ${r.reason}` : '');
    const now = await new ContextService().getContextNote(note.id);
    assert.equal(now.category, 'organization', `round ${round}`);
    assert.match(now.body ?? '', /Six roles, one in design\./, `round ${round}: the edit is lost`);
  }
});

test('deleting a note while it moves ends with the note gone and no server error', async (t) => {
  const dir = await workspace(t);
  const { ContextService } = await import('../src/services/contextService');

  for (let round = 0; round < 5; round++) {
    const note = await new ContextService().createContextNote({ category: 'company', title: `Office move ${round}`, body: 'Q3.\n' });
    const results = await Promise.allSettled([
      new ContextService().updateContextNote(note.id, { category: 'risks' }),
      new ContextService().deleteContextNote(note.id),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') assert.equal(await statusOf(r.reason), 404, `round ${round}: ${r.reason}`);
    }
    await assert.rejects(new ContextService().getContextNote(note.id), /not found/);
    for (const category of ['company', 'risks']) {
      assert.equal(await fsp.access(path.join(dir, 'context', category, `office-move-${round}`)).then(() => true, () => false), false, `round ${round}: ${category}`);
    }
  }
  // Every lock is released.
  assert.deepEqual(await fsp.readdir(path.join(dir, '.situation-board', 'context-locks')), []);
});

test('a hand-written id that is not a file name can still be edited and deleted', async (t) => {
  const dir = await workspace(t);
  const { ContextService } = await import('../src/services/contextService');
  const noteDir = path.join(dir, 'context', 'strategy', 'pricing');
  await fsp.mkdir(noteDir, { recursive: true });
  await fsp.writeFile(path.join(noteDir, 'note.md'), '---\nid: "CTX:pricing."\ntitle: Pricing\n---\nOld.\n');

  const updated = await new ContextService().updateContextNote('CTX:pricing.', { body: 'New.\n', category: 'risks' });
  assert.equal(updated.category, 'risks');
  assert.match(await fsp.readFile(updated.path!, 'utf-8'), /New\./);
  await new ContextService().deleteContextNote('CTX:pricing.');
  await assert.rejects(new ContextService().getContextNote('CTX:pricing.'), /not found/);
});
