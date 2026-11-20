import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useLanguage } from '@/i18n/LanguageProvider';
import { serverText } from '@/i18n/serverText';
import Button from '../common/Button';
import IconButton, { icons } from '../common/IconButton';
import Notice from '../common/Notice';
import LoadingSpinner from '../common/LoadingSpinner';
import MarkdownView from '../common/MarkdownView';
import { Checkbox, Textarea } from '../common/Input';
import DictateButton from '../common/DictateButton';
import { withDictation } from '../../utils/dictation';
import { useNotify } from '../../hooks/useNotify';
import type { ChatState } from '../../hooks/useChat';
import {
  CONTEXT_WARN_PERCENT, composerKey, contextPercent, errorActions, pageContext, pastChats, safeMarkdown, tightestWindow, untilText,
  type ChatMessage, type ChatProviderId, type ProviderStatus, type RunStepLike,
} from '../../utils/chat';

const INSTALL_URLS: Record<ChatProviderId, string> = {
  'claude-code': 'https://claude.com/product/claude-code',
  codex: 'https://github.com/openai/codex',
  copilot: 'https://github.com/features/copilot/cli',
};
const MAX_CHARS = 20_000;

const sendIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);
export const historyIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M2 3.5h10M2 7h10M2 10.5h6" />
  </svg>
);
const stopIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="1.5" /></svg>
);

