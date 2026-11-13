import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StakeholderService } from '../src/services/stakeholderService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-stakeholder-clear-'));
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

test('clearing the email and notes of a stakeholder removes them', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const jordan = await service.createStakeholder({ name: 'Jordan Vale', role: 'CFO', email: 'jordan.vale@example.test', notes: 'Prefers Friday calls.' });

  await service.updateStakeholder(jordan.id, { name: 'Jordan Vale', role: 'CFO', email: '', notes: '' });
  const saved = await service.getStakeholder(jordan.id);
  assert.equal(saved.email, undefined, 'a cleared email must not stay on the stakeholder');
  assert.equal(saved.notes, undefined);
  const file = await fsp.readFile(saved.path!, 'utf8');
  assert.doesNotMatch(file, /email:/, 'an empty email is not a valid address in the stakeholder schema');
  assert.doesNotMatch(file, /Friday/);
});

test('an edit that leaves the email and notes out keeps them', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const kim = await service.createStakeholder({ name: 'Kim Park', email: 'kim.park@example.test', notes: 'Owns the carrier contract.' });

  await service.updateStakeholder(kim.id, { role: 'Head of Logistics' });
  const saved = await service.getStakeholder(kim.id);
  assert.equal(saved.email, 'kim.park@example.test');
  assert.equal(saved.notes, 'Owns the carrier contract.');
  assert.equal(saved.role, 'Head of Logistics');
});

test('a blank or null email is never written, and a new address replaces the old one', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const blank = await service.createStakeholder({ name: 'Sam Rivera', email: '   ' });
  assert.doesNotMatch(await fsp.readFile(blank.path!, 'utf8'), /email:/);

  const lee = await service.createStakeholder({ name: 'Lee Chen', email: 'lee.chen@example.test' });
  await service.updateStakeholder(lee.id, { email: null as unknown as string });
  assert.equal((await service.getStakeholder(lee.id)).email, undefined);
  assert.doesNotMatch(await fsp.readFile(lee.path!, 'utf8'), /email:/, 'null is not an address either');

  await service.updateStakeholder(lee.id, { email: 'lee@example.test' });
  assert.equal((await service.getStakeholder(lee.id)).email, 'lee@example.test');
});
