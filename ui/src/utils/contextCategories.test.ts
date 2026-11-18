/**
 * Unit tests for context category names and the add/rename checks. Run with `npm run test:context-categories --workspace=ui`.
 */
import { BUILTIN_CATEGORIES, categoryLabel, categoryProblem, MAX_CUSTOM_CATEGORIES } from './contextCategories';
import type { ContextCategoryInfo } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const vendors: ContextCategoryInfo = { id: 'vendors', label: 'Vendors & partners', description: 'Suppliers and contracts.', builtin: false };
const list = [...BUILTIN_CATEGORIES, vendors];

check('a built-in category is named in the interface language, by id', categoryLabel('glossary', list) === 'Glossary');
check('older notes saying "Company" still get the built-in name', categoryLabel('Company', list) === 'Company');
check('a custom category shows the name its owner gave it', categoryLabel('vendors', list) === 'Vendors & partners');
check('a category the list does not have is shown as written', categoryLabel('archive', list) === 'archive');
check('a key of Object.prototype is never looked up', categoryLabel('constructor', list) === 'constructor');

check('an empty name is refused', categoryProblem('  ', '', list)?.field === 'label');
check('a name over 40 characters is refused', categoryProblem('x'.repeat(41), '', list)?.field === 'label');
check('a description over 300 characters is refused on that field', categoryProblem('Partners', 'x'.repeat(301), list)?.field === 'description');
check('a built-in name is taken, without case', /already a category/.test(categoryProblem('risks', '', list)?.message ?? ''));
check('a custom name is taken, without case', /Vendors & partners/.test(categoryProblem('VENDORS & PARTNERS', '', list)?.message ?? ''));
check('a custom id is taken too', categoryProblem('vendors', '', list) !== null);
check('renaming keeps its own name free', categoryProblem('Vendors & partners', 'New text', list, 'vendors') === null);
check('a new, free name passes', categoryProblem('Regulators', '', list) === null);

const full = [...BUILTIN_CATEGORIES, ...Array.from({ length: MAX_CUSTOM_CATEGORIES }, (_, i) => ({ id: `c${i}`, label: `C${i}`, builtin: false }))];
check('the limit stops a new category, as a form message', categoryProblem('One more', '', full)?.field === 'form');
check('the limit does not stop a rename', categoryProblem('Renamed', '', full, 'c0') === null);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll context category checks passed');