export default function ChatConversation({ chat, composerRef, pathname, onSettings, onHistory, onReferenceOpened, references = true }: {
  chat: ChatState;
  composerRef: RefObject<HTMLTextAreaElement>;
  pathname: string;
  onSettings: () => void;
  /** Opens the list of this workspace's chats. */
  onHistory: () => void;
  /** An item named in an answer was opened from its chip, at this address. */
  onReferenceOpened?: (route: string) => void;
  /** Whether what answers name may be looked up and linked (the conversation is known to be the open workspace's). */
  references?: boolean;
}) {
  const { t, locale } = useLanguage();
  const notify = useNotify();
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [withPage, setWithPage] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const { providers, conversation, choice } = chat;
  const provider = providers?.find((p) => p.id === (conversation?.provider ?? choice.provider));
  const label = (id: ChatProviderId | undefined) => providers?.find((p) => p.id === id)?.label ?? id ?? '';
  const others = (providers ?? []).filter((p) => p.ready && p.id !== provider?.id);
  const busy = Boolean(conversation?.busy);
  const page = pageContext(pathname);
  const messages = conversation?.messages ?? [];
  // An empty chat says where the earlier ones are: the header's list icon is easy to miss. A chat opened with no
  // messages (its first send failed) is empty too.
  const earlier = messages.length ? [] : pastChats(chat.list, conversation?.id);

  // New words keep the newest in view, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [conversation?.messages]);

  useEffect(() => {
    if (chat.answered) setAnnouncement(chat.answered.ok ? t('chat.answered') : t('chat.answerFailed'));
  }, [chat.answered, t]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy || chat.sending) return;
    setSendError(null);
    try {
      await chat.send(message, withPage ? page : null);
      setDraft('');
      pinned.current = true;
    } catch (err) {
      // The message stays in the box, so nothing typed is lost.
      setSendError(err instanceof Error && err.message ? serverText(err.message) : t('chat.sendFailed'));
      if (err instanceof Error && (err as Error & { status?: number }).status === 409) void chat.refreshProviders(true);
    }
  };

  const retry = (answer: ChatMessage) => {
    const index = messages.indexOf(answer);
    const question = [...messages.slice(0, index)].reverse().find((m) => m.role === 'user');
    if (question) void send(question.text);
  };

  // A chat already open is shown at once; only sending waits for the tools to be checked.
  if (!providers && !conversation) {
    return (
      <div className="gtd-chat-body" style={{ justifyContent: 'center' }}>
        {chat.providersError
          ? <Notice tone="critical" action={<Button size="sm" onClick={() => void chat.refreshProviders(true)}>{t('chat.checkAgain')}</Button>}>{t('chat.loadFailed')}</Notice>
          : <LoadingSpinner text={t('chat.checking')} />}
      </div>
    );
  }

  if (providers && !conversation && !providers.some((p) => p.ready)) return <NoTool providers={providers} chat={chat} />;

  const context = contextPercent(conversation?.usage ?? null);
  const plan = tightestWindow(provider ? chat.limits[provider.id] ?? provider.limits : null);
  const problem = provider && !provider.ready ? provider.problems[0] : null;

  return (
    <>
      <div
        ref={body}
        className="gtd-chat-body"
        aria-label={t('chat.title')}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!messages.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-md)', fontWeight: 600 }}>{t('chat.emptyTitle')}</h3>
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{t('chat.emptyBody', { tool: provider?.label ?? '' })}</p>
            <div className="gtd-chat-suggestions">
              {[t('chat.suggestDue'), t('chat.suggestWaiting'), t('chat.suggestMeeting'), ...(page ? [t('chat.suggestPage')] : [])].map((s) => (
                <Button key={s} size="sm" onClick={() => void send(s)} disabled={!provider?.ready || chat.sending}>{s}</Button>
              ))}
            </div>
            {earlier.length > 0 && (
              <div className="gtd-chat-past">
                <span>{t('chat.pastChatsHint')}</span>
                <Button size="sm" variant="ghost" icon={historyIcon} onClick={onHistory}>{t('chat.pastChats', { count: earlier.length })}</Button>
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            tool={label(m.provider ?? conversation?.provider)}
            locale={locale}
            onReferenceOpened={onReferenceOpened}
            references={references}
            onCopy={() => {
              void navigator.clipboard?.writeText(m.text).then(() => notify.success(t('chat.copied')), () => undefined);
            }}
            actions={m.status === 'error' && m.error && m === messages[messages.length - 1] ? (
              <ErrorActions
                answer={m}
                others={others}
                busy={busy || chat.sending}
                onCheck={() => void chat.refreshProviders(true)}
                onRetry={() => retry(m)}
                onNew={() => chat.startNew()}
                onUse={(id) => void chat.setChoice({ provider: id, model: null, effort: null })}
              />
            ) : null}
          />
        ))}
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      </div>

      <div className="gtd-chat-footer">
        {problem && (
          <Notice
            tone="warning"
            title={t('chat.notReadyTitle', { tool: provider!.label })}
            action={(
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => void chat.refreshProviders(true)} loading={chat.checking}>{t('chat.checkAgain')}</Button>
                {others.slice(0, 1).map((o) => <Button key={o.id} size="sm" variant="ghost" onClick={() => void chat.setChoice({ provider: o.id, model: null, effort: null })}>{t('chat.useOther', { tool: o.label })}</Button>)}
              </div>
            )}
          >
            {serverText(problem.message)}
          </Notice>
        )}
        {context !== null && context >= CONTEXT_WARN_PERCENT && (
          <Notice tone="info" action={<Button size="sm" onClick={() => chat.startNew()}>{t('chat.startNew')}</Button>}>{t('chat.contextWarn')}</Notice>
        )}
        {sendError && <Notice tone="critical">{sendError}</Notice>}
        <div className="gtd-chat-composer">
          <Textarea
            textareaRef={composerRef}
            aria-label={t('chat.messageLabel')}
            placeholder={t('chat.placeholder')}
            value={draft}
            onChange={setDraft}
            rows={2}
            maxLength={MAX_CHARS}
            disabled={!provider?.ready}
            // The same offline dictation as other text boxes: the words are added to the message, never sent on their own.
            footer={<DictateButton fieldName={t('chat.dictateField')} onText={(text) => { setDraft((d) => withDictation(d, text)); composerRef.current?.focus(); }} />}
            onKeyDown={(e) => {
              if (composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }) !== 'send') return;
              e.preventDefault();
              void send(draft);
            }}
          />
          {busy
            ? <IconButton label={t('chat.stop')} icon={stopIcon} size="md" outline onClick={() => void chat.stop().catch((err) => notify.error(err, t('chat.sendFailed')))} />
            : <IconButton label={t('chat.send')} icon={chat.sending ? <LoadingSpinner size={14} inline /> : sendIcon} size="md" outline onClick={() => void send(draft)} disabled={!draft.trim() || chat.sending || !provider?.ready} />}
        </div>
        <div className="gtd-chat-status">
          {page && <Checkbox label={t('chat.includePage')} checked={withPage} onChange={setWithPage} />}
          <Button size="sm" variant="ghost" onClick={onSettings}>
            {[provider?.label, conversation?.model ?? choice.model].filter(Boolean).join(' · ')}
          </Button>
          {context !== null && <span>{t('chat.contextUsed', { percent: context })}</span>}
          {plan && <PlanLine window={plan} locale={locale} />}
          {provider?.notes.includes('premium_requests') && <span>{t('chat.premiumRequests')}</span>}
        </div>
      </div>
    </>
  );
}

