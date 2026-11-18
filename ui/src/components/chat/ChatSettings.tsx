import { useEffect } from 'react';
import { useLanguage } from '@/i18n/LanguageProvider';
import { serverText } from '@/i18n/serverText';
import Button from '../common/Button';
import IconButton, { icons } from '../common/IconButton';
import { Select } from '../common/Input';
import { useConfirm } from '../common/ConfirmDialog';
import { useNotify } from '../../hooks/useNotify';
import type { ChatState } from '../../hooks/useChat';
import { effortOptions, modelOptions, tightestWindow, untilText, type ChatProviderId } from '../../utils/chat';

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** An effort level in the interface language; a level the dashboard does not know is shown as the tool names it. */
function effortLabel(effort: string, t: ReturnType<typeof useLanguage>['t']): string {
  return (EFFORTS as readonly string[]).includes(effort) ? t(`chat.effort.${effort as (typeof EFFORTS)[number]}`) : effort;
}

/** The AI tool, model and effort for the chat shown (or the next new one). A change applies to the next message. */
export function ChatSettings({ chat, onDone }: { chat: ChatState; onDone: () => void }) {
  const { t, locale } = useLanguage();
  const notify = useNotify();
  const { providers, choice, conversation } = chat;
  const busy = Boolean(conversation?.busy);
  const provider = providers?.find((p) => p.id === choice.provider);
  const models = modelOptions(provider);
  const efforts = effortOptions(provider, choice.model);
  const plan = tightestWindow(provider ? chat.limits[provider.id] ?? provider.limits : null);

  const change = (next: Partial<typeof choice>) => {
    chat.setChoice({ ...choice, ...next }).catch((err) => notify.error(err, t('chat.busyElsewhere')));
  };

  return (
    <div className="gtd-chat-body">
      <Select
        label={t('chat.provider')}
        value={choice.provider ?? ''}
        disabled={busy}
        onChange={(id) => change({ provider: id as ChatProviderId, model: null, effort: null })}
        options={(providers ?? []).map((p) => ({ value: p.id, label: p.ready ? p.label : `${p.label} (${p.installed ? serverText(p.problems[0]?.message ?? '') : t('chat.install', { tool: p.label })})`, disabled: !p.ready }))}
      />
      <Select
        label={t('chat.model')}
        value={choice.model ?? ''}
        disabled={busy || !provider?.ready}
        hint={models.find((m) => m.id === choice.model)?.description ?? undefined}
        onChange={(id) => change({ model: id || null, effort: null })}
        options={[{ value: '', label: t('chat.defaultModel') }, ...models.filter((m) => !(m.is_default && m.id === 'default')).map((m) => ({ value: m.id, label: m.label }))]}
      />
      {efforts.length > 0 && (
        <Select
          label={t('chat.effort')}
          value={choice.effort ?? ''}
          disabled={busy}
          onChange={(effort) => change({ effort: effort || null })}
          options={[{ value: '', label: t('chat.defaultEffort') }, ...efforts.map((e) => ({ value: e, label: effortLabel(e, t) }))]}
        />
      )}
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
        {busy ? t('chat.busyElsewhere') : t('chat.appliesNext')}
      </p>
      {provider?.plan && <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{t('chat.planName', { plan: provider.plan })}</p>}
      {plan?.used_percent != null && (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {t('chat.planUsage', { percent: plan.used_percent, window: t(plan.kind === 'five_hour' ? 'chat.window.five_hour' : plan.kind === 'weekly' ? 'chat.window.weekly' : 'chat.window.other') })}
          {untilText(plan.resets_at, Date.now(), locale) ? ` · ${t('chat.resets', { when: untilText(plan.resets_at, Date.now(), locale)! })}` : ''}
        </p>
      )}
      {provider?.notes.includes('premium_requests') && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{t('chat.premiumRequests')}</p>}
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{t('chat.readOnly')}</p>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'auto' }}>
        <Button variant="primary" onClick={onDone}>{t('chat.backToChat')}</Button>
        <Button variant="ghost" onClick={() => void chat.refreshProviders(true)} loading={chat.checking}>{t('chat.checkAgain')}</Button>
      </div>
    </div>
  );
}

/** The chats of this workspace, newest first. */
export function ChatHistory({ chat, onOpen }: { chat: ChatState; onOpen: () => void }) {
  const { t, locale } = useLanguage();
  const confirm = useConfirm();
  const notify = useNotify();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  // Read again each time: another tab or window may have started a chat.
  const { refreshList } = chat;
  useEffect(() => { void refreshList(); }, [refreshList]);
  return (
    <div className="gtd-chat-body">
      <Button variant="primary" icon={icons.plus} onClick={() => { chat.startNew(); onOpen(); }}>{t('chat.newChat')}</Button>
      {chat.loadError && <p role="alert" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{t('chat.loadFailed')}</p>}
      {!chat.list.length && !chat.loadError && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{t('chat.historyEmpty')}</p>}
      {chat.list.map((c) => (
        <div key={c.id} className="gtd-chat-row">
          <Button variant="ghost" aria-current={chat.conversation?.id === c.id ? 'true' : undefined} onClick={() => { void chat.open(c.id).then(onOpen); }}>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, alignItems: 'flex-start' }}>
              <span className="gtd-chat-row-title" style={{ maxWidth: '100%' }}>{c.title}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontWeight: 400 }}>
                {[chat.providers?.find((p) => p.id === c.provider)?.label ?? c.provider, date.format(new Date(c.updated_at))].join(' · ')}
              </span>
            </span>
          </Button>
          <IconButton
            label={t('chat.deleteChat')}
            icon={icons.trash}
            tone="danger"
            disabled={c.busy}
            onClick={async () => {
              const ok = await confirm({ title: t('chat.deleteConfirmTitle'), message: t('chat.deleteConfirmBody'), confirmLabel: t('chat.deleteConfirm'), tone: 'danger' });
              if (ok) await chat.remove(c.id).catch((err) => notify.error(err, t('chat.loadFailed')));
            }}
          />
        </div>
      ))}
    </div>
  );
}
