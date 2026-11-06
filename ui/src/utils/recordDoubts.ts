import { tr } from '@/i18n/current';
import type { RecordDoubt } from '@/types';

/** How each field is named where the record card shows it. */
export const DOUBT_FIELD_LABELS = (): Record<RecordDoubt['field'], string> => ({
  title: tr('importUpdateModal.title'),
  meeting_date: tr('updateDetail.date'),
  attendees: tr('updateDetail.attendees2'),
  speakers: tr('updateDetail.speakers2'),
  decisions: tr('updateDetail.decisions'),
  open_questions: tr('updateDetail.openQuestions'),
  action_items: tr('updateDetail.actionItems'),
});

/** Scripts written without spaces between words: there a doubt matches wherever its text appears. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` holds `value` as whole words (any case): "ARC" is not in "March", "Dough" is in "Jane Dough". */
function holds(text: string, value: string): boolean {
  if (NO_SPACES.test(value)) return text.toLowerCase().includes(value.toLowerCase());
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * The doubts about one piece of the record: a name or text that holds the doubted words as whole words (a surname
 * in a full name, a carrier in a decision). Case is ignored; nothing is matched on an empty value.
 */
export function doubtsAbout(doubts: RecordDoubt[] | undefined, field: RecordDoubt['field'], text: string): RecordDoubt[] {
  if (!text.trim()) return [];
  return (doubts ?? []).filter((d) => d.field === field && d.value.trim() !== '' && holds(text, d.value.trim()));
}

/** One line for a doubt, as the record card lists it: the text, why, and what it may be instead. */
export function doubtLine(d: RecordDoubt): string {
  return `${DOUBT_FIELD_LABELS()[d.field]}: "${d.value}". ${d.reason}${d.suggestion ? tr('recordDoubts.maybe', { suggestion: d.suggestion }) : ''}`;
}
