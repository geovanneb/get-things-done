import { useState, useCallback, useMemo, useEffect } from 'react';
import Button from '@/components/common/Button';
import Input, { SearchInput, Select, Textarea } from '@/components/common/Input';
import Modal, { FormActions } from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import Page, { PageHeader } from '@/components/common/Page';
import Card, { CardGrid } from '@/components/common/Card';
import IconButton, { icons } from '@/components/common/IconButton';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useNotify } from '@/hooks/useNotify';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import AttachedFiles from '@/components/common/AttachedFiles';
import { apiGet, apiPost, apiPut, apiDelete } from '@/utils/api';
import { formatRelativeDate } from '@/utils/format';
import type { OutputTemplate } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Each format keeps its own hue; the theme supplies the lightness and chroma via
 * the --chip-* tokens, so the chips stay legible on a light or a dark surface.
 * MD has no hue of its own and reads as plain grey.
 */
const FORMAT_HUE: Record<string, number> = {
  PPTX: 55,
  DOCX: 250,
  PDF:  25,
  MD:   258,
  XLSX: 150,
  HTML: 310,
  TXT:  275,
};

const NEUTRAL_CHIP_HUE = 258;

function formatBadgeStyle(format: string): React.CSSProperties {
  const hue = FORMAT_HUE[format.toUpperCase()] ?? NEUTRAL_CHIP_HUE;
  const neutral = hue === NEUTRAL_CHIP_HUE;
  const bgChroma = neutral ? 'calc(var(--chip-bg-c) * 0.15)' : 'var(--chip-bg-c)';
  const fgChroma = neutral ? 'calc(var(--chip-fg-c) * 0.10)' : 'var(--chip-fg-c)';
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.04em',
    backgroundColor: `oklch(var(--chip-bg-l) ${bgChroma} ${hue})`,
    color: `oklch(var(--chip-fg-l) ${fgChroma} ${hue})`,
    lineHeight: 1.6, whiteSpace: 'nowrap' as const,
  };
}

const FORMATS = ['PPTX', 'DOCX', 'PDF', 'MD', 'XLSX', 'HTML', 'TXT'];

// ---------------------------------------------------------------------------
// Template modal
// ---------------------------------------------------------------------------

interface TemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  initial: Partial<OutputTemplate> | null;
  mode: 'create' | 'edit';
  onSaved: (template: OutputTemplate) => void;
}

