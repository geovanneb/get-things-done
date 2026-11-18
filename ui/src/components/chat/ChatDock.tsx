import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useLanguage } from '@/i18n/LanguageProvider';
import IconButton, { icons } from '../common/IconButton';
import { useChat } from '../../hooks/useChat';
import ChatConversation from './ChatConversation';
import { ChatHistory, ChatSettings } from './ChatSettings';
import '../../styles/chat.css';

const OPEN_KEY = 'gtd.chat.open';
/** Room the launcher takes in the corner: toasts and the recording panel stand above it. */
const LAUNCHER_SPACE = '64px';

const chatIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z" />
    {/* The bubble's circle is centred at (13, 12): the dots sit on that centre. */}
    <path d="M9.5 12h.01M13 12h.01M16.5 12h.01" strokeWidth="2.4" />
  </svg>
);
const historyIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M2 3.5h10M2 7h10M2 10.5h6" />
  </svg>
);
const backIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.5 3 4.5 7l4 4" />
  </svg>
);
const settingsIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M2 4h6M10.5 4H12M2 10h1.5M6 10h6" />
    <circle cx="9.2" cy="4" r="1.3" />
    <circle cx="4.8" cy="10" r="1.3" />
  </svg>
);

function readOpen(): boolean {
  try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}

/**
 * The assistant chat: a button in the bottom-right corner on every page, and the panel it opens. Not a modal: the
 * page stays usable beside it (except on a phone, where it takes the screen). Escape closes it and gives focus back
 * to the button.
 */
export default function ChatDock() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(readOpen);
  const [view, setView] = useState<'chat' | 'history' | 'settings'>('chat');
  const chat = useChat(open);
  const launcherId = useId();
  const composer = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const panelId = useId();
  const { pathname } = useLocation();

  useEffect(() => {
    try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* a convenience only */ }
  }, [open]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--chat-launcher-space', LAUNCHER_SPACE);
    return () => { root.style.removeProperty('--chat-launcher-space'); };
  }, []);

  useEffect(() => {
    if (open && view === 'chat') composer.current?.focus();
  }, [open, view, chat.conversation?.id]);

  const close = () => {
    setOpen(false);
    setView('chat');
    // After the panel is gone, so the focus does not fall to the page.
    setTimeout(() => document.getElementById(launcherId)?.focus(), 0);
  };

  const busy = Boolean(chat.conversation?.busy);
  return (
    <>
      {open && (
        <section
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          className="gtd-chat-panel"
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.stopPropagation();
            if (view !== 'chat') setView('chat');
            else close();
          }}
        >
          <div className="gtd-chat-header">
            <h2 id={titleId} title={chat.conversation?.title}>
              {view === 'history' ? t('chat.history') : view === 'settings' ? t('chat.settings') : chat.conversation?.title ?? t('chat.title')}
            </h2>
            {view === 'chat' ? (
              <>
                <IconButton label={t('chat.history')} icon={historyIcon} onClick={() => setView('history')} />
                <IconButton label={t('chat.settings')} icon={settingsIcon} onClick={() => setView('settings')} />
                <IconButton label={t('chat.newChat')} icon={icons.plus} onClick={() => { chat.startNew(); composer.current?.focus(); }} disabled={!chat.conversation} />
              </>
            ) : (
              <IconButton label={t('chat.backToChat')} icon={backIcon} onClick={() => setView('chat')} />
            )}
            <IconButton label={t('chat.close')} icon={icons.close} onClick={close} />
          </div>
          {view === 'history' && <ChatHistory chat={chat} onOpen={() => setView('chat')} />}
          {view === 'settings' && <ChatSettings chat={chat} onDone={() => setView('chat')} />}
          {view === 'chat' && <ChatConversation chat={chat} composerRef={composer} pathname={pathname} onSettings={() => setView('settings')} />}
        </section>
      )}
      <IconButton
        id={launcherId}
        label={open ? t('chat.close') : t('chat.open')}
        icon={chatIcon}
        size="md"
        className={['gtd-chat-launcher', open && 'gtd-chat-launcher--open', busy && 'gtd-chat-launcher--busy'].filter(Boolean).join(' ')}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      />
    </>
  );
}
