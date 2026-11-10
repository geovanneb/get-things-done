import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('saving a template from the dashboard keeps the body of output.md', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-template-body-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const handWritten = path.join(dir, 'outputs', 'templates', 'team-update', 'output.md');
  await fsp.mkdir(path.dirname(handWritten), { recursive: true });
  const body = 'A weekly note for the team.\n\n## Notes for the agent\n\nAlways list the owners in alphabetical order.';
  await fsp.writeFile(handWritten, `---\nid: OUT-team-update\nslug: team-update\nname: Team update\nformat: md\ndescription: A short weekly note\nrequired_sections:\n  - Highlights\nstyle_guide: Plain sentences.\ntags: []\n---\n\n${body}\n`);
  const { OutputService } = await import('../src/services/outputService');
  const service = new OutputService();
  const bodyOf = async (file: string) => (await fsp.readFile(file, 'utf-8')).split(/^---$/m).slice(2).join('---').trim();

  // The payload the edit dialog sends, with only the name changed.
  const before = await service.getTemplate('OUT-team-update');
  await service.updateTemplate(before.id, { name: 'Team update (v2)', format: before.format, description: before.description, style_guide: before.style_guide });
  assert.equal(await bodyOf(handWritten), body);
  assert.equal((await service.getTemplate(before.id)).name, 'Team update (v2)');
  // A new description does not replace a body someone wrote either.
  await service.updateTemplate(before.id, { description: 'A weekly note for everyone' });
  assert.equal(await bodyOf(handWritten), body);

  // A template created in the dashboard starts with its description as the body; that copy follows the description.
  const created = await service.createTemplate({ name: 'Client letter', description: 'A formal letter to a client' });
  await service.updateTemplate(created.id, { description: 'A formal letter to a client contact' });
  assert.equal(await bodyOf(created.path!), 'A formal letter to a client contact');
});