function TemplateModal({ isOpen, onClose, initial, mode, onSaved }: TemplateModalProps) {
  const [name, setName] = useState('');
  const [format, setFormat] = useState('DOCX');
  const [description, setDescription] = useState('');
  const [styleGuide, setStyleGuide] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(initial?.name ?? '');
      setFormat(initial?.format ?? 'DOCX');
      setDescription(initial?.description ?? '');
      setStyleGuide(initial?.style_guide ?? '');
      setError(null);
    }
  }, [isOpen, initial]);

  const handleSave = async () => {
    if (!name.trim()) { setError('The template needs a name.'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), format, description, style_guide: styleGuide };
      let saved: OutputTemplate;
      if (mode === 'edit' && initial?.id) {
        saved = await apiPut<OutputTemplate>(`/api/outputs/templates/${initial.id}`, payload);
      } else {
        saved = await apiPost<OutputTemplate>('/api/outputs/templates', payload);
      }
      onSaved(saved);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the template. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'create' ? 'New output template' : 'Edit output template'}
      size="xl"
      keepWhileTyping
      footer={
        <FormActions>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {mode === 'create' ? 'Create template' : 'Save changes'}
          </Button>
        </FormActions>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {error && <Notice tone="critical">{error}</Notice>}
        <Input label="Name" required value={name} onChange={setName} placeholder="Executive memo" autoFocus
          error={error && !name.trim() ? 'Give the template a name.' : undefined} />
        <Select label="Format" value={format} onChange={setFormat} options={FORMATS.map((f) => ({ value: f, label: f }))} />
        <Textarea label="Description" value={description} onChange={setDescription} rows={3}
          placeholder="What this template is for, in one sentence" />
        <Textarea label="Style guide" value={styleGuide} onChange={setStyleGuide} rows={8} mono
          placeholder="Required sections, structure, tone and formatting rules"
          hint="Agents follow this when they write a deliverable in this template." />
        {mode === 'edit' && initial?.id && (
          <AttachedFiles baseUrl={`/api/outputs/templates/${initial.id}/files`} archiveUrl={`/api/outputs/templates/${initial.id}/archive`} label="Files" />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Template card
// ---------------------------------------------------------------------------

interface TemplateCardProps {
  template: OutputTemplate;
  onClick: () => void;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}

function TemplateCard({ template, onClick, onEdit, onDelete }: TemplateCardProps) {
  return (
    <Card as="article" padding="compact" onClick={onClick}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }} onClick={(e) => e.stopPropagation()}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {template.updated_at && <>Updated {formatRelativeDate(template.updated_at)}</>}
          </span>
          <div style={{ display: 'flex', gap: 2 }}>
            <IconButton label={`Edit ${template.name}`} icon={icons.edit} onClick={onEdit} />
            <IconButton label={`Delete ${template.name}`} icon={icons.trash} tone="danger" onClick={onDelete} />
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 600, lineHeight: 'var(--leading-tight)', minWidth: 0, overflowWrap: 'anywhere' }}>
            {/* The title is the keyboard way in; the whole card is the mouse target. */}
            <button type="button" onClick={(e) => { e.stopPropagation(); onClick(); }}
              style={{ textAlign: 'left', fontWeight: 'inherit', color: 'var(--color-text)' }}>
              {template.name}
            </button>
          </h2>
          <span style={formatBadgeStyle(template.format)}>{template.format}</span>
        </div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-normal)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as React.CSSProperties}>
          {template.description || 'No description.'}
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function OutputsView() {
  const [templates, setTemplates] = useState<OutputTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [selectedTemplate, setSelectedTemplate] = useState<OutputTemplate | null>(null);

  useEffect(() => {
    apiGet<OutputTemplate[]>('/api/outputs/templates')
      .then((data) => { setTemplates(data); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q) || t.format.toLowerCase().includes(q));
  }, [templates, search]);

  const openCreate = () => { setSelectedTemplate(null); setModalMode('create'); setIsModalOpen(true); };
  const openEdit = useCallback((template: OutputTemplate, e: React.MouseEvent) => { e.stopPropagation(); setSelectedTemplate(template); setModalMode('edit'); setIsModalOpen(true); }, []);
  const openView = useCallback((template: OutputTemplate) => { setSelectedTemplate(template); setModalMode('edit'); setIsModalOpen(true); }, []);

  const confirm = useConfirm();
  const notify = useNotify();
  const handleDelete = useCallback(async (template: OutputTemplate, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirm({
      title: `Delete "${template.name}"?`,
      message: 'The template and its files are deleted. Tasks that used it keep their deliverables. This cannot be undone.',
      confirmLabel: 'Delete template',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/outputs/templates/${template.id}`);
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
      notify.success(`Deleted "${template.name}".`);
    } catch (err: unknown) {
      notify.error(err, 'Could not delete the template. Try again.');
    }
  }, [confirm, notify]);

  const handleSaved = useCallback((saved: OutputTemplate) => {
    setTemplates((prev) => {
      const idx = prev.findIndex((t) => t.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [saved, ...prev];
    });
    setIsModalOpen(false);
    setSelectedTemplate(null);
  }, []);

  if (loading) return <LoadingSpinner text="Loading output templates…" />;

  return (
    <Page width="default">
      <PageHeader
        description="The formats your deliverables come in. Agents follow a template's style guide when they write."
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search templates" />
            <Button variant="primary" icon={icons.plus} onClick={openCreate}>New template</Button>
          </>
        }
      />

      {error && <Notice tone="critical" title="Could not load the templates.">{error}</Notice>}

      {filtered.length === 0 && !error && (
        <EmptyState
          title={search ? 'No templates match your search' : 'No templates yet'}
          description={search ? 'Try another word, or clear the search.' : 'A template sets the format and structure of a deliverable, such as a board deck or a one-page memo.'}
          action={search ? { label: 'Clear search', onClick: () => setSearch('') } : { label: 'New template', onClick: openCreate }}
        />
      )}

      {filtered.length > 0 && (
        <CardGrid>
          {filtered.map((template) => (
            <TemplateCard key={template.id} template={template}
              onClick={() => openView(template)}
              onEdit={(e) => openEdit(template, e)}
              onDelete={(e) => handleDelete(template, e)} />
          ))}
        </CardGrid>
      )}

      <TemplateModal isOpen={isModalOpen} onClose={() => { setIsModalOpen(false); setSelectedTemplate(null); }}
        initial={selectedTemplate} mode={modalMode} onSaved={handleSaved} />
    </Page>
  );
}
