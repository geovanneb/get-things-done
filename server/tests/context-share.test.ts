import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { exportBody } from '../src/services/contextShare';

test('the export keeps headings, paragraphs, lists, tables, emphasis and code, and leaves out the rest', () => {
  const out = exportBody([
    '# Heading', '',
    'Intro with **bold**, _em_, `code`, [a link](https://secret.example/x) and ![img](https://img.example/a.png) <span>words</span>.',
    '<!-- private comment -->', '<div>block html secret</div>', '',
    '- [ ] task item', '- item two with ~~strike~~', '',
    '| A | B |', '|---|---|', '| 1 | <b>2</b> |', '',
    '```js', 'const x = 1;', '```', '',
    '> quoted', '',
    'Footnote[^1]', '', '[^1]: secret footnote', '', '[ref]: https://hidden.example', '',
  ].join('\n'));
  assert.match(out, /^## Heading/m, 'headings move one level below the note title');
  assert.match(out, /\*\*bold\*\*/);
  assert.match(out, /a link/);
  assert.match(out, /words/);
  assert.match(out, /\| 1 \| 2 \|/);
  assert.match(out, /```js\nconst x = 1;\n```/);
  assert.match(out, /^> quoted/m);
  assert.equal(exportBody('Public text. <!-- hidden -->\n'), 'Public text.', 'no escaped space is left where a comment was');
  assert.equal(exportBody('## Top\n\n#### Deeper\n'), '## Top\n\n#### Deeper', 'the top heading sits right under the title, steps kept');
  for (const hidden of ['secret.example', 'img.example', 'private comment', 'block html secret', 'secret footnote', 'hidden.example', '<span', '<b>', '[ ]']) {
    assert.ok(!out.includes(hidden), `${hidden} is left out`);
  }
});

test('only shareable notes are shared; the download is exactly the preview, and a change in between needs a new preview', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-context-share-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const write = async (category: string, slug: string, frontmatter: string, body: string) => {
    await fsp.mkdir(path.join(dir, 'context', category, slug), { recursive: true });
    const file = path.join(dir, 'context', category, slug, 'note.md');
    await fsp.writeFile(file, `---\nid: CTX-${slug}\ntitle: ${slug}\ncategory: ${category}\n${frontmatter}---\n${body}`);
    return file;
  };
  const shared = await write('company', 'public-facts', 'sensitivity: shareable\nsource: private-source\n', 'Founded in 2001. [Site](https://internal.example)\n');
  await write('strategy', 'second', 'sensitivity: shareable\n', '# Plan\nGrow.\n');
  await write('risks', 'internal-view', 'sensitivity: internal\n', 'Internal.\n');
  await write('risks', 'unlabelled', '', 'No label.\n');
  await write('risks', 'odd-label', 'sensitivity: Public\n', 'Odd.\n');
  await write('decisions', 'mine', 'sensitivity: personal\n', 'Personal.\n');

  const { previewContextShare, downloadContextShare } = await import('../src/services/contextShare');
  const status = (p: Promise<unknown>, code: number) => assert.rejects(p, (e: { statusCode?: number }) => e.statusCode === code);

  const preview = await previewContextShare({ notes: ['CTX-public-facts', 'CTX-second'] });
  assert.ok(preview.token && preview.text);
  assert.equal(preview.text, '# public-facts\n\nFounded in 2001. Site\n\n---\n\n# second\n\n## Plan\n\nGrow.\n');
  for (const hidden of ['private-source', 'internal.example', 'sensitivity', 'CTX-']) assert.ok(!preview.text!.includes(hidden), hidden);
  assert.equal((await downloadContextShare({ notes: ['CTX-public-facts', 'CTX-second'], token: preview.token })).text, preview.text);

  // Not shareable: internal, unlabelled, unknown label, personal, missing. No text, no token.
  for (const id of ['CTX-internal-view', 'CTX-unlabelled', 'CTX-odd-label', 'CTX-mine', 'CTX-gone']) {
    const refused = await previewContextShare({ notes: ['CTX-public-facts', id] });
    assert.equal(refused.text, null, id);
    assert.equal(refused.token, null, id);
    assert.ok(refused.rows.find((r) => r.id === id)?.problem, id);
  }

  // Changed, relabelled or reordered after the preview: refused, a new preview is needed.
  await fsp.appendFile(shared, 'One more line.\n');
  await status(downloadContextShare({ notes: ['CTX-public-facts', 'CTX-second'], token: preview.token }), 409);
  const again = await previewContextShare({ notes: ['CTX-public-facts', 'CTX-second'] });
  await fsp.writeFile(shared, (await fsp.readFile(shared, 'utf-8')).replace('sensitivity: shareable', 'sensitivity: internal'));
  await status(downloadContextShare({ notes: ['CTX-public-facts', 'CTX-second'], token: again.token }), 409);
  await fsp.writeFile(shared, (await fsp.readFile(shared, 'utf-8')).replace('sensitivity: internal', 'sensitivity: shareable'));
  const third = await previewContextShare({ notes: ['CTX-public-facts', 'CTX-second'] });
  await status(downloadContextShare({ notes: ['CTX-second', 'CTX-public-facts'], token: third.token }), 409);

  // Bad requests.
  await status(previewContextShare({ notes: [] }), 400);
  await status(previewContextShare({ notes: ['../etc'] }), 400);
  await status(previewContextShare({ notes: ['CTX-second', 'CTX-second'] }), 400);
  await status(downloadContextShare({ notes: ['CTX-second'], token: 'x' }), 400);

  // A note reached through a link is never read.
  await fsp.mkdir(path.join(dir, 'outside'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'outside', 'note.md'), '---\nid: CTX-linked\ntitle: Linked\nsensitivity: shareable\n---\nOutside.\n');
  await fsp.symlink(path.join(dir, 'outside'), path.join(dir, 'context', 'company', 'linked'));
  assert.ok((await previewContextShare({ notes: ['CTX-linked'] })).rows[0]!.problem);

  // Two notes with one id are refused, not guessed.
  await write('situation', 'public-facts-copy', 'sensitivity: shareable\n', 'Copy.\n');
  const copyFile = path.join(dir, 'context', 'situation', 'public-facts-copy', 'note.md');
  await fsp.writeFile(copyFile, (await fsp.readFile(copyFile, 'utf-8')).replace('id: CTX-public-facts-copy', 'id: CTX-public-facts'));
  assert.match((await previewContextShare({ notes: ['CTX-public-facts'] })).rows[0]!.problem ?? '', /Two notes/);
});
