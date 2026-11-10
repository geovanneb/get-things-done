import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StakeholderService } from '../src/services/stakeholderService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-stakeholder-race-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['stakeholders/people', 'stakeholders/groups', '.situation-board']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

test('two stakeholders created at the same moment get two ids and both are kept', async (t) => {
  await workspace(t);
  const service = new StakeholderService();

  const [marcus, elena] = await Promise.all([
    service.createStakeholder({ name: 'Marcus Lee', role: 'CTO' }),
    service.createStakeholder({ name: 'Elena Varga', role: 'General Counsel' }),
  ]);
  assert.notEqual(marcus.id, elena.id, 'one person would silently replace the other');
  assert.equal((await service.getStakeholder(marcus.id)).name, 'Marcus Lee');
  assert.equal((await service.getStakeholder(elena.id)).name, 'Elena Varga');
  assert.deepEqual((await service.listStakeholders('people')).map((s) => s.name), ['Elena Varga', 'Marcus Lee']);
});
