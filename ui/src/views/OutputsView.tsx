import { useState, useCallback, useMemo, useEffect } from 'react';
import Button from '@/components/common/Button';
import Input from '@/components/common/Input';
import Modal from '@/components/common/Modal';
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
// Style constants
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  display: 'block', marginBottom: 6, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)',
};

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)',
  color: 'var(--color-text)', fontSize: 'var(--text-sm)', appearance: 'none', WebkitAppearance: 'none',
};

const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)',
  color: 'var(--color-text)', fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)',
  resize: 'vertical' as const, lineHeight: 1.5, boxSizing: 'border-box' as const,
};

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
    if (!name.trim()) { setError('Name is required.'); return; }
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
      setError(err instanceof Error ? err.message : 'Failed to save template.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={mode === 'create' ? 'New Output Template' : 'Edit Template'} size="xl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {error && (
          <div style={{ padding: '10px 14px', background: 'var(--color-critical-subtle)', color: 'var(--color-critical)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)' }}>
            {error}
          </div>
        )}

        <div>
          <label style={labelStyle}>Name</label>
          <Input value={name} onChange={setName} placeholder="Template name" />
        </div>

        <div>
          <label style={labelStyle}>Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value)} style={selectStyle}>
            {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            placeholder="Brief description of this template..." style={textareaStyle} />
        </div>

        <div>
          <label style={labelStyle}>Style Guide</label>
          <textarea value={styleGuide} onChange={(e) => setStyleGuide(e.target.value)} rows={8}
            placeholder="Formatting guidelines, required sections, deliverable structure, and style rules..."
            style={{ ...textareaStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }} />
        </div>

        {mode === 'edit' && initial?.id && (
          <AttachedFiles baseUrl={`/api/outputs/templates/${initial.id}/files`} label="Files" />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : mode === 'create' ? 'Create Template' : 'Save Changes'}
          </Button>
        </div>
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

function IconButton({ onClick, title, children }: { onClick: (e: React.MouseEvent) => void; title: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button title={title} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: hover ? 'var(--color-surface-hover)' : 'transparent', color: 'var(--color-text-secondary)', transition: 'background 0.1s', padding: 0 }}>
      {children}
    </button>
  );
}

function TemplateCard({ template, onClick, onEdit, onDelete }: TemplateCardProps) {
  const [hover, setHover] = useState(false);

  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', padding: 16, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', cursor: 'pointer', boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-sm)', transition: 'box-shadow 0.15s', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-md)', color: 'var(--color-text)', lineHeight: 1.3 }}>{template.name}</span>
        <span style={formatBadgeStyle(template.format)}>{template.format}</span>
      </div>

      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: 0, overflow: 'hidden', maxHeight: 'calc(1.5em * 2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as React.CSSProperties}>
        {template.description || 'No description.'}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, borderTop: '1px solid var(--color-border)', marginTop: 2 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {template.updated_at && <span>Updated {formatRelativeDate(template.updated_at)}</span>}
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <IconButton title="Edit template" onClick={onEdit}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.5 2.5L11.5 4.5L5.5 10.5H3.5V8.5L9.5 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IconButton>
          <IconButton title="Delete template" onClick={onDelete}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5h4V4M5.5 6.5v4M8.5 6.5v4M3 4l.8 7.5h6.4L11 4" stroke="var(--color-critical)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IconButton>
        </div>
      </div>
    </div>
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

  const handleDelete = useCallback(async (template: OutputTemplate, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete template "${template.name}"? This cannot be undone.`)) return;
    try {
      await apiDelete(`/api/outputs/templates/${template.id}`);
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete template.');
    }
  }, []);

  const handleSaved = useCallback((saved: OutputTemplate) => {
    setTemplates((prev) => {
      const idx = prev.findIndex((t) => t.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [saved, ...prev];
    });
    setIsModalOpen(false);
    setSelectedTemplate(null);
  }, []);

  if (loading) return <LoadingSpinner text="Loading output templates..." />;

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, margin: 0, color: 'var(--color-text)' }}>Output Templates</h1>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 24, height: 24, padding: '0 7px', borderRadius: 99, background: 'var(--color-accent-subtle)', color: 'var(--color-accent)', fontSize: 'var(--text-xs)', fontWeight: 600 }}>
            {templates.length}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Input value={search} onChange={(v) => setSearch(v)} placeholder="Search templates..." style={{ width: 220 }} />
          <Button variant="primary" onClick={openCreate}>+ New Template</Button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', marginBottom: 20, background: 'var(--color-critical-subtle)', color: 'var(--color-critical)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)' }}>{error}</div>
      )}

      {filtered.length === 0 && !loading && (
        <EmptyState
          title={search ? 'No templates match your search' : 'No templates yet'}
          description={search ? 'Try a different search term.' : 'Create your first output template to define formats and structures for deliverables.'}
        />
      )}

      {filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {filtered.map((template) => (
            <TemplateCard key={template.id} template={template}
              onClick={() => openView(template)}
              onEdit={(e) => openEdit(template, e)}
              onDelete={(e) => handleDelete(template, e)} />
          ))}
        </div>
      )}

      <TemplateModal isOpen={isModalOpen} onClose={() => { setIsModalOpen(false); setSelectedTemplate(null); }}
        initial={selectedTemplate} mode={modalMode} onSaved={handleSaved} />
    </div>
  );
}
