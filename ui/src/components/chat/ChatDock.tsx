import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { opensDialog } from '../../utils/references';
import { PageWorkspace } from '../../hooks/usePageApi';
import { useAppState } from '../../store';
import { apiFor } from '../../utils/api';
import { canRename, conversationIdentity, referenceWorkspace, type Conversation } from '../../utils/chat';
import { useLanguage } from '@/i18n/LanguageProvider';
import IconButton, { icons } from '../common/IconButton';
import { useChat } from '../../hooks/useChat';
import ChatConversation, { historyIcon } from './ChatConversation';
import ChatTitle from './ChatTitle';
import type { HandoffDraft } from './ChatHandoff';
import { ChatHistory, ChatSettings } from './ChatSettings';
import '../../styles/chat.css';

const OPEN_KEY = 'gtd.chat.open';
/** Room the launcher takes in the corner: toasts and the recording panel stand above it. */
const LAUNCHER_SPACE = '64px';
/** Where the panel takes the whole screen (chat.css). */
const PHONE = '(max-width: 640px)';

const chatIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z" />
    {/* The bubble's circle is centred at (13, 12): the dots sit on that centre. */}
    <path d="M9.5 12h.01M13 12h.01M16.5 12h.01" strokeWidth="2.4" />
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
  const workspacePath = useAppState().workspace?.path;
  // What an answer names is looked up only in the workspace its conversation belongs to. useChat shows a chat only
  // for the workspace it was loaded for (it drops late answers after a switch); on top of that, the server must give
  // back the very conversation on screen (same id, created at the same time, same first message) for the workspace
  // the chat shows, and that workspace must still be the open one. Otherwise its references stay plain text.
  const shown = chat.conversation;
  const identity = shown ? conversationIdentity(shown) : null;
  const chatWorkspace = chat.workspace ?? null;
  const [owner, setOwner] = useState<{ identity: string; workspace: string } | null>(null);
  useEffect(() => {
    if (!identity || !shown || !chatWorkspace) return;
    let live = true;
    apiFor(chatWorkspace).get<Conversation>(`/api/chat/conversations/${encodeURIComponent(shown.id)}`)
      .then((fetched) => { if (live && conversationIdentity(fetched) === identity) setOwner({ identity, workspace: chatWorkspace }); }, () => undefined);
    return () => { live = false; };
    // Asked again only when the conversation on screen or its workspace changes, not on every streamed word.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, chatWorkspace]);
  const lookupsIn = referenceWorkspace({ shown, chatWorkspace, openWorkspace: workspacePath ?? null, confirmed: owner });
  // Handoff drafts outlive the panel (closed, or showing Settings or History), so edits and removals are not lost.
  // Kept in memory only: a reload, or closing the window, drops them.
  const [handoffDrafts] = useState(() => new Map<string, HandoffDraft>());

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

  const close = (focusLauncher = true) => {
    setOpen(false);
    setView('chat');
    // After the panel is gone, so the focus does not fall to the page.
    if (focusLauncher) setTimeout(() => document.getElementById(launcherId)?.focus(), 0);
  };

  // An item opened from an answer shows beside the panel, which stays open, on a wide screen and for a page. A dialog
  // (a task, a context note) takes the keyboard and the pointer, so the chat steps aside for it (hidden, not closed:
  // nothing in it is lost), and the dialog keeps the focus. The same chat comes back by itself when the dialog closes
  // (Escape, Close, Cancel, Save), with the focus on the chip that opened it. On a phone the panel covers the page:
  // it closes for a page, and the launcher brings it back.
  const [parked, setParked] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);
  const stepAside = (route: string) => {
    if (opensDialog(route)) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setParked(true);
    } else if (window.matchMedia?.(PHONE).matches) {
      close(false);
    }
  };
  useEffect(() => {
    if (!parked) return;
    // design-exception: reads whether a dialog is open; it does not make one.
    const dialogOpen = () => Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
    let seen = dialogOpen();
    const back = () => { refocus.current = true; setParked(false); };
    const check = () => {
      if (dialogOpen()) { seen = true; return; }
      if (seen) back();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    // The dialog never opened (the item could not be loaded): the chat comes back.
    const fallback = window.setTimeout(() => { if (!seen) back(); }, 5000);
    return () => { observer.disconnect(); window.clearTimeout(fallback); };
  }, [parked]);
  // Once the panel shows again: the chip that opened the dialog, else the message box, else the panel itself.
  useEffect(() => {
    if (parked || !refocus.current) return;
    refocus.current = false;
    const panel = document.getElementById(panelId);
    const to = [returnFocus.current, composer.current].find((el) => el && panel?.contains(el) && !(el as HTMLTextAreaElement).disabled);
    (to ?? panel)?.focus();
  }, [parked, panelId]);

  const busy = Boolean(chat.conversation?.busy);
  return (
    <>
      {open && (
        <section
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          className="gtd-chat-panel"
          hidden={parked}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.stopPropagation();
            if (view !== 'chat') setView('chat');
            else close();
          }}
        >
          <div className="gtd-chat-header">
            <ChatTitle
              // A chat opened, deleted or started anew ends a rename that was going.
              key={chat.conversation?.id ?? ''}
              chat={chat}
              titleId={titleId}
              heading={view === 'history' ? t('chat.history') : view === 'settings' ? t('chat.settings') : chat.conversation?.title ?? t('chat.title')}
              renamable={view === 'chat' && canRename(chat.conversation)}
            >
              {view === 'chat' ? (
                <>
                  <IconButton label={t('chat.history')} icon={historyIcon} onClick={() => setView('history')} />
                  <IconButton label={t('chat.settings')} icon={settingsIcon} onClick={() => setView('settings')} />
                  <IconButton label={t('chat.newChat')} icon={icons.plus} onClick={() => { chat.startNew(); composer.current?.focus(); }} disabled={!chat.conversation} />
                </>
              ) : (
                <IconButton label={t('chat.backToChat')} icon={backIcon} onClick={() => setView('chat')} />
              )}
            </ChatTitle>
            <IconButton label={t('chat.close')} icon={icons.close} onClick={() => { setParked(false); close(); }} />
          </div>
          {view === 'history' && <ChatHistory chat={chat} onOpen={() => setView('chat')} />}
          {view === 'settings' && <ChatSettings chat={chat} onDone={() => setView('chat')} />}
          {view === 'chat' && (
            // What its answers name is looked up in the conversation's own workspace and nowhere else.
            <PageWorkspace.Provider value={lookupsIn}>
              <ChatConversation key={chat.workspace ?? ''} chat={chat} composerRef={composer} pathname={pathname} onSettings={() => setView('settings')} onHistory={() => setView('history')} onReferenceOpened={stepAside} references={Boolean(lookupsIn)} handoffDrafts={handoffDrafts} />
            </PageWorkspace.Provider>
          )}
        </section>
      )}
      <IconButton
        id={launcherId}
        label={open && !parked ? t('chat.close') : t('chat.open')}
        icon={chatIcon}
        size="md"
        className={['gtd-chat-launcher', open && !parked && 'gtd-chat-launcher--open', busy && 'gtd-chat-launcher--busy'].filter(Boolean).join(' ')}
        aria-expanded={open && !parked}
        aria-controls={open ? panelId : undefined}
        onClick={() => { if (parked) setParked(false); else if (open) close(); else setOpen(true); }}
      />
    </>
  );
}
