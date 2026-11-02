import { useState } from 'react';
import Button from '@/components/common/Button';
import IconButton, { icons } from '@/components/common/IconButton';
import Input, { Checkbox, Field, FieldRow, FormSection, SearchInput, Select, Textarea } from '@/components/common/Input';
import Notice from '@/components/common/Notice';
import Card, { CardGrid } from '@/components/common/Card';
import Page, { PageHeader, Section } from '@/components/common/Page';
import Modal, { FormActions } from '@/components/common/Modal';
import { CountBadge, SegmentedControl, Tabs } from '@/components/common/Tabs';
import Badge from '@/components/common/Badge';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Toggle from '@/components/common/Toggle';
import Avatar from '@/components/common/Avatar';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useNotify } from '@/hooks/useNotify';

/**
 * The component showcase: every shared primitive with its variants and states, on one page.
 * Open it at /design-system (not in the sidebar). The visual checks screenshot it, so a change
 * to a shared component shows up here first. See docs/design-system.md.
 */
const COLOR_TOKENS = [
  'bg', 'surface', 'surface-hover', 'surface-active', 'border', 'border-strong',
  'text', 'text-secondary', 'text-muted', 'accent', 'accent-subtle',
  'critical', 'critical-subtle', 'warning', 'warning-subtle', 'success', 'success-subtle', 'info', 'info-subtle',
];
const TEXT_TOKENS = ['xs', 'sm', 'base', 'md', 'lg', 'xl'];
const SPACE_TOKENS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

function Swatch({ name }: { name: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
      <span aria-hidden="true" style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: `var(--color-${name})` }} />
      <code className="mono truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>--color-{name}</code>
    </div>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>{children}</div>
);

