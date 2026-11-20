import { useId, useState } from 'react';
import { useLanguage } from '@/i18n/LanguageProvider';
import Button from '../common/Button';
import IconButton, { icons } from '../common/IconButton';
import Input from '../common/Input';
import type { ChatState } from '../../hooks/useChat';
import { CHAT_NAME_MAX, chatName, nameEnter, nameKey, renameProblem } from '../../utils/chat';

/**
 * The chat panel's heading, and the chat's name to change: a chat is named after its first message, which does not
 * always say what it was about. Enter saves, Escape cancels; focus goes back to the rename button either way.
 * The heading stays (hidden while renaming), so the panel keeps its name for screen readers.
 */
export default function ChatTitle({ chat, titleId, heading, renamable, children }: {
  chat: ChatState;
  titleId: string;
  heading: string;
  /** The chat view with a chat that has a message from the user: the name can be changed. */
  renamable: boolean;
  /** The header's other buttons, set aside while renaming to give the name room. */
  children?: React.ReactNode;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const renameId = useId();
  const editing = renamable && draft !== null;

  const end = () => {
    setDraft(null);
    setError(null);
    // After the box is gone, so the focus does not fall to the page.
    setTimeout(() => document.getElementById(renameId)?.focus(), 0);
  };

  const save = async () => {
    if (draft === null || saving) return;
    const name = chatName(draft);
    if (!name) { setError(t('chat.nameEmpty')); return; }
    if (name === chat.conversation?.title) { end(); return; }
    setSaving(true);
    try {
      await chat.rename(name);
      end();
    } catch (err) {
      // The box stays open with what was typed, so nothing is lost.
      const problem = renameProblem(err);
      setError(problem === 'busy' ? t('chat.busyElsewhere') : problem === 'other_workspace' ? (err as Error).message : t('chat.renameFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2 id={titleId} title={editing ? undefined : chat.conversation?.title} className={editing ? 'sr-only' : undefined}>{heading}</h2>
      {editing ? (
        <form
          className="gtd-chat-rename"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Escape belongs to the rename, never to the panel, even while it only drops Japanese input.
            e.stopPropagation();
            if (nameKey({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }) === 'cancel' && !saving) end();
          }}
        >
          <Input
            aria-label={t('chat.nameLabel')}
            size="sm"
            value={draft}
            onChange={(value) => { setDraft(value); setError(null); }}
            maxLength={CHAT_NAME_MAX}
            autoFocus
            error={error ?? undefined}
            style={{ flex: 1, minWidth: 0 }}
            onKeyDown={(e) => {
              // Enter is handled here, not by the form, so the Enter that confirms Japanese input never saves.
              nameEnter({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode, preventDefault: () => e.preventDefault() }, () => void save());
            }}
          />
          <Button type="submit" size="sm" variant="primary" loading={saving}>{t('chat.saveName')}</Button>
          <Button size="sm" variant="ghost" onClick={end} disabled={saving}>{t('cancel')}</Button>
        </form>
      ) : (
        <>
          {renamable && (
            <IconButton
              id={renameId}
              label={t('chat.rename')}
              icon={icons.edit}
              // The server refuses a change while the assistant answers.
              disabled={Boolean(chat.conversation?.busy)}
              onClick={() => { setError(null); setDraft(chat.conversation?.title ?? ''); }}
            />
          )}
          {children}
        </>
      )}
    </>
  );
}
