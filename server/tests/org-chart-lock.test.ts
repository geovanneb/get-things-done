import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as orgCharts from '../src/services/orgChartService';
import { OrgChartService } from '../src/services/orgChartService';
import { StakeholderService } from '../src/services/stakeholderService';
import { FileService } from '../src/services/fileService';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { lock, unlock } from '../src/utils/fileLock';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';

/**
 * Each race is played in a fixed order: a hook pauses one operation at the step where the other used to slip in
 * (right before it writes the chart), starts the other and holds the write until the other has either finished or
 * reported that it is waiting for this chart's lock (chartLockWaits). No elapsed time is taken as evidence: without
 * the lock the other always finishes first, so the outcome below is wrong; with it the other is queued behind the
 * write.
 */
// Read through the namespace so these tests still run, and fail on their assertions, against code without the hook.
const lockWaits = (orgCharts as { chartLockWaits?: { onWait: ((id: string) => void) | null } }).chartLockWaits ?? { onWait: null };

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-org-chart-lock-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['stakeholders/people', 'stakeholders/groups', 'stakeholders/org-charts', 'context-updates', '.situation-board/trash']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

/** Runs `other` once, the first time a chart file is about to be written, and holds that write until it is done or waits for the chart lock. */
function beforeFirstChartWrite(t: { after: (fn: () => void) => void }, other: () => Promise<unknown>): { done: () => Promise<unknown> } {
  const original = FileService.prototype.writeMarkdown;
  let started: Promise<unknown> | null = null;
  FileService.prototype.writeMarkdown = async function (this: FileService, filePath, frontmatter, content) {
    if (!started && filePath.includes(`${path.sep}org-charts${path.sep}`)) {
      const queued = new Promise<void>((resolve) => { lockWaits.onWait = () => resolve(); });
      started = other();
      started.catch(() => {});
      await Promise.race([started.catch(() => {}), queued]);
      lockWaits.onWait = null;
    }
    return original.call(this, filePath, frontmatter, content);
  } as typeof original;
  t.after(() => { FileService.prototype.writeMarkdown = original; lockWaits.onWait = null; });
  return { done: () => started ?? Promise.resolve() };
}

async function people(...names: string[]): Promise<string[]> {
  const service = new StakeholderService();
  const ids: string[] = [];
  for (const name of names) ids.push((await service.createStakeholder({ name, role: 'Fictional role' })).id);
  return ids;
}

const chartFile = (ws: string, id: string) => path.join(ws, 'stakeholders', 'org-charts', `${id.toLowerCase()}.md`);
const exists = (file: string) => fsp.access(file).then(() => true, () => false);

test('a chart deleted while a removed person is taken out of it is not recreated (delete first)', async (t) => {
  const ws = await workspace(t);
  const charts = new OrgChartService();
  const [priya, sam] = await people('Priya Natarajan', 'Sam Okafor');
  const chart = await charts.createChart({ name: 'Northwind Labs', members: [{ ref: priya! }, { ref: sam!, reports_to: priya! }] });

  // The removal has listed the charts; the chart is deleted before it rewrites it.
  const original = OrgChartService.prototype.listCharts;
  let paused = false;
  OrgChartService.prototype.listCharts = async function (this: OrgChartService) {
    const result = await original.call(this);
    if (!paused) {
      paused = true;
      await new OrgChartService().deleteChart(chart.id);
    }
    return result;
  };
  t.after(() => { OrgChartService.prototype.listCharts = original; });

  await new StakeholderService().deleteStakeholder(sam!);
  await charts.removeStakeholder(sam!);
  assert.equal(await exists(chartFile(ws, chart.id)), false, 'the deleted chart came back');
});

test('a chart deleted while a removed person is taken out of it is not recreated (removal first)', async (t) => {
  const ws = await workspace(t);
  const charts = new OrgChartService();
  const [priya, sam] = await people('Priya Natarajan', 'Sam Okafor');
  const chart = await charts.createChart({ name: 'Northwind Labs', members: [{ ref: priya! }, { ref: sam!, reports_to: priya! }] });

  const deletion = beforeFirstChartWrite(t, () => new OrgChartService().deleteChart(chart.id));
  await new StakeholderService().deleteStakeholder(sam!);
  await charts.removeStakeholder(sam!);
  await deletion.done();
  assert.equal(await exists(chartFile(ws, chart.id)), false, 'the deleted chart came back');
});

test('a person removed while a member edit of the same chart is saving is not put back', async (t) => {
  await workspace(t);
  const charts = new OrgChartService();
  const [priya, sam, lee] = await people('Priya Natarajan', 'Sam Okafor', 'Lee Moreau');
  const chart = await charts.createChart({ name: 'Northwind Labs', members: [{ ref: priya! }, { ref: sam!, reports_to: priya! }] });

  // A page loaded before the deletion adds Lee and still sends Sam; Sam is deleted while that save is running.
  const removal = beforeFirstChartWrite(t, async () => {
    await new StakeholderService().deleteStakeholder(sam!);
    await new OrgChartService().removeStakeholder(sam!);
  });
  await charts.updateChart(chart.id, { members: [{ ref: priya! }, { ref: sam!, reports_to: priya! }, { ref: lee!, reports_to: priya! }] });
  await removal.done();

  const now = await charts.getChart(chart.id);
  assert.deepEqual(now.members.map((m) => m.ref).sort(), [priya!, lee!].sort(), 'the removed person is back, or the edit is lost');
});