export default function DesignSystemView() {
  const [tab, setTab] = useState<'one' | 'two' | 'three'>('one');
  const [range, setRange] = useState<'7' | '30' | '90'>('30');
  const [text, setText] = useState('');
  const [toggle, setToggle] = useState(true);
  const [modal, setModal] = useState<null | 'sm' | 'md' | 'lg'>(null);
  const confirm = useConfirm();
  const notify = useNotify();

  return (
    <Page width="default">
      <PageHeader
        description="Every shared component with its variants and states. Change a shared standard here first, then check the pages that use it."
        actions={<Button variant="primary" icon={icons.plus} onClick={() => notify.success('This is a toast.')}>Primary action</Button>}
      />

      <Section id="ds-colors" title="Colour tokens" description="Semantic names; each theme redefines the values. Status colours always come with an icon or a word.">
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
            {COLOR_TOKENS.map((t) => <Swatch key={t} name={t} />)}
          </div>
        </Card>
      </Section>

      <Section id="ds-type" title="Type and spacing">
        <CardGrid>
          <Card title="Type scale" description="--text-*, scaled by the text-size preference">
            <div className="gtd-stack" style={{ gap: 'var(--space-2)' }}>
              {TEXT_TOKENS.map((t) => (
                <div key={t} style={{ fontSize: `var(--text-${t})`, fontWeight: t === 'xl' || t === 'lg' ? 600 : 400 }} className="truncate">
                  --text-{t} · Board update: Q3 operations review
                </div>
              ))}
            </div>
          </Card>
          <Card title="Spacing scale" description="--space-*, a 4px scale">
            <div className="gtd-stack" style={{ gap: 'var(--space-2)' }}>
              {SPACE_TOKENS.map((n) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <code className="mono" style={{ width: 80, fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>--space-{n}</code>
                  <span aria-hidden="true" style={{ height: 8, width: `var(--space-${n})`, background: 'var(--color-accent)', borderRadius: 'var(--radius-sm)' }} />
                </div>
              ))}
            </div>
          </Card>
        </CardGrid>
      </Section>

      <Section id="ds-buttons" title="Buttons" description="One primary action per group. Secondary for other actions, ghost for low emphasis and Cancel, danger for destructive actions.">
        <Card>
          <div className="gtd-stack">
            <Row>
              <Button variant="primary">Primary</Button>
              <Button>Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Delete</Button>
            </Row>
            <Row>
              <Button size="sm" variant="primary">Small</Button>
              <Button size="md" variant="primary">Medium</Button>
              <Button size="lg" variant="primary">Large</Button>
              <Button variant="primary" icon={icons.plus}>With icon</Button>
            </Row>
            <Row>
              <Button variant="primary" loading>Saving</Button>
              <Button disabled>Disabled</Button>
              <IconButton label="Edit" icon={icons.edit} />
              <IconButton label="Delete" icon={icons.trash} tone="danger" />
              <IconButton label="Copy" icon={icons.copy} outline />
              <IconButton label="Close" icon={icons.close} size="md" />
            </Row>
          </div>
        </Card>
      </Section>

      <Section id="ds-forms" title="Forms" description="Visible labels, a marker for required fields, a hint or an error under the field.">
        <Card footer={<FormActions><Button variant="ghost">Cancel</Button><Button variant="primary">Save changes</Button></FormActions>}>
          <div className="gtd-form-grid">
            <Input label="Name" required value={text} onChange={setText} placeholder="Jane Smith" />
            <Input label="Email" optional type="email" value="" onChange={() => {}} placeholder="jane@example.com" />
            <Input label="With an error" value="" onChange={() => {}} error="Enter a name." />
            <Select label="Format" value="PDF" onChange={() => {}} hint="The file agents produce." options={[{ value: 'PDF', label: 'PDF' }, { value: 'DOCX', label: 'DOCX' }]} />
            <Input label="Disabled" value="Read only" onChange={() => {}} disabled />
            <Field label="Search">
              <SearchInput value="" onChange={() => {}} placeholder="Search templates" width="100%" />
            </Field>
            <Textarea label="Notes" hint="Markdown is supported." value="" onChange={() => {}} style={{ gridColumn: '1 / -1' }} />
          </div>
          <div className="gtd-stack" style={{ marginTop: 'var(--space-5)' }}>
            <FormSection title="A group of fields" description="FormSection: a heading for part of a longer form, ruled off from the group before it.">
              <Checkbox checked={toggle} onChange={setToggle} label="Clean up the voice" description="A checkbox with a line of explanation. The whole row is the target." />
              <div className="gtd-consent"><Checkbox checked={!toggle} onChange={(v) => setToggle(!v)} label="I have told everyone in the meeting that it is being recorded." /></div>
            </FormSection>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <FieldRow label="Field row"><span>Label beside the value; stacked on a phone.</span></FieldRow>
            <FieldRow label="Toggle"><Toggle label="Example toggle" checked={toggle} onChange={setToggle} /></FieldRow>
          </div>
        </Card>
      </Section>

      <Section id="ds-nav" title="Tabs, segmented controls, badges">
        <Card>
          <div className="gtd-stack">
            <Tabs label="Example views" value={tab} onChange={setTab} items={[{ id: 'one', label: 'Kanban' }, { id: 'two', label: 'List', count: 12 }, { id: 'three', label: 'Archive' }]} />
            <Row>
              <SegmentedControl label="Time window" value={range} onChange={setRange}
                options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
              <CountBadge count={4} />
              <CountBadge count={2} tone="warning" />
              <CountBadge count={5} tone="critical" />
            </Row>
            <Row>
              <Badge variant="priority-critical">Critical</Badge>
              <Badge variant="priority-high">High</Badge>
              <Badge variant="priority-medium">Medium</Badge>
              <Badge variant="status-in_progress">In Progress</Badge>
              <Badge variant="status-done">Done</Badge>
              <Badge variant="success">Installed</Badge>
              <Avatar name="Priya Natarajan" />
              <Avatar name="Marcus Webb" size="lg" />
            </Row>
          </div>
        </Card>
      </Section>

      <Section id="ds-cards" title="Cards and lists" description="Card padding md for content, compact for repeated cards, none for lists and tables.">
        <CardGrid>
          <Card title="Card with actions" description="A one-line description" actions={<IconButton label="Edit" icon={icons.edit} />}>
            Content uses the card's own spacing.
          </Card>
          <Card padding="compact" footer={<span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Updated today</span>}>
            A compact card in a grid, with a footer.
          </Card>
          <Card title="A very long card title that has to wrap onto a second line without pushing the actions out" actions={<Button size="sm">Act</Button>}>
            Long titles wrap.
          </Card>
        </CardGrid>
        <Card title="List" padding="none" badge={<CountBadge count={2} />} description="Rows with dividers inside a card (gtd-list)">
          <ul className="gtd-list">
            <li className="gtd-list__row" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>2026-10-31</span>
              <span style={{ flex: 1, fontWeight: 500 }}>Q4 board prep</span>
              <Badge size="sm" variant="muted">1 file</Badge>
              <IconButton label="Remove Q4 board prep" icon={icons.close} tone="danger" />
            </li>
            <li className="gtd-list__row" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>2026-10-30</span>
              <span style={{ flex: 1, fontWeight: 500 }}>Weekly logistics sync</span>
              {/* design-exception: shows the gtd-chip__action pattern itself, which is a styled native button */}
              <span className="gtd-chip">Speaker 1: Daniel Okafor<button type="button" className="gtd-chip__action">Change</button></span>
            </li>
          </ul>
        </Card>
        <Card title="Reading box" description="Running text read in place, such as a transcript (gtd-reading-box)">
          <div className="gtd-reading-box" tabIndex={0} aria-label="Example transcript">
            <p><span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 'var(--space-2)' }}>00:01</span>Carrier volumes are up nine percent.</p>
            <p><span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 'var(--space-2)' }}>00:05</span>Agreed, let us write it down.</p>
          </div>
          <p style={{ margin: 'var(--space-3) 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>With its recording: a time plays from there, and the turn being heard is marked.</p>
          <div className="gtd-reading-box" tabIndex={0} aria-label="Example transcript with its recording">
            <p><Button size="sm" variant="ghost" className="gtd-reading-box__time" aria-label="Play from 00:01">00:01</Button>Carrier volumes are up nine percent.</p>
            <p className="gtd-reading-box__heard" aria-current="time"><Button size="sm" variant="ghost" className="gtd-reading-box__time" aria-label="Play from 00:05">00:05</Button>Agreed, let us write it down.</p>
          </div>
        </Card>
        <Card title="Table" padding="none" badge={<CountBadge count={2} />}>
          <div className="gtd-table-wrap">
            <table className="gtd-table">
              <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                <tr><td><span className="gtd-link-strong">Daniel Okafor</span></td><td>Head of Logistics</td><td style={{ textAlign: 'right' }}><IconButton label="Edit Daniel Okafor" icon={icons.edit} /></td></tr>
                <tr><td><span className="gtd-link-strong">Hana Sato</span></td><td>Board Member</td><td style={{ textAlign: 'right' }}><IconButton label="Edit Hana Sato" icon={icons.edit} /></td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      </Section>

      <Section id="ds-states" title="States" description="Loading, empty, error, warning, success and info.">
        <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
          <Notice tone="critical" title="Could not save the note." action={<Button size="sm">Try again</Button>}>The server did not answer.</Notice>
          <Notice tone="warning" title="This folder is not a workspace yet.">Initialize it to create the structure.</Notice>
          <Notice tone="success">Saved.</Notice>
          <Notice tone="info">Required notes are read before every task.</Notice>
          <CardGrid>
            <Card><LoadingSpinner text="Loading routines…" /></Card>
            <Card><EmptyState size="compact" title="No routines yet" description="Set up a task once and let it come back on schedule." action={{ label: 'New routine', onClick: () => {} }} /></Card>
          </CardGrid>
        </div>
      </Section>

      <Section id="ds-dialogs" title="Dialogs" description="sm for confirmations, md for short forms, lg for longer forms, xl for editors.">
        <Card>
          <Row>
            <Button onClick={() => setModal('sm')}>Small dialog</Button>
            <Button onClick={() => setModal('md')}>Form dialog</Button>
            <Button onClick={() => setModal('lg')}>Large dialog</Button>
            <Button variant="danger" onClick={() => void confirm({ title: 'Delete "Q3 memo"?', message: 'The template and its files are deleted. This cannot be undone.', confirmLabel: 'Delete template', tone: 'danger' })}>
              Destructive confirmation
            </Button>
          </Row>
        </Card>
      </Section>

      <Modal isOpen={modal !== null} size={modal ?? 'md'} onClose={() => setModal(null)} title="New context note" description="A dialog with a title, a body that scrolls and a footer that stays."
        keepWhileTyping
        footer={<FormActions><Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" onClick={() => setModal(null)}>Create note</Button></FormActions>}>
        <div className="gtd-stack">
          <Input label="Title" required value="" onChange={() => {}} autoFocus />
          <Textarea label="Content" value="" onChange={() => {}} rows={6} />
        </div>
      </Modal>
    </Page>
  );
}
