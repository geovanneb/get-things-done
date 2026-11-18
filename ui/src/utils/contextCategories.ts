import { tr } from '@/i18n/current';
import type { ContextCategoryInfo } from '@/types';

/** The same limits as server/src/services/contextCategories.ts, checked here first so the message is translated. */
export const MAX_CATEGORY_LABEL = 40;
export const MAX_CATEGORY_DESCRIPTION = 300;
export const MAX_CUSTOM_CATEGORIES = 30;

/** Shown until the list loads, or when it cannot: the eight a workspace always has. */
export const BUILTIN_CATEGORIES: ContextCategoryInfo[] = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation']
  .map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1), builtin: true }));

/** Built-in names in the interface language. A function, so the text follows a language change. */
const builtinLabel = (id: string): string | undefined => {
  switch (id) {
    case 'company': return tr('context.company');
    case 'organization': return tr('context.organization');
    case 'strategy': return tr('context.strategy');
    case 'programs': return tr('context.programs');
    case 'decisions': return tr('updateDetail.decisions');
    case 'risks': return tr('context.risks');
    case 'glossary': return tr('context.glossary');
    case 'situation': return tr('situation');
    default: return undefined;
  }
};

/**
 * What to call a category: a built-in one in the interface language, the workspace's own as its owner named it
 * (stored data, never translated), anything else (a note's hand-written category) as written. Matched without case:
 * older dashboards sent "Company".
 */
export function categoryLabel(category: string, categories: readonly ContextCategoryInfo[]): string {
  const id = String(category ?? '').toLowerCase();
  const found = categories.find((c) => c.id === id);
  if (found && !found.builtin) return found.label;
  return builtinLabel(id) ?? (found?.label ?? String(category ?? ''));
}

/**
 * Why a category name cannot be saved, in the interface language, or null. `editing` is the id of the category being
 * renamed, so its own name does not count as taken. The server checks again: this is only for a translated message.
 */
export function categoryProblem(label: string, description: string, categories: readonly ContextCategoryInfo[], editing?: string): CategoryProblem | null {
  const name = label.trim();
  if (!name) return { field: 'label', message: tr('context.giveTheCategoryAName') };
  if (name.length > MAX_CATEGORY_LABEL) return { field: 'label', message: tr('context.categoryNameTooLong', { max: MAX_CATEGORY_LABEL }) };
  if (description.trim().length > MAX_CATEGORY_DESCRIPTION) return { field: 'description', message: tr('context.categoryDescriptionTooLong', { max: MAX_CATEGORY_DESCRIPTION }) };
  const lower = name.toLowerCase();
  const clash = categories.find((c) => c.id !== editing && (c.label.toLowerCase() === lower || c.id === lower || categoryLabel(c.id, categories).toLowerCase() === lower));
  if (clash) return { field: 'label', message: tr('context.categoryExists', { label: categoryLabel(clash.id, categories) }) };
  if (!editing && categories.filter((c) => !c.builtin).length >= MAX_CUSTOM_CATEGORIES) return { field: 'form', message: tr('context.categoryLimit', { max: MAX_CUSTOM_CATEGORIES }) };
  return null;
}

export interface CategoryProblem { field: 'label' | 'description' | 'form'; message: string }
