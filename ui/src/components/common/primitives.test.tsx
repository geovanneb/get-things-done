/**
 * Behaviour and accessibility of the shared primitives (docs/design-system.md).
 * Rendered to static HTML, so it runs in plain Node. Run with `npm run test:primitives --workspace=ui`.
 * Dialog focus and keyboard behaviour need a browser: see scripts/visual-check.mjs.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import Button from './Button';
import IconButton, { icons } from './IconButton';
import Input, { Field, FieldRow, SearchInput, Select, Textarea } from './Input';
import Notice from './Notice';
import Card from './Card';
import Page, { PageHeader, Section } from './Page';
import { CountBadge, SegmentedControl, Tabs } from './Tabs';
import EmptyState from './EmptyState';
import LoadingSpinner from './LoadingSpinner';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const attr = (markup: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(markup)?.[1];
const noop = () => {};

// ---- Button --------------------------------------------------------------
const plain = html(<Button>Save</Button>);
check('a button does not submit a form unless asked', attr(plain, 'type') === 'button');
check('the default button is secondary, medium', plain.includes('gtd-btn--secondary') && plain.includes('gtd-btn--md'));
const busy = html(<Button variant="primary" loading>Save</Button>);
check('a loading button is disabled, so a second click cannot submit twice', /disabled=""/.test(busy));
check('a loading button tells assistive technology it is busy', attr(busy, 'aria-busy') === 'true');
check('the spinner is hidden from screen readers', /class="gtd-spin"[^>]*aria-hidden="true"/.test(busy));
check('a submit button keeps its type', attr(html(<Button type="submit">Go</Button>), 'type') === 'submit');
check('extra attributes reach the element', attr(html(<Button form="f1">Go</Button>), 'form') === 'f1');

// ---- IconButton ----------------------------------------------------------
const icon = html(<IconButton label="Delete Q3 memo" icon={icons.trash} tone="danger" />);
check('an icon button has an accessible name', attr(icon, 'aria-label') === 'Delete Q3 memo');
check('an icon button shows its name as a tooltip', attr(icon, 'title') === 'Delete Q3 memo');
check('the icon itself is hidden from screen readers', icon.includes('aria-hidden="true"'));
check('the danger tone is a class, not an inline colour', icon.includes('gtd-icon-btn--danger') && !/style="[^"]*color/.test(icon));

// ---- Fields ---------------------------------------------------------------
const field = html(<Input id="name" label="Name" required value="" onChange={noop} error="Enter a name." />);
check('the label points at its input', attr(field, 'for') === 'name' && attr(field, 'id') === 'name');
check('a required field says so to assistive technology', attr(field, 'aria-required') === 'true');
check('the visible asterisk is not read out twice', /gtd-field__required" aria-hidden="true"/.test(field));
check('an invalid field is marked invalid', attr(field, 'aria-invalid') === 'true');
check('the error message is tied to the field', attr(field, 'aria-describedby') === 'name-error' && field.includes('id="name-error"'));
const hinted = html(<Textarea id="notes" label="Notes" hint="Markdown is supported." value="" onChange={noop} />);
check('a hint is tied to its field', attr(hinted, 'aria-describedby') === 'notes-hint' && hinted.includes('id="notes-hint"'));
check('a valid field is not marked invalid', !hinted.includes('aria-invalid'));
const optional = html(<Input label="Email" optional value="" onChange={noop} />);
check('an optional field is labelled as optional', optional.includes('(optional)'));
const select = html(<Select id="fmt" label="Format" value="PDF" onChange={noop} options={[{ value: 'PDF', label: 'PDF' }, { value: 'MD', label: 'MD' }]} />);
check('a select is labelled and keeps its value', attr(select, 'for') === 'fmt' && /<option value="PDF" selected="">/.test(select));
const grouped = html(<Select id="who" label="Who" value="" onChange={noop} options={[{ value: '', label: 'Not named' }, { value: 'a', label: 'Kim Park', group: 'Expected at this meeting' }, { value: 'b', label: 'Jo Lin', group: 'Expected at this meeting' }, { value: 'c', label: 'Sam Rot', group: 'Other stakeholders' }, { value: 'x', label: 'Someone else…' }]} />);
check('Select: options with a group sit under its heading, in order; others stand alone',
  /<option value="" selected="">Not named<\/option><optgroup label="Expected at this meeting"><option value="a">Kim Park<\/option><option value="b">Jo Lin<\/option><\/optgroup><optgroup label="Other stakeholders"><option value="c">Sam Rot<\/option><\/optgroup><option value="x">Someone else…<\/option>/.test(grouped), grouped);
const search = html(<SearchInput id="search-templates" value="" onChange={noop} placeholder="Search templates" />);
check('a search field exposes its id for a visible label', attr(search, 'id') === 'search-templates');
check('a search box is a search field named by its placeholder', attr(search, 'type') === 'search' && attr(search, 'aria-label') === 'Search templates');
const framed = html(<Field label="Due date" htmlFor="due"><input id="due" /></Field>);
check('Field labels any control', attr(framed, 'for') === 'due');
const row = html(<FieldRow label="Theme"><span>Dark</span></FieldRow>);
check('a field row uses the responsive row layout', row.includes('gtd-field-row'));

// ---- Notice --------------------------------------------------------------
const critical = html(<Notice tone="critical" title="Could not save.">The server did not answer.</Notice>);
check('a critical notice is announced at once', attr(critical, 'role') === 'alert');
check('other notices are announced politely', attr(html(<Notice tone="info">Tip</Notice>), 'role') === 'status');
check('a notice has an icon, so tone is not shown by colour alone', /gtd-notice__icon" aria-hidden="true"><svg/.test(critical));

// ---- Card, Page, Section ---------------------------------------------------
const card = html(<Card title="Workspace" description="Where your files live">Body</Card>);
check('a card title is an h2 by default', /<h2[^>]*class="gtd-card__title"/.test(card));
check('a nested card can use h3', /<h3/.test(html(<Card title="Inner" headingLevel={3}>x</Card>)));
check('a flush card is marked for edge-to-edge content', html(<Card title="List" padding="none">x</Card>).includes('gtd-card--flush'));
check('an empty card body is not rendered', !html(<Card title="Only a title" />).includes('gtd-card__body'));
const page = html(<Page width="narrow"><PageHeader description="About this page" actions={<Button>Act</Button>} /></Page>);
check('a page sets its width variant', page.includes('gtd-page--narrow'));
check('the page header never adds a second h1', !/<h1/.test(page));
check('a section heading is an h2 tied to its region', /aria-labelledby="runs-heading"/.test(html(<Section id="runs" title="Runs">x</Section>)) && /<h2 id="runs-heading"/.test(html(<Section id="runs" title="Runs">x</Section>)));

// ---- Tabs and segmented control ----------------------------------------
const tabs = html(<Tabs label="Board views" value="list" onChange={noop} items={[{ id: 'kanban', label: 'Kanban' }, { id: 'list', label: 'List', count: 3 }]} />);
check('tabs are a named tablist', attr(tabs, 'role') === 'tablist' && attr(tabs, 'aria-label') === 'Board views');
check('only the selected tab is selected', (tabs.match(/aria-selected="true"/g) ?? []).length === 1);
check('only the selected tab is in the Tab order (arrows move between tabs)', (tabs.match(/tabindex="0"/g) ?? []).length === 1 && (tabs.match(/tabindex="-1"/g) ?? []).length === 1);
const seg = html(<SegmentedControl label="Time window" value="30" onChange={noop} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />);
check('a segmented control is a named group of toggle buttons', attr(seg, 'role') === 'group' && (seg.match(/aria-pressed="true"/g) ?? []).length === 1);
check('a count badge shows its number', html(<CountBadge count={4} />).includes('>4<'));

// ---- States ----------------------------------------------------------------
const empty = html(<EmptyState title="No routines yet" description="Set one up." action={{ label: 'New routine', onClick: noop }} />);
check('an empty state offers the way forward', empty.includes('New routine') && empty.includes('gtd-btn--primary'));
check('an empty state without a title leaves no empty heading', !/<p[^>]*><\/p>/.test(html(<EmptyState description="Nothing here." />)));
const spinner = html(<LoadingSpinner />);
check('a loading state is announced, even without visible text', attr(spinner, 'role') === 'status' && spinner.includes('Loading…'));

console.log(failures ? `\n${failures} failure(s)` : '\nAll primitive checks passed');
process.exit(failures ? 1 : 0);
