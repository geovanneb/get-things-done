import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React from 'react';
import Modal, { FormActions } from '../common/Modal';
import Button from '../common/Button';
import IconButton, { icons } from '../common/IconButton';
import Input, { Select } from '../common/Input';
import Notice from '../common/Notice';
import Card from '../common/Card';
import { useConfirm } from '../common/ConfirmDialog';
import { apiDelete, apiPut } from '../../utils/api';
import type { Task } from '../../types';
import {
  COLUMN_STATUSES, DEFAULT_BOARD, MAX_COLUMNS, MAX_LABEL, isDefaultBoard, labelError, moveColumn, newColumnId,
  placeTasks, statusLabel, statusesWithoutColumn, type BoardColumn, type BoardColumns,
} from '../../utils/boardColumns';

interface BoardColumnsEditorProps {
  isOpen: boolean;
  /** The columns as saved now. */
  columns: BoardColumn[];
  /** The open tasks, to say how many each column holds and where they go when one is removed. */
  tasks: Task[];
  onClose: () => void;
  onSaved: (columns: BoardColumn[]) => void;
}


/** A name for a new column that no other column has yet. */
function freeName(columns: BoardColumn[]): string {
  const taken = new Set(columns.map((c) => c.label.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? tr('boardColumnsEditor.newColumn') : tr('boardColumnsEditor.newColumn2', { n });
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * "Edit columns": rename, add, remove and reorder the board's columns, then save them all at once. Cancel leaves the
 * board as it was. Drag and drop alone fails WCAG 2.2 SC 2.5.7, so every row also has Move up and Move down buttons,
 * and each change is announced to screen readers.
 */
export default function BoardColumnsEditor({ isOpen, columns, tasks, onClose, onSaved }: BoardColumnsEditorProps) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [draft, setDraft] = React.useState<BoardColumn[]>(columns);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [announcement, setAnnouncement] = React.useState('');
  const [dragging, setDragging] = React.useState<number | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());
  // Button does not take a ref, so the focus goes to the button inside this wrapper.
  const addRef = React.useRef<HTMLDivElement>(null);
  const addButton = () => addRef.current?.querySelector('button') ?? null;

  // Each opening starts from what is saved.
  React.useEffect(() => {
    if (!isOpen) return;
    setDraft(columns);
    setSaveError('');
    setAnnouncement('');
    setDragging(null);
  }, [isOpen, columns]);

  const placed = React.useMemo(() => placeTasks(tasks, draft), [tasks, draft]);
  const missing = statusesWithoutColumn(draft);
  const errors = draft.map((_, i) => labelError(draft, i));
  const valid = errors.every((e) => e === null);
  const changed = JSON.stringify(draft) !== JSON.stringify(columns);

  /** Focus a field or button of a row after React has re-rendered it. */
  const focusLater = (id: string, selector: string, fallback?: () => HTMLElement | null) => {
    requestAnimationFrame(() => {
      const el = rowRefs.current.get(id)?.querySelector<HTMLElement>(selector);
      if (el && !(el as HTMLButtonElement).disabled) el.focus();
      else fallback?.()?.focus();
    });
  };

  const update = (index: number, patch: Partial<BoardColumn>) => {
    setDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const move = (from: number, to: number, keepFocus?: 'up' | 'down') => {
    const column = draft[from];
    const next = moveColumn(draft, from, to);
    if (next === draft) return;
    setDraft(next);
    const position = next.findIndex((c) => c.id === column.id);
    setAnnouncement(t('boardColumnsEditor.movedToPositionOf', { label: column.label || t('boardColumnsEditor.column'), value: position + 1, length: next.length }));
    // The row moves in the list: keep the focus on its button, or on the other arrow once it reaches the end.
    if (keepFocus) {
      const other = keepFocus === 'up' ? 'down' : 'up';
      focusLater(column.id, `[data-move="${keepFocus}"]`, () => rowRefs.current.get(column.id)?.querySelector(`[data-move="${other}"]`) ?? null);
    }
  };

  const add = () => {
    if (draft.length >= MAX_COLUMNS) return;
    const column: BoardColumn = { id: newColumnId(draft), label: freeName(draft), status: 'in_progress' };
    setDraft((prev) => [...prev, column]);
    setAnnouncement(t('boardColumnsEditor.addedAtTheEnd', { label: column.label }));
    requestAnimationFrame(() => {
      const input = rowRefs.current.get(column.id)?.querySelector<HTMLInputElement>('input');
      input?.focus();
      input?.select();
    });
  };

  const remove = async (index: number) => {
    const column = draft[index];
    const next = draft.filter((_, i) => i !== index);
    const held = placed.byColumn.get(column.id) ?? [];
    if (held.length > 0) {
      // Say where its tasks go once it is gone: the column that takes their status, or only the List view.
      const after = placeTasks(held, next);
      const destinations = [...after.byColumn].filter(([, list]) => list.length > 0).map(([id]) => next.find((c) => c.id === id)!.label);
      const message = (
        <>
          {destinations.length > 0 && <>{rich(t, 'boardColumnsEditor.itsWillShowIn', { plural: t('common.taskCount', { count: held.length - after.unplaced.length }), join: destinations.join(', ') })} </>}
          {after.unplaced.length > 0 && <>{rich(t, 'boardColumnsEditor.willOnlyShowInThe', { plural: t('common.taskCount', { count: after.unplaced.length }) })} </>}
          {t('boardColumnsEditor.tasksKeepTheirStatusAnd')}
        </>
      );
      const ok = await confirm({
        title: t('boardColumnsEditor.removeTheColumn', { label: column.label || 'unnamed' }), message, confirmLabel: t('boardColumnsEditor.removeColumn'), tone: 'danger',
      });
      if (!ok) return;
    }
    setDraft(next);
    setAnnouncement(t('boardColumnsEditor.removed', { label: column.label || t('boardColumnsEditor.column') }));
    const neighbour = next[Math.min(index, next.length - 1)];
    if (neighbour) focusLater(neighbour.id, 'input', addButton);
    else requestAnimationFrame(() => addButton()?.focus());
  };

  const reset = () => {
    setDraft(DEFAULT_BOARD.columns);
    setAnnouncement(t('boardColumnsEditor.theColumnsAreBackTo'));
  };

  const save = async () => {
    if (saving || !valid || draft.length === 0) return;
    setSaving(true);
    setSaveError('');
    const cleaned = draft.map((c) => ({ ...c, label: c.label.trim() }));
    try {
      // The default board is saved as "no columns", so a later release's default applies.
      if (isDefaultBoard(cleaned)) {
        await apiDelete('/api/workspace/board');
        onSaved(DEFAULT_BOARD.columns);
      } else {
        const saved = await apiPut<BoardColumns>('/api/workspace/board', { columns: cleaned });
        onSaved(saved?.columns ?? cleaned);
      }
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : t('boardColumnsEditor.tryAgain'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={saving ? () => {} : onClose}
      size="lg"
      keepWhileTyping
      title={t('boardColumnsEditor.editColumns')}
      description={t('boardColumnsEditor.renameAddRemoveAndReorder')}
      footer={(
        <FormActions start={(
          <Button variant="ghost" onClick={reset} disabled={saving || isDefaultBoard(draft)}
            title={isDefaultBoard(draft) ? t('boardColumnsEditor.theColumnsAreAlreadyThe') : undefined}>
            {t('resetToDefault')}
          </Button>
        )}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('cancel')}</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!valid || !changed}
            title={!valid ? t('boardColumnsEditor.fixTheNamesMarkedIn') : !changed ? t('boardColumnsEditor.nothingHasChangedYet') : undefined}>
            {t('boardColumnsEditor.saveColumns')}
          </Button>
        </FormActions>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {saveError && <Notice tone="critical" title={t('boardColumnsEditor.couldNotSaveTheColumns')}>{saveError}</Notice>}

        <Card padding="none">
        <ul className="gtd-list" aria-label={t('boardColumnsEditor.boardColumnsLeftToRight')}>
          {draft.map((column, index) => {
            const count = placed.byColumn.get(column.id)?.length ?? 0;
            const name = column.label.trim() || t('boardColumnsEditor.unnamedColumn');
            return (
              <li
                key={column.id}
                ref={(el) => { if (el) rowRefs.current.set(column.id, el); else rowRefs.current.delete(column.id); }}
                className="gtd-list__row"
                aria-label={t('boardColumnsEditor.columnOf', { value: index + 1, length: draft.length, name })}
                onDragOver={(e) => {
                  if (dragging === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging !== null && dragging !== index) move(dragging, index);
                  setDragging(null);
                }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
                  background: dragging === index ? 'var(--color-accent-subtle)' : undefined,
                }}
              >
                <span
                  draggable
                  title={t('boardColumnsEditor.dragToReorder')}
                  aria-hidden="true"
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', column.id);
                    const row = rowRefs.current.get(column.id);
                    if (row) e.dataTransfer.setDragImage(row, 16, 16);
                    setDragging(index);
                  }}
                  onDragEnd={() => setDragging(null)}
                  style={{ display: 'flex', alignItems: 'center', height: 'var(--control-height-sm)', marginTop: 22, cursor: 'grab', color: 'var(--color-text-muted)' }}
                >
                  <IconGrip />
                </span>
                <div className="gtd-form-grid" style={{ flex: 1, minWidth: 0, gap: 'var(--space-3)' }}>
                  <Input
                    label={t('boardColumnsEditor.name')}
                    required
                    size="sm"
                    value={column.label}
                    maxLength={MAX_LABEL}
                    onChange={(label) => update(index, { label })}
                    error={errors[index]}
                    hint={t('common.taskCount', { count: count }) + t('boardColumnsEditor.hereNow')}
                  />
                  <Select
                    label={t('boardColumnsEditor.droppedTasksBecome')}
                    size="sm"
                    value={column.status}
                    onChange={(status) => update(index, { status: status as BoardColumn['status'] })}
                    options={COLUMN_STATUSES().map((s) => ({ value: s.value, label: s.label }))}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginTop: 22, flexShrink: 0 }}>
                  <IconButton data-move="up" label={t('boardColumnsEditor.moveUp', { name })} icon={arrowUp} disabled={index === 0} onClick={() => move(index, index - 1, 'up')} />
                  <IconButton data-move="down" label={t('boardColumnsEditor.moveDown', { name })} icon={arrowDown} disabled={index === draft.length - 1} onClick={() => move(index, index + 1, 'down')} />
                  <IconButton
                    label={draft.length === 1 ? t('boardColumnsEditor.theBoardNeedsAtLeast') : t('removeNamedFile', { name })}
                    icon={icons.trash}
                    tone="danger"
                    disabled={draft.length === 1}
                    onClick={() => { void remove(index); }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        </Card>

        <div ref={addRef}>
          <Button icon={icons.plus} size="sm" onClick={add} disabled={draft.length >= MAX_COLUMNS}
            title={draft.length >= MAX_COLUMNS ? t('boardColumnsEditor.theBoardHasTheMost', { MAX_COLUMNS }) : undefined}>
            {t('boardColumnsEditor.addColumn')}
          </Button>
        </div>

        {missing.length > 0 && (
          <Notice tone="warning" title={t('boardColumnsEditor.noColumnShowsTasks', { join: missing.map(statusLabel).join(', ') })}>
            {rich(t, 'boardColumnsEditor.onlyShowInTheList', { value: placed.unplaced.length > 0 ? t('boardColumnsEditor.will', { plural: t('common.taskCount', { count: placed.unplaced.length }) }) : t('boardColumnsEditor.thoseTasksWill'), value2: missing.includes('in_review') && t('boardColumnsEditor.agentsMoveTasksToNeeds') })}
          </Notice>
        )}
      </div>

      <div className="sr-only" aria-live="polite">{announcement}</div>
    </Modal>
  );
}

const arrowUp = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
  </svg>
);

const arrowDown = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
  </svg>
);

function IconGrip() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="4" r="1.1" /><circle cx="7" cy="4" r="1.1" />
      <circle cx="3" cy="8" r="1.1" /><circle cx="7" cy="8" r="1.1" />
      <circle cx="3" cy="12" r="1.1" /><circle cx="7" cy="12" r="1.1" />
    </svg>
  );
}
