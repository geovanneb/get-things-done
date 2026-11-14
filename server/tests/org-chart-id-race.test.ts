import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { OrgChartService } from '../src/services/orgChartService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-org-chart-race-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['stakeholders/people', 'stakeholders/groups', 'stakeholders/org-charts', '.situation-board']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

test('org charts created at the same moment get distinct ids and are all kept', async (t) => {
  const dir = await workspace(t);
  const service = new OrgChartService();
  const names = ['Northwind Labs', 'Contoso Ltd.', 'Fabrikam', 'Tailspin Toys', 'Adventure Works'];

  const created = await Promise.all(names.map((name) => service.createChart({ name })));
  assert.equal(new Set(created.map((c) => c.id)).size, names.length, 'one chart would silently replace another');
  const files = (await fsp.readdir(path.join(dir, 'stakeholders', 'org-charts'))).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, names.length);
  assert.deepEqual((await service.listCharts()).map((c) => c.name).sort(), [...names].sort());
  for (const chart of created) assert.equal((await service.getChart(chart.id)).name, chart.name);
});

test('creating a chart gives up with 409 when every next id is taken', async (t) => {
  const dir = await workspace(t);
  // Unreadable files are skipped when charts are listed, so their numbers are not seen as taken in advance.
  for (let n = 1; n <= 20; n++) {
    await fsp.writeFile(path.join(dir, 'stakeholders', 'org-charts', `org-${String(n).padStart(4, '0')}.md`), '---\nname: [unclosed\n---\n');
  }
  const service = new OrgChartService();
  await assert.rejects(service.createChart({ name: 'Northwind Labs' }), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  assert.equal((await fsp.readdir(path.join(dir, 'stakeholders', 'org-charts'))).length, 20, 'no existing file is overwritten');
});
