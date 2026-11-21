import { useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/i18n/LanguageProvider';
import Button from '../common/Button';
import Modal, { FormActions } from '../common/Modal';
import Notice from '../common/Notice';
import Input, { Select, Textarea } from '../common/Input';
import { useNotify } from '../../hooks/useNotify';
import { useOpenAssistant } from '../../hooks/useOpenAssistant';
import { buildHandoff, type HandoffMessage } from '../../utils/chatHandoff';

const MAX_REQUEST = 4_000;

/** What the user typed and edited in a handoff, kept by the chat dock while the panel is closed. */
export interface HandoffDraft {
  request: string;
  count: number;
  /** The text as the user edited it, and the built text it started from. */
  edited: { text: string; from: string } | null;
}

/**
 * "Continue in assistant": an editable handoff of the chat that the user copies and pastes into their own assistant.
 * Nothing is sent from here and nothing goes on a command line; "Open assistant" is the header's launcher, pinned to
 * the chat's workspace. The draft lives in the dock (`draft`/`onDraft`), so the request and edits (a removed
 * sentence too) survive closing the dialog, the panel, or a visit to Settings or History.
 */
export default function ChatHandoff({ isOpen, onClose, messages, workspace, draft, onDraft }: {
  isOpen: boolean;
  onClose: () => void;
  messages: readonly HandoffMessage[];
  /** The workspace the chat belongs to: the assistant is opened there or not at all. */
  workspace: string | undefined;
  draft: HandoffDraft | undefined;
  onDraft: (draft: HandoffDraft) => void;
}) {
  const { t } = useLanguage();
  const notify = useNotify();
  const assistant = useOpenAssistant();
  const preview = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useState<HandoffDraft>(() => draft ?? { request: '', count: 1, edited: null });
  const { request, count, edited } = state;
  const update = (change: Partial<HandoffDraft>) => {
    const next = { ...state, ...change };
    setState(next);
    onDraft(next);
  };
  const setRequest = (value: string) => update({ request: value });
  const setCount = (value: number) => update({ count: value });
  const setEdited = (value: HandoffDraft['edited']) => update({ edited: value });
  const [status, setStatus] = useState<{ tone: 'success' | 'warning' | 'critical'; text: string } | null>(null);

  const built = useMemo(() => buildHandoff(messages, { request, exchanges: count }), [messages, request, count]);
  const text = edited?.text ?? built.text;
  const stale = edited !== null && edited.from !== built.text;

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setStatus({ tone: 'success', text: t('chat.handoff.copied', { tool: assistant.label }) });
      notify.success(t('chat.copied'));
    } catch {
      // The text stays in the box, selected, so the user can copy it by hand.
      preview.current?.focus();
      preview.current?.select();
      setStatus({ tone: 'critical', text: t('chat.handoff.copyFailed') });
    }
  };

  const open = async () => {
    // The launcher's own fallback would copy its command over the handoff: keep the clipboard as it is.
    // Pinned to the chat's workspace: when another tab switched the dashboard elsewhere, nothing is launched.
    const result = await assistant.open({ keepClipboard: true, workspace });
    if (result.opened) return;
    if (result.reason === 'other_workspace') setStatus({ tone: 'critical', text: t('chat.handoff.otherWorkspace', { tool: assistant.label }) });
    else setStatus({ tone: 'warning', text: t('chat.handoff.openFailed', { tool: assistant.label, command: result.command }) });
  };

  const total = built.total;
  const options = Array.from({ length: total }, (_, i) => i + 1).map((n) => ({
    value: String(n),
    label: n === total ? t('chat.handoff.all', { count: n }) : n === 1 ? t('chat.handoff.latestOnly') : t('chat.handoff.latest', { count: n }),
  }));
  const notes = [
    built.omittedMessages ? t('chat.handoff.omitted', { count: built.omittedMessages }) : null,
    built.droppedForSize ? t('chat.handoff.dropped', { count: built.droppedForSize }) : null,
    built.shortenedMessages ? t('chat.handoff.shortened', { count: built.shortenedMessages }) : null,
  ].filter((n): n is string => Boolean(n));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={t('chat.handoff.title')}
      description={t('chat.handoff.description', { tool: assistant.label })}
      footer={(
        <FormActions>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button onClick={() => void open()} loading={assistant.opening}>{t('openAssistant', { label: assistant.label })}</Button>
          <Button variant="primary" onClick={() => void copy()} disabled={!text.trim()}>{t('chat.handoff.copy')}</Button>
        </FormActions>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <Input
          label={t('chat.handoff.request')}
          value={request}
          onChange={(value) => { setRequest(value); setStatus(null); }}
          placeholder={t('chat.handoff.requestPlaceholder')}
          maxLength={MAX_REQUEST}
          autoFocus
        />
        {total > 1 && (
          <Select
            label={t('chat.handoff.exchanges')}
            value={String(Math.min(count, total))}
            onChange={(value) => { setCount(Number(value)); setStatus(null); }}
            options={options}
          />
        )}
        <Textarea
          label={t('chat.handoff.preview')}
          textareaRef={preview}
          value={text}
          onChange={(value) => { setEdited({ text: value, from: edited?.from ?? built.text }); setStatus(null); }}
          rows={12}
          mono
          hint={notes.length ? notes.join(' ') : undefined}
        />
        {stale && (
          <Notice tone="info" action={<Button size="sm" onClick={() => { setEdited(null); setStatus(null); }}>{t('chat.handoff.rebuild')}</Button>}>
            {t('chat.handoff.edited')}
          </Notice>
        )}
        <Notice tone="warning">{t('chat.handoff.review')}</Notice>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
      </div>
    </Modal>
  );
}
