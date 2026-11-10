import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StakeholderService } from '../src/services/stakeholderService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-stakeholder-ids-'));
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

test('deleting the newest stakeholder or group does not hand its id to the next new one', async (t) => {
  await workspace(t);
  const service = new StakeholderService();

  const dana = await service.createStakeholder({ name: 'Dana Whitfield', role: 'CFO' });
  await service.deleteStakeholder(dana.id);
  const priya = await service.createStakeholder({ name: 'Priya Natarajan', role: 'Head of Sales' });
  assert.notEqual(priya.id, dana.id, 'a task or @mention naming the deleted person would now open the new one');
  await assert.rejects(service.getStakeholder(dana.id), /Stakeholder not found/);

  const board = await service.createStakeholder({ name: 'Fictional Board', type: 'groups' });
  await service.deleteStakeholder(board.id);
  const council = await service.createStakeholder({ name: 'Fictional Council', type: 'groups' });
  assert.notEqual(council.id, board.id);
});
