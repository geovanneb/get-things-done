import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { reserveIds, reservedSequence } from '../src/services/idReservations';
import { StakeholderService } from '../src/services/stakeholderService';
import { TaskService } from '../src/services/taskService';

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-unsafe-ids-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['stakeholders/people', 'stakeholders/groups', 'tasks/active', 'tasks/archive', '.situation-board']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

const reservedFile = (dir: string) => path.join(dir, '.situation-board', 'reserved-ids.json');

test('an oversized hand-written id is not reserved, so new items can still be created', async (t) => {
  const dir = await workspace(t);
  await reserveIds(['STK-0003', 'STK-99999999999999999999', 'GRP-1000000000', 'TASK-2026-0007']);
  assert.equal(await reservedSequence('STK'), 3);
  assert.equal(await reservedSequence('GRP'), 0);
  assert.equal(await reservedSequence('TASK-2026'), 7);
  const saved = JSON.parse(await fsp.readFile(reservedFile(dir), 'utf-8')) as Record<string, number>;
  assert.deepEqual(saved, { STK: 3, 'TASK-2026': 7 });

  const person = await new StakeholderService().createStakeholder({ name: 'Priya Natarajan' });
  assert.equal(person.id, 'STK-0004');
  const task = await new TaskService().createTask({ title: 'Fictional quarterly review' });
  assert.match(task.id, /^TASK-\d{4}-\d{4}$/);
});

test('an oversized sequence already in the file is ignored for its prefix only, and kept until replaced', async (t) => {
  const dir = await workspace(t);
  // What the old code wrote after deleting STK-99999999999999999999.
  await fsp.writeFile(reservedFile(dir), JSON.stringify({ STK: 1e20, 'TASK-2026': 5, GRP: 2 }));
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });

  assert.equal(await reservedSequence('STK'), 0);
  assert.equal(await reservedSequence('TASK-2026'), 5);
  assert.equal(await reservedSequence('GRP'), 2);
  assert.ok(warnings.some((w) => w.includes('STK')), 'the ignored entry is reported');
  const person = await new StakeholderService().createStakeholder({ name: 'Priya Natarajan' });
  assert.equal(person.id, 'STK-0001');
  const task = await new TaskService().createTask({ title: 'Fictional quarterly review' });
  assert.match(task.id, /^TASK-\d{4}-\d{4}$/);

  // A reservation for another prefix leaves the bad entry as it was; a lower one never lowers a valid mark.
  await reserveIds(['GRP-0001', 'TASK-2026-0009']);
  let saved = JSON.parse(await fsp.readFile(reservedFile(dir), 'utf-8')) as Record<string, number>;
  assert.deepEqual(saved, { STK: 1e20, 'TASK-2026': 9, GRP: 2 });

  // A real reservation for that prefix replaces it.
  await reserveIds(['STK-0001']);
  saved = JSON.parse(await fsp.readFile(reservedFile(dir), 'utf-8')) as Record<string, number>;
  assert.deepEqual(saved, { STK: 1, 'TASK-2026': 9, GRP: 2 });
});

test('a bad or unknown entry never blocks the other prefixes, and unknown keys are kept', async (t) => {
  const dir = await workspace(t);
  t.mock.method(console, 'warn', () => {});
  for (const bad of ['twelve', -1, 1.5, null]) {
    await fsp.writeFile(reservedFile(dir), JSON.stringify({ STK: bad, 'CU-2026': 4 }));
    assert.equal(await reservedSequence('STK'), 0, String(bad));
    assert.equal(await reservedSequence('CU-2026'), 4, String(bad));
  }
  await fsp.writeFile(reservedFile(dir), JSON.stringify({ ORG: 3, STK: 2 }));
  assert.equal(await reservedSequence('STK'), 2);
  await reserveIds(['STK-0003']);
  assert.deepEqual(JSON.parse(await fsp.readFile(reservedFile(dir), 'utf-8')), { ORG: 3, STK: 3 });
});

test('a file that is not a JSON object is still refused rather than read as empty', async (t) => {
  const dir = await workspace(t);
  for (const content of ['{ not json', '[]', 'null', '7']) {
    await fsp.writeFile(reservedFile(dir), content);
    await assert.rejects(reservedSequence('STK'), /ID reservations cannot be read/, content);
    await assert.rejects(reserveIds(['STK-0001']), /ID reservations cannot be read/, content);
    assert.equal(await fsp.readFile(reservedFile(dir), 'utf-8'), content, 'the file is left alone');
  }
});

test('stakeholder creation gives up with a 409 after 20 taken ids', async (t) => {
  const dir = await workspace(t);
  // Files the id scan does not count (no id in them) but that still take the file names.
  for (let i = 1; i <= 25; i++) {
    await fsp.writeFile(path.join(dir, 'stakeholders/people', `stk-${String(i).padStart(4, '0')}.md`), '---\nname: Placeholder\n---\n');
  }
  await assert.rejects(new StakeholderService().createStakeholder({ name: 'Priya Natarajan' }), (err: Error & { statusCode?: number }) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /Could not reserve a new stakeholder id/);
    return true;
  });
});

test('task creation gives up with a 409 after 20 taken ids', async (t) => {
  await workspace(t);
  const fsMod = createRequire(__filename)('fs/promises') as typeof fsp;
  const mkdir = fsMod.mkdir;
  let attempts = 0;
  t.mock.method(fsMod, 'mkdir', async (target: string, options?: unknown) => {
    // Every exclusive task folder create loses the race, as if other writers kept taking the id.
    if (!options && /TASK-\d{4}-\d{4}$/.test(String(target))) {
      attempts++;
      throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
    }
    return mkdir(target, options as Parameters<typeof mkdir>[1]);
  });
  await assert.rejects(new TaskService().createTask({ title: 'Fictional quarterly review' }), (err: Error & { statusCode?: number }) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /Could not reserve a new task id/);
    return true;
  });
  assert.equal(attempts, 20);
});