function PlanLine({ window: w, locale }: { window: NonNullable<ReturnType<typeof tightestWindow>>; locale: string }) {
  const { t } = useLanguage();
  const name = t(w.kind === 'five_hour' ? 'chat.window.five_hour' : w.kind === 'weekly' ? 'chat.window.weekly' : 'chat.window.other');
  const when = untilText(w.resets_at, Date.now(), locale);
  const text = w.limited ? t('chat.planLimited', { window: name }) : w.used_percent !== null ? t('chat.planUsage', { percent: w.used_percent, window: name }) : null;
  if (!text) return null;
  return <span>{when ? `${text} · ${t('chat.resets', { when })}` : text}</span>;
}

function stepText(step: RunStepLike | null | undefined, t: ReturnType<typeof useLanguage>['t']): string {
  if (!step) return t('chat.thinking');
  if (step.kind === 'read') return step.path ? t('chat.step.read', { path: step.path }) : t('chat.step.readAny');
  if (step.kind === 'search') return t('chat.step.search');
  if (step.kind === 'list') return t('chat.step.list');
  if (step.kind === 'command') return t('chat.step.command');
  return t('chat.step.other');
}

function Message({ message: m, tool, locale, onCopy, actions, onReferenceOpened, references }: {
  message: ChatMessage;
  tool: string;
  locale: string;
  onReferenceOpened?: (route: string) => void;
  onCopy: () => void;
  actions: React.ReactNode;
  references: boolean;
}) {
  const { t } = useLanguage();
  if (m.role === 'notice') {
    const text = m.notice === 'restarted' ? t('chat.notice.restarted') : m.notice === 'provider_changed' ? t('chat.notice.provider_changed', { tool }) : t('chat.notice.compacted');
    return <p className="gtd-chat-notice">{text}</p>;
  }
  if (m.role === 'user') {
    return (
      <div className="gtd-chat-msg gtd-chat-msg--user">
        <span className="sr-only">{t('chat.you')}</span>
        <div className="gtd-chat-bubble">{m.text}</div>
        {m.page && <div className="gtd-chat-meta" style={{ justifyContent: 'flex-end' }}>{t('chat.onPage', { page: m.page })}</div>}
      </div>
    );
  }
  const streaming = m.status === 'streaming';
  return (
    <div className="gtd-chat-msg gtd-chat-msg--assistant" aria-busy={streaming}>
      <span className="sr-only">{tool}</span>
      {m.text && (
        <div className="gtd-chat-bubble">
          {/* Tasks, people and files it names open in one click, once the answer is complete (not on every word). */}
          <MarkdownView content={safeMarkdown(m.text)} compact references settled={!streaming && references} onReferenceOpened={onReferenceOpened} />
        </div>
      )}
      {streaming && (
        <div className="gtd-chat-meta">
          {!m.text && <span className="gtd-chat-caret" aria-hidden="true" />}
          <span>{stepText(m.last_step, t)}</span>
          {(m.steps ?? 0) > 1 && <span>· {t('chat.steps', { count: m.steps ?? 0 })}</span>}
        </div>
      )}
      {m.status === 'stopped' && <div className="gtd-chat-meta">{t('chat.stopped')}</div>}
      {m.status === 'error' && m.error && <ErrorText answer={m} tool={tool} locale={locale} />}
      {actions}
      {!streaming && m.text && (
        <div className="gtd-chat-meta">
          <IconButton label={t('chat.copy')} icon={icons.copy} onClick={onCopy} />
          {m.model && <span>{m.model}</span>}
        </div>
      )}
    </div>
  );
}

