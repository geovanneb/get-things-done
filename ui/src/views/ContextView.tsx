import { SENSITIVITY_OPTIONS, UNKNOWN_SENSITIVITY, sensitivityFormValue, sensitivityPatch, sensitivityState } from '@/utils/contextSensitivity';
import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Button from '@/components/common/Button';
import Input, { Field, SearchInput, Select } from '@/components/common/Input';
import Modal, { FormActions } from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import Card from '@/components/common/Card';
import IconButton, { icons } from '@/components/common/IconButton';
import { CountBadge } from '@/components/common/Tabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useNotify } from '@/hooks/useNotify';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import AttachedFiles from '@/components/common/AttachedFiles';
import MarkdownEditor from '@/components/common/MarkdownEditor';
import { apiGet, apiPost, apiPut, apiDelete } from '@/utils/api';
import { formatRelativeDate } from '@/utils/format';
import { useApi } from '@/hooks/useApi';
import { useAppDispatch, useDataVersion } from '@/store';
import ImportUpdateModal from '@/components/context-updates/ImportUpdateModal';
import ShareNotes from '@/components/context/ShareNotes';
import UpdatesList from '@/components/context-updates/UpdatesList';
import UpdateDetail from '@/components/context-updates/UpdateDetail';
import { filterUpdates, HISTORY_PAGE, waitingCounts, waitingLabel, type TypeFilter } from '@/utils/updateTypes';
import type { ContextCategoryInfo, ContextNote, ContextUpdate, QueuedMeeting } from '@/types';
import CategoryModal from '@/components/context/CategoryModal';
import { BUILTIN_CATEGORIES, categoryLabel as labelOf } from '@/utils/contextCategories';
import DictateButton from '@/components/common/DictateButton';
import { withDictation } from '@/utils/dictation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A label from a fixed table; a hand-written value such as `__proto__` is never looked up on the object's prototype. */
const lookup = (table: Record<string, string>, key: unknown): string | undefined =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** A category id (stored in each note's file, so translated at display time), or `all` for every note. */
type Category = string;
const ALL = 'all';

const RELEVANCE_OPTIONS = ['required', 'recommended', 'optional'] as const;
type Relevance = (typeof RELEVANCE_OPTIONS)[number];
const relevanceLabel = (relevance: string): string => lookup({ required: tr('context.relevanceRequired'), recommended: tr('context.relevanceRecommended'), optional: tr('context.relevanceOptional') }, relevance) ?? String(relevance);

const RELEVANCE_BADGE: Record<Relevance, { bg: string; color: string }> = {
  required:    { bg: 'var(--color-critical-subtle)', color: 'var(--color-critical)' },
  recommended: { bg: 'var(--color-warning-subtle)',  color: 'var(--color-warning)'  },
  optional:    { bg: 'var(--color-info-subtle)',     color: 'var(--color-info)'     },
};

/**
 * The category choices of a note: built-in ones first, then the workspace's own, under headings once there are any.
 * A category this list does not have stays as the current choice, so saving the note does not move it.
 */
function categoryOptions(categories: readonly ContextCategoryInfo[], current: string, builtinGroup: string, customGroup: string) {
  const grouped = categories.some((c) => !c.builtin);
  const options = categories.map((c) => ({ value: c.id, label: labelOf(c.id, categories), ...(grouped ? { group: c.builtin ? builtinGroup : customGroup } : {}) }));
  return current && !categories.some((c) => c.id === current) ? [{ value: current, label: current }, ...options] : options;
}

const sensitivityLabel = (value: unknown): string => lookup({
  shareable: tr('context.sensitivityShareable'), internal: tr('context.sensitivityInternal'), personal: tr('context.sensitivityPersonal'),
}, value) ?? tr('context.sensitivityInvalid');

// ---------------------------------------------------------------------------
// Note modal
// ---------------------------------------------------------------------------

interface NoteFormState {
  title: string;
  category: string;
  relevance: string;
  /** '' = not set (counts as internal). */
  sensitivity: string;
  body: string;
}

function noteToForm(note: Partial<ContextNote>): NoteFormState {
  return {
    title: note.title ?? '',
    // Ids are lowercase; older notes and dashboards may say "Company".
    category: note.category ? note.category.toLowerCase() : 'company',
    relevance: note.relevance ?? 'recommended',
    sensitivity: sensitivityFormValue(note.sensitivity),
    body: note.body ?? '',
  };
}

interface NoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  initial: ContextNote | null;
  mode: 'create' | 'edit';
  onSaved: (note: ContextNote) => void;
  categories: readonly ContextCategoryInfo[];
}

