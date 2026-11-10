import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reserveIds, reservedSequence } from '../src/services/idReservations';
import { StakeholderService } from '../src/services/stakeholderService';

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-release-ids-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('concurrent reservations preserve every prefix and the highest sequence', async (t) => {
  await workspace(t);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      reserveIds([`TASK-${2020 + i}-0001`, `STK-${String(i + 1).padStart(4, '0')}`]),
    ),
  );
  for (let i = 0; i < 12; i++) assert.equal(await reservedSequence(`TASK-${2020 + i}`), 1);
  assert.equal(await reservedSequence('STK'), 12);
});

test('simultaneously deleting a person and a group never reuses either id', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const person = await service.createStakeholder({ name: 'Fictional person' });
  const group = await service.createStakeholder({ name: 'Fictional group', type: 'groups' });
  await Promise.all([service.deleteStakeholder(person.id), service.deleteStakeholder(group.id)]);
  assert.notEqual((await service.createStakeholder({ name: 'Next person' })).id, person.id);
  assert.notEqual((await service.createStakeholder({ name: 'Next group', type: 'groups' })).id, group.id);
});

test('reservations from separate dashboard processes preserve every prefix', async (t) => {
  const dir = await workspace(t);
  const modulePath = path.resolve(__dirname, '../src/services/idReservations.ts');
  await Promise.all(
    ['TASK-2026-0009', 'CU-2026-0012', 'STK-0017', 'GRP-0008'].map((id) =>
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `require(${JSON.stringify(modulePath)}).reserveIds([${JSON.stringify(id)}]).catch(e => { console.error(e); process.exitCode = 1; })`,
        ],
        { env: { ...process.env, ESB_WORKSPACE_PATH: dir } },
      ),
    ),
  );
  for (const [prefix, expected] of [
    ['TASK-2026', 9],
    ['CU-2026', 12],
    ['STK', 17],
    ['GRP', 8],
  ] as const) {
    assert.equal(await reservedSequence(prefix), expected);
  }
});