function ErrorText({ answer, tool, locale }: { answer: ChatMessage; tool: string; locale: string }) {
  const { t } = useLanguage();
  const e = answer.error!;
  const how = answer.provider === 'codex' ? t('chat.signIn.codex') : answer.provider === 'copilot' ? t('chat.signIn.copilot') : t('chat.signIn.claude-code');
  const when = untilText(e.resets_at, Date.now(), locale);
  const text = {
    sign_in: t('chat.error.sign_in', { tool, how }),
    plan_limit: `${t('chat.error.plan_limit', { tool })}${when ? ` ${t('chat.error.planResets', { when })}` : ''}`,
    context_full: t('chat.error.context_full'),
    api_billing: t('chat.error.api_billing', { tool }),
    not_trusted: t('chat.error.not_trusted', { tool }),
    crashed: t('chat.error.crashed', { tool }),
    timeout: t('chat.error.timeout'),
    resume_failed: t('chat.error.resume_failed'),
    provider: t('chat.error.provider', { tool }),
  }[e.code] ?? t('chat.error.provider', { tool });
  return (
    <Notice tone={e.code === 'plan_limit' || e.code === 'context_full' ? 'warning' : 'critical'}>
      <span style={{ display: 'block' }}>{text}</span>
      {e.detail && e.code !== 'plan_limit' && <span style={{ display: 'block', marginTop: 'var(--space-1)', color: 'var(--color-text-secondary)' }}>{t('chat.error.said', { tool, detail: e.detail })}</span>}
    </Notice>
  );
}

function ErrorActions({ answer, others, busy, onCheck, onRetry, onNew, onUse }: {
  answer: ChatMessage;
  others: ProviderStatus[];
  busy: boolean;
  onCheck: () => void;
  onRetry: () => void;
  onNew: () => void;
  onUse: (id: ChatProviderId) => void;
}) {
  const { t } = useLanguage();
  const buttons = errorActions(answer.error!.code).flatMap((action) => {
    if (action === 'check_again') return [<Button key={action} size="sm" onClick={onCheck}>{t('chat.checkAgain')}</Button>];
    if (action === 'retry') return [<Button key={action} size="sm" onClick={onRetry} disabled={busy}>{t('chat.tryAgain')}</Button>];
    if (action === 'new_chat') return [<Button key={action} size="sm" onClick={onNew}>{t('chat.startNew')}</Button>];
    return others.map((o) => <Button key={o.id} size="sm" variant="ghost" onClick={() => onUse(o.id)} disabled={busy}>{t('chat.useOther', { tool: o.label })}</Button>);
  });
  return buttons.length ? <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{buttons}</div> : null;
}

function NoTool({ providers, chat }: { providers: ProviderStatus[]; chat: ChatState }) {
  const { t } = useLanguage();
  return (
    <div className="gtd-chat-body">
      <h3 style={{ margin: 0, fontSize: 'var(--text-md)', fontWeight: 600 }}>{t('chat.noToolTitle')}</h3>
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{t('chat.noToolBody')}</p>
      {providers.map((p) => (
        <div key={p.id} className="gtd-card" style={{ padding: 'var(--space-3)', gap: 'var(--space-1)', fontSize: 'var(--text-sm)' }}>
          <strong>{p.label}</strong>
          {p.problems[0] && <span style={{ color: 'var(--color-text-secondary)' }}>{serverText(p.problems[0].message)}</span>}
          {!p.installed && <a className="gtd-link" href={INSTALL_URLS[p.id]} target="_blank" rel="noreferrer noopener">{t('chat.install', { tool: p.label })}</a>}
        </div>
      ))}
      <div>
        <Button variant="primary" onClick={() => void chat.refreshProviders(true)} loading={chat.checking}>{t('chat.checkAgain')}</Button>
      </div>
    </div>
  );
}