function NoteModal({ isOpen, onClose, initial, mode, onSaved, categories }: NoteModalProps) {
  const { t } = useLanguage();
  const [form, setForm] = useState<NoteFormState>(() => noteToForm(initial ?? {}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<ContextNote | null>(null);
  // The label the form started from: a save sends the label only when the user changed it.
  const [startSensitivity, setStartSensitivity] = useState(() => sensitivityFormValue(initial?.sensitivity));

  const effectiveMode = savedNote ? 'edit' : mode;
  const effectiveNote = savedNote ?? initial;

  useEffect(() => {
    if (isOpen) { setForm(noteToForm(initial ?? {})); setStartSensitivity(sensitivityFormValue(initial?.sensitivity)); setError(null); setSavedNote(null); }
  }, [isOpen, initial]);

  const set = <K extends keyof NoteFormState>(key: K, value: NoteFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSave = async () => {
    if (!form.title.trim()) { setError(t('context.giveTheNoteATitle')); return; }
    setSaving(true);
    setError(null);
    const payload = {
      title: form.title.trim(),
      category: form.category,
      relevance: form.relevance,
      ...sensitivityPatch(startSensitivity, form.sensitivity),
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
      setStartSensitivity(sensitivityFormValue(saved.sensitivity));
      setForm((f) => ({ ...f, sensitivity: sensitivityFormValue(saved.sensitivity) }));
      onSaved(saved);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('context.couldNotSaveTheNote'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={effectiveMode === 'create' ? t('context.newContextNote') : t('context.editContextNote')} size="lg" keepWhileTyping
      footer={
        <FormActions>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('cancel')}</Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {effectiveMode === 'create' ? t('context.createNote') : t('orgChartDialogs.saveChanges')}
          </Button>
        </FormActions>
      }>
      <div className="gtd-stack" style={{ gap: 'var(--space-5)' }}>
        {error && form.title.trim() && <Notice tone="critical">{error}</Notice>}
        {form.sensitivity === UNKNOWN_SENSITIVITY && (
          <Notice tone="warning">{t('context.sensitivityInvalidNotice', { value: String(effectiveNote?.sensitivity) })}</Notice>
        )}
        <Input label={t('importUpdateModal.title')} required value={form.title} onChange={(v) => set('title', v)} placeholder={t('context.fy27OperatingPlan')} autoFocus
          error={error && !form.title.trim() ? t('context.giveTheNoteATitle') : undefined} />
        <div className="gtd-form-grid">
          <Select label={t('context.category')} value={form.category} onChange={(v) => set('category', v)}
            hint={categories.find((c) => c.id === form.category)?.description}
            options={categoryOptions(categories, form.category, t('context.builtInCategories'), t('context.yourCategories'))} />
          <Select label={t('context.relevance')} value={form.relevance} onChange={(v) => set('relevance', v)}
            hint={t('context.requiredNotesAreReadBefore')}
            options={RELEVANCE_OPTIONS.map((r) => ({ value: r, label: relevanceLabel(r) }))} />
          <Select label={t('context.sensitivity')} value={form.sensitivity} onChange={(v) => set('sensitivity', v)}
            hint={t('context.sensitivityHint')}
            options={[
              ...(form.sensitivity === UNKNOWN_SENSITIVITY ? [{ value: UNKNOWN_SENSITIVITY, label: `${t('context.sensitivityInvalid')} (${String(effectiveNote?.sensitivity)})`, disabled: true }] : []),
              { value: '', label: t('context.sensitivityNone') },
              ...SENSITIVITY_OPTIONS.map((v) => ({ value: v, label: sensitivityLabel(v) })),
            ]} />
        </div>
        <Field label={t('context.content')} hint={t('context.markdownIsSupported')} htmlFor="context-note-body">
          <MarkdownEditor id="context-note-body" value={form.body} onChange={(v) => set('body', v)} rows={8}
            placeholder={t('context.whatAnAgentShouldKnow')} />
          <DictateButton fieldName={tr('dictation.fieldContent')} onText={(text) => setForm((f) => ({ ...f, body: withDictation(f.body, text) }))} />
        </Field>
        {effectiveNote?.id && (
          <AttachedFiles baseUrl={`/api/context/${effectiveNote.id}/files`} archiveUrl={`/api/context/${effectiveNote.id}/archive`} label={t('context.attachedFiles')}
            archiveLabel={t('shareNotes.rawDownload')} archiveTitle={t('shareNotes.rawDownloadTitle')} />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Note card
// ---------------------------------------------------------------------------

interface NoteCardProps {
  note: ContextNote;
  categoryName: string;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onTitleClick: () => void;
}

function NoteCard({ note, categoryName, onEdit, onDelete, onTitleClick }: NoteCardProps) {
  const { t } = useLanguage();
  const relevanceStyle = (RELEVANCE_OPTIONS as readonly string[]).includes(note.relevance) ? RELEVANCE_BADGE[note.relevance as Relevance] : RELEVANCE_BADGE.optional;
  const preview = note.body ? note.body.slice(0, 160).trimEnd() + (note.body.length > 160 ? '…' : '') : null;
  const chip: React.CSSProperties = { padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', fontWeight: 500 };

  return (
    <Card as="article" padding="compact">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <h3 style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)', fontWeight: 600, lineHeight: 'var(--leading-tight)' }}>
            <button type="button" onClick={onTitleClick} className="gtd-link-strong" style={{ textAlign: 'left', overflowWrap: 'anywhere' }}>
              {note.title}
            </button>
          </h3>
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <IconButton label={t('context.edit', { title: note.title })} icon={icons.edit} onClick={onEdit} />
            <IconButton label={t('context.delete', { title: note.title })} icon={icons.trash} tone="danger" onClick={onDelete} />
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          <span style={{ ...chip, background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}>
            {categoryName}
          </span>
          {note.relevance && (
            <span style={{ ...chip, background: relevanceStyle.bg, color: relevanceStyle.color }}>
              {relevanceLabel(note.relevance)}
            </span>
          )}
          {sensitivityState(note.sensitivity) !== 'none' && (
            <span style={{
              ...chip,
              background: note.sensitivity === 'shareable' ? 'var(--color-success-subtle)' : sensitivityState(note.sensitivity) === 'known' ? 'var(--color-surface-hover)' : 'var(--color-warning-subtle)',
              color: note.sensitivity === 'shareable' ? 'var(--color-success)' : sensitivityState(note.sensitivity) === 'known' ? 'var(--color-text-secondary)' : 'var(--color-warning)',
            }} title={t('context.sensitivity')}>
              {sensitivityLabel(note.sensitivity)}
            </span>
          )}
          <span>{rich(t, 'context.updated', { updated_at: formatRelativeDate(note.updated_at) })}</span>
        </div>
        {preview && (
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-normal)' }}>{preview}</p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Left sidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  notes: ContextNote[];
  categories: readonly ContextCategoryInfo[];
  activeCategory: Category | null;
  onSelect: (cat: Category) => void;
  onAddCategory: () => void;
  updatesActive: boolean;
  /** Updates ready for you (review or apply), and material waiting for an analysis. */
  waiting: { ready: number; toAnalyze: number };
  onSelectUpdates: () => void;
}

/**
 * Whose move it is, next to the title of the updates list (#246): "ready for you" in amber, your turn; "to analyze"
 * neutral, the agent's turn. Each takes the list to its group.
 */
function WaitingCounts({ waiting, onShow }: { waiting: { ready: number; toAnalyze: number }; onShow: (group: string) => void }) {
  const { t } = useLanguage();
  const pills = [
    { id: 'updates-ready-for-you', count: waiting.ready, text: t('context.readyForYou'), tone: 'warning' as const },
    { id: 'updates-to-analyze', count: waiting.toAnalyze, text: t('context.toAnalyze'), tone: 'neutral' as const },
  ].filter((p) => p.count > 0);
  if (!pills.length) return null;
  return (
    <div role="group" aria-label={waitingLabel(waiting)} style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      {pills.map((p) => (
        <Button key={p.id} size="sm" variant="secondary" icon={<CountBadge count={p.count > 99 ? 99 : p.count} tone={p.tone} />}
          onClick={() => onShow(p.id)}
          aria-label={t('context.showThem', { amount: p.count, text: p.text })}>
          {p.text}
        </Button>
      ))}
    </div>
  );
}

function Sidebar({ notes, categories, activeCategory, onSelect, onAddCategory, updatesActive, waiting, onSelectUpdates }: SidebarProps) {
  const { t } = useLanguage();
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const note of notes) {
      const key = note.category.toLowerCase();
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [notes]);

  const item = (cat: Category, label: string) => {
    const isActive = activeCategory === cat;
    const count = cat === ALL ? notes.length : (counts[cat] ?? 0);
    return (
      <button key={cat} type="button" onClick={() => onSelect(cat)} className="gtd-subnav__item" aria-current={isActive ? 'true' : undefined}>
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
        {count > 0 && <CountBadge count={count} active={isActive} />}
      </button>
    );
  };
  const custom = categories.filter((c) => !c.builtin);

  return (
    <div className="gtd-split__nav">
      <nav aria-label={t('context.contextSections')}>
        <div className="gtd-subnav__label">{t('context')}</div>
        {item(ALL, t('all'))}
        {categories.filter((c) => c.builtin).map((c) => item(c.id, labelOf(c.id, categories)))}

        {/* The workspace's own categories, as their owner named them, then the way to add one. */}
        {custom.length > 0 && <div className="gtd-subnav__label">{t('context.yourCategories')}</div>}
        {custom.map((c) => item(c.id, c.label))}
        <div style={{ padding: 'var(--space-1) var(--space-2) var(--space-2)' }}>
          <Button variant="ghost" size="sm" icon={icons.plus} onClick={onAddCategory}>{t('context.addCategory')}</Button>
        </div>

        {/* Right under the library, not pinned to the bottom: material that may change it. Its own group, so raw input never looks like context. */}
        <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 'var(--space-2)', paddingBottom: 'var(--space-4)' }}>
          <div className="gtd-subnav__label">{t('updates')}</div>
          <button type="button" onClick={onSelectUpdates} aria-current={updatesActive ? 'page' : undefined} className="gtd-subnav__item"
            aria-label={waiting.ready + waiting.toAnalyze > 0 ? t('context.importAndReview', { waitingLabel: waitingLabel(waiting) }) : t('context.importAndReview2')}
            title={waiting.ready + waiting.toAnalyze > 0 ? waitingLabel(waiting) : t('context.importMeetingsDecksOrPhotos')}>
            <span>{t('context.importReview')}</span>
            {waiting.ready > 0 && <CountBadge count={waiting.ready > 99 ? 99 : waiting.ready} tone="warning" />}
          </button>
          <p style={{ margin: 'var(--space-1) var(--space-4) 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 'var(--leading-normal)' }}>
            {t('context.bringInMeetingsDecksAnd')}
          </p>
        </div>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function ContextView() {
  const { t } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const { id: updateId } = useParams<{ id?: string }>();
  // Opened from a run-finished notice: the workspace the run was in, so the update is read only there.
  const expectedWorkspace = typeof (location.state as { workspace?: unknown } | null)?.workspace === 'string'
    ? (location.state as { workspace: string }).workspace : undefined;
  const showUpdates = location.pathname.startsWith('/context/updates');
  const updatesVersion = useDataVersion('context-updates');
  const { data: updates } = useApi<ContextUpdate[]>('/api/context-updates', [updatesVersion]);
  const waiting = waitingCounts(updates ?? []);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Kept here, not in the list, so opening an update and coming back keeps the filter and the page.
  const [updateType, setUpdateType] = useState<TypeFilter>('all');
  const [updateQuery, setUpdateQuery] = useState('');
  const [historyShown, setHistoryShown] = useState(HISTORY_PAGE);
  const updatesList = showUpdates && !updateId;
  // List and detail share one scroll box: a detail starts at the top, and the list comes back where it was left.
  const updatesScroll = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  useLayoutEffect(() => {
    const box = updatesScroll.current;
    if (box) box.scrollTop = updateId ? 0 : listScrollTop.current;
  }, [updateId]);
  const updatesShown = useMemo(() => filterUpdates(updates ?? [], updateType, updateQuery).length, [updates, updateType, updateQuery]);
  // A count by the title takes the list to its group: filters that hide the group are cleared first, and the keyboard
  // lands on the group, so the next Tab goes on from there.
  const [groupToShow, setGroupToShow] = useState<string | null>(null);
  const showGroup = (group: string) => {
    if (!document.getElementById(group)) { setUpdateType('all'); setUpdateQuery(''); }
    setGroupToShow(group);
  };
  useEffect(() => {
    if (!groupToShow) return;
    const el = document.getElementById(groupToShow);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
    setGroupToShow(null);
  }, [groupToShow, updatesShown]);
  const dispatch = useAppDispatch();
  const [notes, setNotes] = useState<ContextNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>(ALL);
  // Built-in and the workspace's own categories; reloaded when anything under context/ changes (categories.md too).
  const contextVersion = useDataVersion('context');
  const { data: loadedCategories, error: categoriesError, refetch: refetchCategories } = useApi<ContextCategoryInfo[]>('/api/context/categories', [contextVersion]);
  const [categories, setCategories] = useState<ContextCategoryInfo[]>(BUILTIN_CATEGORIES);
  const [categoryModal, setCategoryModal] = useState<{ editing: ContextCategoryInfo | null } | null>(null);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [selectedNote, setSelectedNote] = useState<ContextNote | null>(null);

  const loadNotes = useCallback(() => {
    apiGet<ContextNote[]>('/api/context')
      .then((data) => { setNotes(data); setError(null); setLoading(false); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : t('context.failedToLoadNotes')); setLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t only words the error
  }, []);
  useEffect(loadNotes, [loadNotes]);

  // A category added in another window, by hand or by an agent may bring a folder of notes with it: load them too.
  // A category that is gone takes the page back to all notes.
  const seenCategories = useRef<string | null>(null);
  useEffect(() => {
    if (!loadedCategories) return;
    setCategories(loadedCategories);
    const key = loadedCategories.map((c) => c.id).join('\n');
    if (seenCategories.current !== null && seenCategories.current !== key) loadNotes();
    seenCategories.current = key;
    setActiveCategory((active) => active === ALL || loadedCategories.some((c) => c.id === active) ? active : ALL);
  }, [loadedCategories, loadNotes]);
  const activeCustom = categories.find((c) => c.id === activeCategory && !c.builtin) ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes.filter((n) => {
      const matchCat = activeCategory === ALL || n.category.toLowerCase() === activeCategory;
      const matchSearch = !q || n.title.toLowerCase().includes(q) || (n.body ?? '').toLowerCase().includes(q);
      return matchCat && matchSearch;
    });
  }, [notes, activeCategory, search]);

  const openCreate = () => {
    const defaultCategory = activeCategory === ALL ? 'company' : activeCategory;
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

  const confirm = useConfirm();
  const notify = useNotify();
  // A link to one note (`?note=<id>`, from global search) opens it once the notes are loaded, then leaves the address
  // as the Context page, so Back and a reload behave as usual. A note that is gone says so.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('note');
  useEffect(() => {
    if (!wanted || loading) return;
    const note = notes.find((n) => n.id === wanted);
    setParams((p) => { p.delete('note'); return p; }, { replace: true });
    if (note) { openEdit(note); return; }
    if (error) return;
    // Not in the list this page loaded: it may be newer (an agent or another tab made it). Ask before saying it is gone.
    apiGet<ContextNote>(`/api/context/${encodeURIComponent(wanted)}`)
      .then((fresh) => { setNotes((list) => list.some((n) => n.id === fresh.id) ? list : [fresh, ...list]); openEdit(fresh); })
      .catch(() => notify.error(null, t('context.noteNotFound')));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a note is asked for and the list is there
  }, [wanted, loading]);

  const handleDelete = useCallback(async (note: ContextNote, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirm({
      title: t('context.delete2', { title: note.title }),
      message: t('context.theNoteAndItsAttached'),
      confirmLabel: t('context.deleteNote'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/context/${note.id}`);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      notify.success(t('context.deleted', { title: note.title }));
    } catch (err: unknown) {
      notify.error(err, t('context.couldNotDeleteTheNote'));
    }
  }, [confirm, notify, t]);

  const handleCategorySaved = (saved: ContextCategoryInfo, created: boolean) => {
    setCategoryModal(null);
    setCategories((list) => list.some((c) => c.id === saved.id) ? list.map((c) => c.id === saved.id ? saved : c) : [...list, saved]);
    refetchCategories();
    if (!created) return;
    setActiveCategory(saved.id);
    setSearch('');
    if (showUpdates) navigate('/context');
    notify.success(t('context.categoryAdded', { label: saved.label }));
  };

  const handleDeleteCategory = async (category: ContextCategoryInfo) => {
    const count = notes.filter((n) => n.category.toLowerCase() === category.id).length;
    // Never removes notes: they are moved or deleted first, one by one, where the user can see them.
    if (count > 0) { notify.warning(t('context.categoryHasNotes', { count, label: category.label })); return; }
    const ok = await confirm({
      title: t('context.deleteCategoryTitle', { label: category.label }),
      message: t('context.deleteCategoryMessage'),
      confirmLabel: t('context.deleteCategory'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/context/categories/${encodeURIComponent(category.id)}`);
      setCategories((list) => list.filter((c) => c.id !== category.id));
      setActiveCategory(ALL);
      refetchCategories();
      notify.success(t('context.categoryDeleted', { label: category.label }));
    } catch (err: unknown) {
      notify.error(err, t('context.couldNotDeleteTheCategory'));
    }
  };

  const handleSaved = useCallback((saved: ContextNote) => {
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [saved, ...prev];
    });
    setIsModalOpen(false);
    setSelectedNote(null);
  }, []);

  if (loading) return <LoadingSpinner text={t('context.loadingContextNotes')} />;

  const categoryTitle = showUpdates ? t('context.contextUpdates') : activeCategory === ALL ? t('context.allNotes') : labelOf(activeCategory, categories);

  const handleImported = (update: ContextUpdate, uploadErrors: string[]) => {
    setImportOpen(false);
    // Also refreshes the sidebar dot, which counts the same updates.
    dispatch({ type: 'DATA_CHANGED', payload: 'context-updates' });
    if (uploadErrors.length) {
      dispatch({ type: 'ADD_NOTIFICATION', payload: { type: 'warning', message: t('context.savedButSomeFilesDid', { join: uploadErrors.join('; ') }) } });
    }
    navigate(`/context/updates/${update.id}`);
  };

  const handleQueued = (meeting: QueuedMeeting) => {
    setImportOpen(false);
    dispatch({ type: 'ADD_NOTIFICATION', payload: { type: 'success', message: t('context.isInTheMeetingQueue', { title: meeting.title }) } });
  };

  return (
    <div className="gtd-split">
      <Sidebar notes={notes} categories={categories} activeCategory={showUpdates ? null : activeCategory}
        onAddCategory={() => setCategoryModal({ editing: null })}
        onSelect={(cat) => { setActiveCategory(cat); setSearch(''); if (showUpdates) navigate('/context'); }}
        updatesActive={showUpdates} waiting={waiting} onSelectUpdates={() => navigate('/context/updates')} />

      <div className="gtd-split__main">
        <div className="gtd-split__header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', minWidth: 0 }}>
          <h2 className="gtd-split__title">
            {categoryTitle}
            {(!showUpdates || (updatesList && (updates?.length ?? 0) > 0)) && (
              <CountBadge count={showUpdates ? updatesShown : filtered.length} tone="accent" />
            )}
          </h2>
          {updatesList && <WaitingCounts waiting={waiting} onShow={showGroup} />}
          {/* Next to the name they change: the workspace's own categories only. */}
          {!showUpdates && activeCustom && (
            <div style={{ display: 'flex', gap: 2 }}>
              <IconButton label={t('context.editCategoryNamed', { label: activeCustom.label })} icon={icons.edit} onClick={() => setCategoryModal({ editing: activeCustom })} />
              <IconButton label={t('context.deleteCategoryNamed', { label: activeCustom.label })} icon={icons.trash} tone="danger" onClick={() => void handleDeleteCategory(activeCustom)} />
            </div>
          )}
          </div>
          <div className="gtd-page-header__actions">
            {!showUpdates && <SearchInput value={search} onChange={setSearch} placeholder={t('context.searchNotes')} width={220} />}
            {updatesList && (updates?.length ?? 0) > 0 && (
              <SearchInput value={updateQuery} onChange={(v) => { setUpdateQuery(v); setHistoryShown(HISTORY_PAGE); }} placeholder={t('context.searchUpdatesByTitleOr')} width={240} />
            )}
            {waiting.ready > 0 && !updatesList && (
              <Button onClick={() => navigate('/context/updates')}
                aria-label={t('context.toReview', { waitingLabel: waitingLabel(waiting) })}
                title={waitingLabel(waiting)}
                icon={<CountBadge count={waiting.ready > 99 ? 99 : waiting.ready} tone="warning" />}>
                {t('context.toReview2')}
              </Button>
            )}
            <Button variant={showUpdates ? 'primary' : 'secondary'} onClick={() => setImportOpen(true)}
              title={t('context.uploadATranscriptDeckPhoto')}>
              {t('updatesList.importUpdate')}
            </Button>
            {!showUpdates && <Button onClick={() => setShareOpen(true)} title={t('shareNotes.buttonTitle')}>{t('shareNotes.button')}</Button>}
            {!showUpdates && <Button variant="primary" icon={icons.plus} onClick={openCreate}>{t('context.newNote')}</Button>}
          </div>
        </div>

        {showUpdates && (
          <div ref={updatesScroll} className="gtd-split__body">
            {updateId
              // Keyed by the workspace too: the same id from another workspace's notice is another page, read again.
              ? <UpdateDetail key={`${updateId}\0${expectedWorkspace ?? ''}`} id={updateId} workspace={expectedWorkspace} onBack={() => navigate('/context/updates')} />
              : <UpdatesList updates={updates ?? []} type={updateType} query={updateQuery} historyShown={historyShown}
                  onType={(t) => { setUpdateType(t); setHistoryShown(HISTORY_PAGE); }}
                  onShowMore={() => setHistoryShown((n) => n + HISTORY_PAGE)}
                  onClearFilters={() => { setUpdateType('all'); setUpdateQuery(''); setHistoryShown(HISTORY_PAGE); }}
                  onOpen={(id) => { listScrollTop.current = updatesScroll.current?.scrollTop ?? 0; navigate(`/context/updates/${id}`); }} onImport={() => setImportOpen(true)} />}
          </div>
        )}

        <div className="gtd-split__body" style={{ display: showUpdates ? 'none' : undefined }}>
          <div className="gtd-stack" style={{ gap: 'var(--space-3)', maxWidth: 'var(--page-width-default)' }}>
            {error && <Notice tone="critical" title={t('context.couldNotLoadTheNotes')}>{error}</Notice>}
            {categoriesError && !loadedCategories && <Notice tone="warning">{t('context.couldNotLoadCategories')}</Notice>}
            {activeCustom?.description && (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-normal)', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
                {activeCustom.description}
              </p>
            )}

            {filtered.length === 0 && !error && (
              <EmptyState
                title={search ? t('context.noNotesMatch', { search }) : t('context.noNotesIn', { categoryTitle })}
                description={search ? t('context.tryAnotherWordOrClear') : t('context.contextNotesHoldTheBackground')}
                action={search ? { label: t('meetingsList.clearSearch'), onClick: () => setSearch('') } : { label: t('context.newNote'), onClick: openCreate }}
              />
            )}

            {filtered.map((note) => (
              <NoteCard key={note.id} note={note} categoryName={labelOf(note.category, categories)}
                onTitleClick={() => openEdit(note)}
                onEdit={(e) => openEdit(note, e)}
                onDelete={(e) => handleDelete(note, e)} />
            ))}
          </div>
        </div>
      </div>

      <ShareNotes isOpen={shareOpen} onClose={() => setShareOpen(false)} notes={notes}
        categoryLabel={(c) => labelOf(c, categories)} />
      <ImportUpdateModal isOpen={importOpen} onClose={() => setImportOpen(false)} onCreated={handleImported} onQueued={handleQueued} />

      <NoteModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)}
        initial={selectedNote} mode={modalMode} onSaved={handleSaved} categories={categories} />
      <CategoryModal isOpen={categoryModal !== null} onClose={() => setCategoryModal(null)} editing={categoryModal?.editing ?? null}
        categories={categories} onSaved={handleCategorySaved} />
    </div>
  );
}
