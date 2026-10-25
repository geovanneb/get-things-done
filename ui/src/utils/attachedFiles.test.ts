/**
 * Unit tests for grouping attached files by folder. Run with `npm run test:files --workspace=ui`.
 */
import { groupByFolder } from './attachedFiles';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const names = (list: string[]) => list.map((name) => ({ name }));
const shape = (groups: ReturnType<typeof groupByFolder<{ name: string }>>) =>
  groups.map((g) => `${g.folder || '.'}:${g.items.map((f) => f.name).join('+')}`).join(' | ');

const interleaved = groupByFolder(names(['top.pdf', 'a/a.txt', 'a/b/x.txt', 'a/z.txt']));
check('a folder interleaved with its subfolder is one group', shape(interleaved) === '.:top.pdf | a:a/a.txt+a/z.txt | a/b:a/b/x.txt', shape(interleaved));
check('every folder appears once', new Set(interleaved.map((g) => g.folder)).size === interleaved.length);

const order = groupByFolder(names(['z/1.txt', 'new.pdf', 'b/2.txt', 'old.pdf']));
check('top-level files come first, in the order given (newest first from the server)', shape(order) === '.:new.pdf+old.pdf | b:b/2.txt | z:z/1.txt', shape(order));
check('only subfolders: no empty top-level group', groupByFolder(names(['a/1.txt']))[0].folder === 'a');
check('no files: no groups', groupByFolder([]).length === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
