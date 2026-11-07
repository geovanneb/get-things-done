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
import UpdatesList from '@/components/context-updates/UpdatesList';
import UpdateDetail from '@/components/context-updates/UpdateDetail';
import { filterUpdates, HISTORY_PAGE, waitingCounts, waitingLabel, type TypeFilter } from '@/utils/updateTypes';
import type { ContextNote, ContextUpdate, QueuedMeeting } from '@/types';
import DictateButton from '@/components/common/DictateButton';
import { withDictation } from '@/utils/dictation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Stored in each note's file: translate at display time, never here.
const CATEGORIES = ['Company', 'Organization', 'Strategy', 'Programs', 'Decisions', 'Risks', 'Glossary', 'Situation'] as const;

const categoryLabel = (category: string): string => ({
  All: tr('all'), Company: tr('context.company'), Organization: tr('context.organization'), Strategy: tr('context.strategy'), Programs: tr('context.programs'),
  Decisions: tr('updateDetail.decisions'), Risks: tr('context.risks'), Glossary: tr('context.glossary'), Situation: tr('situation'),
} as Record<string, string>)[category] ?? category;

type Category = (typeof CATEGORIES)[number] | 'All';

const RELEVANCE_OPTIONS = ['required', 'recommended', 'optional'] as const;
type Relevance = (typeof RELEVANCE_OPTIONS)[number];
const relevanceLabel = (relevance: string): string => ({ required: tr('context.relevanceRequired'), recommended: tr('context.relevanceRecommended'), optional: tr('context.relevanceOptional') } as Record<string, string>)[relevance] ?? relevance;

const RELEVANCE_BADGE: Record<Relevance, { bg: string; color: string }> = {
  required:    { bg: 'var(--color-critical-subtle)', color: 'var(--color-critical)' },
  recommended: { bg: 'var(--color-warning-subtle)',  color: 'var(--color-warning)'  },
  optional:    { bg: 'var(--color-info-subtle)',     color: 'var(--color-info)'     },
};

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
  const { t } = useLanguage();
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
    if (!form.title.trim()) { setError(t('context.giveTheNoteATitle')); return; }
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
        <Input label={t('importUpdateModal.title')} required value={form.title} onChange={(v) => set('title', v)} placeholder={t('context.fy27OperatingPlan')} autoFocus
          error={error && !form.title.trim() ? t('context.giveTheNoteATitle') : undefined} />
        <div className="gtd-form-grid">
          <Select label={t('context.category')} value={form.category} onChange={(v) => set('category', v)}
            options={CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))} />
          <Select label={t('context.relevance')} value={form.relevance} onChange={(v) => set('relevance', v)}
            hint={t('context.requiredNotesAreReadBefore')}
            options={RELEVANCE_OPTIONS.map((r) => ({ value: r, label: relevanceLabel(r) }))} />
        </div>
        <Field label={t('context.content')} hint={t('context.markdownIsSupported')} htmlFor="context-note-body">
          <MarkdownEditor id="context-note-body" value={form.body} onChange={(v) => set('body', v)} rows={8}
            placeholder={t('context.whatAnAgentShouldKnow')} />
          <DictateButton fieldName={tr('dictation.fieldContent')} onText={(text) => setForm((f) => ({ ...f, body: withDictation(f.body, text) }))} />
        </Field>
        {effectiveNote?.id && (
          <AttachedFiles baseUrl={`/api/context/${effectiveNote.id}/files`} archiveUrl={`/api/context/${effectiveNote.id}/archive`} label={t('context.attachedFiles')} />
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
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onTitleClick: () => void;
}

function NoteCard({ note, onEdit, onDelete, onTitleClick }: NoteCardProps) {
  const { t } = useLanguage();
  const relevanceStyle = RELEVANCE_BADGE[note.relevance as Relevance] ?? RELEVANCE_BADGE.optional;
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
            {categoryLabel((note.category ?? '').charAt(0).toUpperCase() + (note.category ?? '').slice(1))}
          </span>
          {note.relevance && (
            <span style={{ ...chip, background: relevanceStyle.bg, color: relevanceStyle.color }}>
              {relevanceLabel(note.relevance)}
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
  activeCategory: Category | null;
  onSelect: (cat: Category) => void;
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

function Sidebar({ notes, activeCategory, onSelect, updatesActive, waiting, onSelectUpdates }: SidebarProps) {
  const { t } = useLanguage();
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
    <div className="gtd-split__nav">
      <nav aria-label={t('context.contextSections')}>
        <div className="gtd-subnav__label">{t('context')}</div>
        {items.map((cat) => {
          const isActive = activeCategory === cat;
          const count = cat === 'All' ? notes.length : (counts[cat.toLowerCase()] ?? 0);
          return (
            <button key={cat} type="button" onClick={() => onSelect(cat)} className="gtd-subnav__item" aria-current={isActive ? 'true' : undefined}>
              <span>{categoryLabel(cat)}</span>
              {count > 0 && <CountBadge count={count} active={isActive} />}
            </button>
          );
        })}

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
  const [activeCategory, setActiveCategory] = useState<Category>('All');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [selectedNote, setSelectedNote] = useState<ContextNote | null>(null);

  useEffect(() => {
    apiGet<ContextNote[]>('/api/context')
      .then((data) => { setNotes(data); setLoading(false); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : t('context.failedToLoadNotes')); setLoading(false); });
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

  const confirm = useConfirm();
  const notify = useNotify();
  // A link to one note (`?note=<id>`, from global search) opens it once the notes are loaded, then leaves the address
  // as the Context page, so Back and a reload behave as usual. A note that is gone says so.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('note');
  useEffect(() => {
    if (!wanted || loading) return;
    const note = notes.find((n) => n.id === wanted);
    if (note) openEdit(note);
    else if (!error) notify.error(null, t('context.noteNotFound'));
    setParams((p) => { p.delete('note'); return p; }, { replace: true });
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

  const categoryTitle = showUpdates ? t('context.contextUpdates') : activeCategory === 'All' ? t('context.allNotes') : categoryLabel(activeCategory);

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
      <Sidebar notes={notes} activeCategory={showUpdates ? null : activeCategory}
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

            {filtered.length === 0 && !error && (
              <EmptyState
                title={search ? t('context.noNotesMatch', { search }) : t('context.noNotesIn', { categoryTitle })}
                description={search ? t('context.tryAnotherWordOrClear') : t('context.contextNotesHoldTheBackground')}
                action={search ? { label: t('meetingsList.clearSearch'), onClick: () => setSearch('') } : { label: t('context.newNote'), onClick: openCreate }}
              />
            )}

            {filtered.map((note) => (
              <NoteCard key={note.id} note={note}
                onTitleClick={() => openEdit(note)}
                onEdit={(e) => openEdit(note, e)}
                onDelete={(e) => handleDelete(note, e)} />
            ))}
          </div>
        </div>
      </div>

      <ImportUpdateModal isOpen={importOpen} onClose={() => setImportOpen(false)} onCreated={handleImported} onQueued={handleQueued} />

      <NoteModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)}
        initial={selectedNote} mode={modalMode} onSaved={handleSaved} />
    </div>
  );
}