test('a person removed while a save is adding them to a chart is taken out again', async (t) => {
  await workspace(t);
  const charts = new OrgChartService();
  const [priya, sam] = await people('Priya Natarajan', 'Sam Okafor');
  const chart = await charts.createChart({ name: 'Northwind Labs', members: [{ ref: priya! }] });

  // The save has checked that Sam exists and is about to write; Sam is deleted before the chart lists him.
  const removal = beforeFirstChartWrite(t, async () => {
    await new StakeholderService().deleteStakeholder(sam!);
    await new OrgChartService().removeStakeholder(sam!);
  });
  await charts.updateChart(chart.id, { members: [{ ref: priya! }, { ref: sam!, reports_to: priya! }] });
  await removal.done();

  assert.deepEqual((await charts.getChart(chart.id)).members.map((m) => m.ref), [priya!], 'the deleted person was written into the chart');
});

test('front-matter keys the app does not know are kept when a chart is saved', async (t) => {
  const ws = await workspace(t);
  const charts = new OrgChartService();
  const [priya, sam] = await people('Priya Natarajan', 'Sam Okafor');
  const chart = await charts.createChart({ name: 'Northwind Labs', members: [{ ref: priya! }, { ref: sam!, reports_to: priya! }] });
  const file = chartFile(ws, chart.id);
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, source_note: 'context/organization/northwind/note.md', reviewed: true }));

  await charts.updateChart(chart.id, { name: 'Northwind Labs (EU)', organization: 'Northwind' });
  await charts.updateChart(chart.id, { organization: '' });
  await new StakeholderService().deleteStakeholder(sam!);
  await charts.removeStakeholder(sam!);

  const data = parseMarkdown(await fsp.readFile(file, 'utf-8')).data as Record<string, unknown>;
  assert.equal(data.source_note, 'context/organization/northwind/note.md');
  assert.equal(data.reviewed, true);
  assert.equal(data.name, 'Northwind Labs (EU)');
  assert.equal('organization' in data, false, 'a field the user cleared stays cleared');
  assert.deepEqual((data.members as Array<{ ref: string }>).map((m) => m.ref), [priya!]);
});

test('a chart save waits for another one and answers 409 org_chart_busy when it does not finish in time', async (t) => {
  const ws = await workspace(t);
  const charts = new OrgChartService();
  const chart = await charts.createChart({ name: 'Northwind Labs' });
  const lockDir = path.join(ws, '.situation-board', 'org-chart-locks');
  await fsp.mkdir(lockDir, { recursive: true });
  const held = await lock(path.join(lockDir, `${chart.id}.lock`), 1000, () => new Error('lock not taken'));
  try {
    await assert.rejects(charts.updateChart(chart.id, { name: 'Renamed' }), (err: Error & { statusCode?: number; details?: { code?: string } }) =>
      err.statusCode === 409 && err.details?.code === 'org_chart_busy');
  } finally {
    await unlock(held);
  }
  assert.equal((await charts.getChart(chart.id)).name, 'Northwind Labs', 'nothing was written while it was busy');
  assert.equal((await charts.updateChart(chart.id, { name: 'Renamed' })).name, 'Renamed');
});

/** A context update that is done, with one accepted removal of this file. */
async function acceptedRemoval(ws: string, target: string): Promise<{ cu: ContextUpdateService; id: string }> {
  const cu = new ContextUpdateService();
  const update = await cu.create({ title: 'Fictional cleanup' });
  const file = path.join(ws, 'context-updates', update.id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'done', proposals: [
    { id: 'P-01', action: 'remove', target, decision: 'accepted' },
  ] }));
  return { cu, id: update.id };
}

test('a chart removed by an accepted context update is not written back by a save that was running', async (t) => {
  const ws = await workspace(t);
  const charts = new OrgChartService();
  const [priya, sam] = await people('Priya Natarajan', 'Sam Okafor');
  const chart = await charts.createChart({ name: 'Northwind Labs', members: [{ ref: priya! }, { ref: sam!, reports_to: priya! }] });
  const { cu, id } = await acceptedRemoval(ws, `stakeholders/org-charts/${chart.id.toLowerCase()}.md`);

  const finishing = beforeFirstChartWrite(t, () => cu.get(id));
  await new StakeholderService().deleteStakeholder(sam!);
  await charts.removeStakeholder(sam!);
  await finishing.done();

  assert.equal(await exists(chartFile(ws, chart.id)), false, 'the removed chart came back');
  assert.equal((await cu.get(id)).proposals[0]!.outcome, 'applied');
});

test('an accepted removal of a chart that is being saved stays pending and is done the next time', async (t) => {
  const ws = await workspace(t);
  const chart = await new OrgChartService().createChart({ name: 'Northwind Labs' });
  const { cu, id } = await acceptedRemoval(ws, `stakeholders/org-charts/${chart.id.toLowerCase()}.md`);
  const lockDir = path.join(ws, '.situation-board', 'org-chart-locks');
  await fsp.mkdir(lockDir, { recursive: true });
  const held = await lock(path.join(lockDir, `${chart.id}.lock`), 1000, () => new Error('lock not taken'));
  try {
    assert.equal((await cu.get(id)).proposals[0]!.outcome || 'pending', 'pending', 'a busy chart is not a failed removal');
    assert.equal(await exists(chartFile(ws, chart.id)), true);
  } finally {
    await unlock(held);
  }
  assert.equal((await cu.get(id)).proposals[0]!.outcome, 'applied');
  assert.equal(await exists(chartFile(ws, chart.id)), false);
});
