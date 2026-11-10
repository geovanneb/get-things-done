import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('a template whose name differs only in case or punctuation is refused, never replacing the first one', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-template-clash-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'outputs', 'templates'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const { OutputService } = await import('../src/services/outputService');
  const service = new OutputService();
  const conflict = (e: { statusCode?: number }) => e.statusCode === 409;

  const first = await service.createTemplate({ name: 'Board memo', format: 'docx', required_sections: ['Decision', 'Risks'], description: 'Two-page memo for the board.' });
  await service.saveTemplateFile(first.id, 'board-memo-template.docx', Buffer.from('fake docx bytes'));
  const before = await fsp.readFile(first.path!, 'utf-8');

  for (const name of ['Board Memo', 'board-memo', 'Board / Memo']) {
    await assert.rejects(service.createTemplate({ name, format: 'md', required_sections: ['Summary'] }), conflict, name);
  }
  assert.equal(await fsp.readFile(first.path!, 'utf-8'), before, 'the first template is unchanged');
  const kept = await service.getTemplate(first.id);
  assert.equal(kept.name, 'Board memo');
  assert.deepEqual(kept.required_sections, ['Decision', 'Risks']);
  assert.deepEqual((await service.listTemplates()).map((x) => x.name), ['Board memo']);
  assert.deepEqual((await service.listTemplateFiles(first.id)).map((f) => f.name), ['board-memo-template.docx']);

  // Concurrent creates must make the same decision as sequential ones.
  const results = await Promise.allSettled(['Weekly update', 'Weekly Update'].map((name) => new OutputService().createTemplate({ name })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.statusCode, 409);
});
