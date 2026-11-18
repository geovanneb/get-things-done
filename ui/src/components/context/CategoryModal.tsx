import { useEffect, useState } from 'react';
import { useLanguage } from '@/i18n/LanguageProvider';
import { serverText } from '@/i18n/serverText';
import Button from '@/components/common/Button';
import Input, { Textarea } from '@/components/common/Input';
import Modal, { FormActions } from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import { apiPost, apiPut } from '@/utils/api';
import { categoryProblem, MAX_CATEGORY_LABEL, type CategoryProblem } from '@/utils/contextCategories';
import type { ContextCategoryInfo } from '@/types';

interface CategoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The category to rename, or null to add one. */
  editing: ContextCategoryInfo | null;
  categories: readonly ContextCategoryInfo[];
  onSaved: (category: ContextCategoryInfo, created: boolean) => void;
}

/** Adds a context category of the workspace's own, or renames one. The id (its folder) is set once and never shown as editable. */
export default function CategoryModal({ isOpen, onClose, editing, categories, onSaved }: CategoryModalProps) {
  const { t } = useLanguage();
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  // Shown only after a save was tried, so the dialog does not open with an error.
  const [problem, setProblem] = useState<CategoryProblem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLabel(editing?.label ?? '');
    setDescription(editing?.description ?? '');
    setProblem(null);
    setError(null);
  }, [isOpen, editing]);

  const save = async () => {
    const found = categoryProblem(label, description, categories, editing?.id);
    setProblem(found);
    if (found) return;
    setSaving(true);
    setError(null);
    try {
      const body = { label: label.trim(), description: description.trim() };
      const saved = editing
        ? await apiPut<ContextCategoryInfo>(`/api/context/categories/${encodeURIComponent(editing.id)}`, body)
        : await apiPost<ContextCategoryInfo>('/api/context/categories', body);
      onSaved(saved, !editing);
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? serverText(err.message) : t('context.couldNotSaveTheCategory'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? t('context.editCategory') : t('context.newCategory')} keepWhileTyping
      footer={
        <FormActions>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('cancel')}</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {editing ? t('orgChartDialogs.saveChanges') : t('context.addCategory')}
          </Button>
        </FormActions>
      }>
      <div className="gtd-stack" style={{ gap: 'var(--space-5)' }}>
        {(error || problem?.field === 'form') && <Notice tone="critical">{error ?? problem?.message}</Notice>}
        <Input label={t('context.categoryName')} required value={label} onChange={setLabel} autoFocus maxLength={MAX_CATEGORY_LABEL}
          placeholder={t('context.categoryNamePlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !saving) { e.preventDefault(); void save(); } }}
          hint={editing ? t('context.categoryFolder', { id: editing.id }) : t('context.categoryNameHint')}
          error={problem?.field === 'label' ? problem.message : undefined} />
        <Textarea label={t('context.categoryDescription')} optional value={description} onChange={setDescription} rows={3}
          hint={t('context.categoryDescriptionHint')} placeholder={t('context.categoryDescriptionPlaceholder')}
          error={problem?.field === 'description' ? problem.message : undefined} />
      </div>
    </Modal>
  );
}
