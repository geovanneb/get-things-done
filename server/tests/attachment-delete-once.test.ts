import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { deleteAttachment } from '../src/utils/files';

async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-delete-once-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('two removals of one attachment at the same moment: exactly one removes it, the other is told it is gone', async (t) => {
  const dir = await folder(t);
  // A second unlink of the same file can also succeed on some file systems (macOS APFS), so this is checked many
  // times: before the fix both answered "removed" in almost every round there.
  for (let round = 0; round < 300; round++) {
    await fsp.writeFile(path.join(dir, 'draft.txt'), 'Fictional draft.');
    const results = await Promise.allSettled([deleteAttachment(dir, 'draft.txt'), deleteAttachment(dir, 'draft.txt')]);
    const removed = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(removed, 1, `round ${round}: ${removed} removals reported`);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.match((refused.reason as Error).message, /^File not found: draft\.txt$/);
  }
  assert.deepEqual(await fsp.readdir(dir), [], 'nothing is left behind, not even a hidden file');
});

test('a folder is not an attachment: refused as an invalid name and left as it is', async (t) => {
  const dir = await folder(t);
  await fsp.mkdir(path.join(dir, 'deliverables'));
  await fsp.writeFile(path.join(dir, 'deliverables', 'report.md'), 'Fictional report.');
  await assert.rejects(deleteAttachment(dir, 'deliverables'), /^Error: Invalid file name: deliverables is a folder$/);
  assert.deepEqual(await fsp.readdir(dir), ['deliverables']);
  assert.equal(await fsp.readFile(path.join(dir, 'deliverables', 'report.md'), 'utf8'), 'Fictional report.');
  await assert.rejects(deleteAttachment(dir, 'never-uploaded.pdf'), /^Error: File not found: never-uploaded\.pdf$/);
  await assert.rejects(deleteAttachment(path.join(dir, 'deliverables', 'report.md'), 'x.txt'), /^Error: File not found: x\.txt$/, 'the owner "folder" is a file');
});
