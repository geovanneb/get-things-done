import { useState, useCallback, useMemo, useEffect } from 'react';
import Button from '@/components/common/Button';
import Input from '@/components/common/Input';
import Modal from '@/components/common/Modal';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import AttachedFiles from '@/components/common/AttachedFiles';
import MarkdownEditor from '@/components/common/MarkdownEditor';
import { apiGet, apiPost, apiPut, apiDelete } from '@/utils/api';
import { formatRelativeDate } from '@/utils/format';
import type { ContextNote } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  'Company',
  'Organization',
  'Strategy',
  'Programs',
  'Decisions',
  'Risks',
  'Glossary',
  'Situation',
] as const;

type Category = (typeof CATEGORIES)[number] | 'All';

const RELEVANCE_OPTIONS = ['required', 'recommended', 'optional'] as const;
type Relevance = (typeof RELEVANCE_OPTIONS)[number];

const RELEVANCE_BADGE: Record<Relevance, { bg: string; color: string }> = {
  required:    { bg: 'var(--color-critical-subtle)', color: 'var(--color-critical)' },
  recommended: { bg: 'var(--color-warning-subtle)',  color: 'var(--color-warning)'  },
  optional:    { bg: 'var(--color-info-subtle)',     color: 'var(--color-info)'     },
};

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
// Icon button
// ---------------------------------------------------------------------------

function IconButton({ onClick, title, children }: { onClick: (e: React.MouseEvent) => void; title: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button title={title} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: hover ? 'var(--color-surface-hover)' : 'transparent', color: 'var(--color-text-secondary)', transition: 'background 0.1s', padding: 0, flexShrink: 0 }}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Note modal
// ---------------------------------------------------------------------------

interface NoteFormState {
  title: string;
  category: string;
  relevance: string;
  body: string;
}

function noteToForm(note: Partial<ContextNote>): NoteFormState {
  return {
    title: note.title ?? '',
    category: note.category ? note.category.charAt(0).toUpperCase() + note.category.slice(1) : 'Company',
    relevance: note.relevance ?? 'recommended',
    body: note.body ?? '',
  };
}

interface NoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  initial: ContextNote | null;
  mode: 'create' | 'edit';
  onSaved: (note: ContextNote) => void;
}

