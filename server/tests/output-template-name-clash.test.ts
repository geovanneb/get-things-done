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

test('a template name without ASCII letters gets its own ASCII id, and ASCII names keep their slug', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-ja-template-'));
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

  const weekly = await service.createTemplate({ name: '週次レポート', format: 'md' });
  assert.match(weekly.id, /^OUT-template-[0-9a-f]{8}$/);
  assert.equal((await service.getTemplate(weekly.id)).name, '週次レポート', 'the name is kept as written');

  // Both names reduce to "2026" in ASCII, but they are different templates.
  const a = await service.createTemplate({ name: '週次レポート 2026', format: 'md' });
  const b = await service.createTemplate({ name: '月次レポート 2026', format: 'md' });
  assert.match(a.id, /^OUT-template-2026-[0-9a-f]{8}$/);
  assert.match(b.id, /^OUT-template-2026-[0-9a-f]{8}$/);
  assert.notEqual(a.id, b.id);

  assert.equal((await service.createTemplate({ name: 'Board memo 2026' })).id, 'OUT-board-memo-2026');
});
