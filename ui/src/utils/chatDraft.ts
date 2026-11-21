/**
 * A chat message typed but not sent, kept when the panel closes by itself (on a phone, after a context update was
 * made from the chat). It comes back only to the same workspace and the same chat, once.
 */
export interface KeptDraft {
  key: string;
  text: string;
}

/** One key per workspace and chat; a chat not started yet has its own. */
export function draftKey(workspace: string | null, conversationId: string | null | undefined): string {
  return `${workspace ?? ''}\0${conversationId ?? 'new'}`;
}

/** What to keep from the composer: nothing when it holds no words. */
export function keepDraft(current: KeptDraft | null): KeptDraft | null {
  return current && current.text.trim() ? { ...current } : null;
}

/** The kept words for this composer, or null when they belong to another workspace or chat, or the box is not empty. */
export function restoreDraft(kept: KeptDraft | null, key: string, draft: string): string | null {
  return kept && kept.key === key && !draft ? kept.text : null;
}