function NoteModal({ isOpen, onClose, initial, mode, onSaved }: NoteModalProps) {
  const [form, setForm] = useState<NoteFormState>(() => noteToForm(initial ?? {}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<ContextNote | null>(null);

  const effectiveMode = savedNote ? 'edit' : mode;
  const effectiveNote = savedNote ?? initial;

  useEffect(() => {
    if (isOpen) { setForm(noteToForm(initial ?? {})); setError(null); setSavedNote(null); }
  }, [isOpen, initial]);

  const set = <K extends keyof NoteFormState>(key: K, value: NoteFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSave = async () => {
    if (!form.title.trim()) { setError('Title is required.'); return; }
    setSaving(true);
    setError(null);
    const payload = {
      title: form.title.trim(),
      category: form.category,
      relevance: form.relevance,
      tags: [],
      body: form.body,
    };
    try {
      let saved: ContextNote;
      if (effectiveMode === 'edit' && effectiveNote?.id) {
        saved = await apiPut<ContextNote>(`/api/context/${effectiveNote.id}`, payload);
      } else {
        saved = await apiPost<ContextNote>('/api/context', payload);
        setSavedNote(saved);
      }
      onSaved(saved);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save note.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={effectiveMode === 'create' ? 'New Context Note' : 'Edit Context Note'} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error && (
          <div style={{ padding: '10px 14px', background: 'var(--color-critical-subtle)', color: 'var(--color-critical)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)' }}>
            {error}
          </div>
        )}

        <div>
          <label style={labelStyle}>Title <span style={{ color: 'var(--color-critical)' }}>*</span></label>
          <Input value={form.title} onChange={(v) => set('title', v)} placeholder="Note title" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelStyle}>Category</label>
            <select value={form.category} onChange={(e) => set('category', e.target.value)} style={selectStyle}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Relevance</label>
            <select value={form.relevance} onChange={(e) => set('relevance', e.target.value)} style={selectStyle}>
              {RELEVANCE_OPTIONS.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={labelStyle}>Content (Markdown)</label>
          <MarkdownEditor value={form.body} onChange={(v) => set('body', v)} rows={8}
            placeholder="Write context note content in Markdown..." textareaStyle={textareaStyle} />
        </div>

        {effectiveNote?.id && (
          <AttachedFiles baseUrl={`/api/context/${effectiveNote.id}/files`} label="Attached Files" />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : effectiveMode === 'create' ? 'Create Note' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Note card
// ---------------------------------------------------------------------------

interface NoteCardProps {
  note: ContextNote;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onTitleClick: () => void;
}

function NoteCard({ note, onEdit, onDelete, onTitleClick }: NoteCardProps) {
  const relevanceStyle = RELEVANCE_BADGE[note.relevance as Relevance] ?? RELEVANCE_BADGE.optional;
  const preview = note.body ? note.body.slice(0, 120).trimEnd() + (note.body.length > 120 ? '...' : '') : null;

  return (
    <div style={{ padding: 16, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <button onClick={onTitleClick}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, fontSize: 'var(--text-base)', color: 'var(--color-text)', textAlign: 'left', lineHeight: 1.3, flex: 1 }}>
          {note.title}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ ...relevanceStyle, padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>
            {note.relevance}
          </span>
          <IconButton title="Edit note" onClick={onEdit}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.5 2.5L11.5 4.5L5.5 10.5H3.5V8.5L9.5 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IconButton>
          <IconButton title="Delete note" onClick={onDelete}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5h4V4M5.5 6.5v4M8.5 6.5v4M3 4l.8 7.5h6.4L11 4" stroke="var(--color-critical)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IconButton>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <span style={{ padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', fontWeight: 500, background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}>
          {note.category.charAt(0).toUpperCase() + note.category.slice(1)}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
        <span>Updated {formatRelativeDate(note.updated_at)}</span>
        <span>Created {formatRelativeDate(note.created_at)}</span>
      </div>

      {preview && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', fontStyle: 'italic', margin: 0, lineHeight: 1.5 }}>
          {preview}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left sidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  notes: ContextNote[];
  activeCategory: Category;
  onSelect: (cat: Category) => void;
}

function Sidebar({ notes, activeCategory, onSelect }: SidebarProps) {
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const note of notes) {
      const key = note.category.toLowerCase();
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [notes]);

  const items: Category[] = ['All', ...CATEGORIES];

  return (
    <div style={{ width: 220, flexShrink: 0, background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 16px 10px', fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
        Context
      </div>
      <nav style={{ flex: 1 }}>
        {items.map((cat) => {
          const isActive = activeCategory === cat;
          const count = cat === 'All' ? notes.length : (counts[cat.toLowerCase()] ?? 0);
          return (
            <button key={cat} onClick={() => onSelect(cat)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '8px 16px', border: 'none', background: isActive ? 'var(--color-accent-subtle)' : 'transparent', color: isActive ? 'var(--color-accent)' : 'var(--color-text)', fontWeight: isActive ? 600 : 400, fontSize: 'var(--text-sm)', cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s' }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-surface-hover)'; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}>
              <span>{cat}</span>
              {count > 0 && (
                <span style={{ minWidth: 20, height: 20, padding: '0 5px', borderRadius: 99, background: isActive ? 'var(--color-accent)' : 'var(--color-surface-hover)', color: isActive ? 'var(--color-text-on-accent)' : 'var(--color-text-muted)', fontSize: 'var(--text-xs)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function ContextView() {
  const [notes, setNotes] = useState<ContextNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>('All');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [selectedNote, setSelectedNote] = useState<ContextNote | null>(null);

  useEffect(() => {
    apiGet<ContextNote[]>('/api/context')
      .then((data) => { setNotes(data); setLoading(false); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Failed to load notes.'); setLoading(false); });
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes.filter((n) => {
      const matchCat = activeCategory === 'All' || n.category.toLowerCase() === activeCategory.toLowerCase();
      const matchSearch = !q || n.title.toLowerCase().includes(q) || (n.body ?? '').toLowerCase().includes(q);
      return matchCat && matchSearch;
    });
  }, [notes, activeCategory, search]);

  const openCreate = () => {
    const defaultCategory = activeCategory === 'All' ? 'Company' : activeCategory;
    setSelectedNote({ category: defaultCategory } as ContextNote);
    setModalMode('create');
    setIsModalOpen(true);
  };

  const openEdit = useCallback((note: ContextNote, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedNote(note);
    setModalMode('edit');
    setIsModalOpen(true);
  }, []);

  const handleDelete = useCallback(async (note: ContextNote, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete note "${note.title}"? This cannot be undone.`)) return;
    try {
      await apiDelete(`/api/context/${note.id}`);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete note.');
    }
  }, []);

  const handleSaved = useCallback((saved: ContextNote) => {
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [saved, ...prev];
    });
    setIsModalOpen(false);
    setSelectedNote(null);
  }, []);

  if (loading) return <LoadingSpinner text="Loading context notes..." />;

  const categoryTitle = activeCategory === 'All' ? 'All Notes' : activeCategory;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Sidebar notes={notes} activeCategory={activeCategory} onSelect={(cat) => { setActiveCategory(cat); setSearch(''); }} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid var(--color-border)', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, margin: 0, color: 'var(--color-text)' }}>{categoryTitle}</h1>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 6px', borderRadius: 99, background: 'var(--color-accent-subtle)', color: 'var(--color-accent)', fontSize: 'var(--text-xs)', fontWeight: 600 }}>
              {filtered.length}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Input value={search} onChange={(v) => setSearch(v)} placeholder="Search notes..." style={{ width: 200 }} />
            <Button variant="primary" onClick={openCreate}>+ New Note</Button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {error && (
            <div style={{ padding: '10px 14px', marginBottom: 16, background: 'var(--color-critical-subtle)', color: 'var(--color-critical)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)' }}>
              {error}
            </div>
          )}

          {filtered.length === 0 && (
            <EmptyState
              title={search ? 'No notes match your search' : `No notes in ${categoryTitle}`}
              description={search ? 'Try a different search term.' : 'Add context notes to capture important background information.'}
            />
          )}

          {filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {filtered.map((note) => (
                <NoteCard key={note.id} note={note}
                  onTitleClick={() => openEdit(note)}
                  onEdit={(e) => openEdit(note, e)}
                  onDelete={(e) => handleDelete(note, e)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <NoteModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)}
        initial={selectedNote} mode={modalMode} onSaved={handleSaved} />
    </div>
  );
}
