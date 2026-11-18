import { useCallback, useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../utils/api';
import { useAppState } from '../store';
import {
  applyStreamEvent, defaultProvider,
  type ChatProviderId, type ChatStreamEvent, type Conversation, type ConversationSummary, type ProviderStatus, type UsageWindow,
} from '../utils/chat';

export interface ChatChoice { provider: ChatProviderId | null; model: string | null; effort: string | null }

const CHOICE_KEY = 'gtd.chat.choice';
/** The chat shown in this browser tab, per workspace: a reload opens it again. */
const SHOWN_KEY = 'gtd.chat.shown';

function readShown(workspace: string): string | null {
  try { return (JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? '{}') as Record<string, string>)[workspace] ?? null; } catch { return null; }
}

function saveShown(workspace: string, id: string | null): void {
  try {
    const all = JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? '{}') as Record<string, string>;
    if (id) all[workspace] = id; else delete all[workspace];
    sessionStorage.setItem(SHOWN_KEY, JSON.stringify(all));
  } catch { /* a convenience only */ }
}

function readChoice(): ChatChoice | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null') as ChatChoice | null;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function saveChoice(choice: ChatChoice): void {
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify(choice)); } catch { /* a convenience only */ }
}

/**
 * The workspace chat's state: the tools and their readiness, the chats of the open workspace, the chat shown and
 * its live stream. Only the chat shown is followed; the others are read again when opened.
 */
export function useChat(active: boolean) {
  const { workspace } = useAppState();
  const workspacePath = workspace?.path ?? null;
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [providersError, setProvidersError] = useState(false);
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [choice, setChoiceState] = useState<ChatChoice>(() => readChoice() ?? { provider: null, model: null, effort: null });
  const [limits, setLimits] = useState<Partial<Record<ChatProviderId, UsageWindow[]>>>({});
  const [loadError, setLoadError] = useState(false);
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState<{ id: string; ok: boolean } | null>(null);
  const current = useRef<Conversation | null>(null);

  const refreshProviders = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      const { providers: next } = await apiGet<{ providers: ProviderStatus[] }>(`/api/chat/providers${fresh ? '?fresh=1' : ''}`);
      setProviders(next);
      setProvidersError(false);
      setLimits((current) => ({ ...current, ...Object.fromEntries(next.filter((p) => p.limits).map((p) => [p.id, p.limits!])) }));
    } catch {
      setProvidersError(true);
    } finally {
      setChecking(false);
    }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setList((await apiGet<{ conversations: ConversationSummary[] }>('/api/chat/conversations')).conversations);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  // Another workspace: its own chats, and the tools checked again for it.
  useEffect(() => {
    setConversation(null);
    setList([]);
    setProviders(null);
  }, [workspacePath]);

  useEffect(() => {
    if (!active || !workspacePath) return;
    if (!providers && !checking) void refreshProviders();
    void refreshList();
    const shown = readShown(workspacePath);
    if (shown && !current.current) {
      apiGet<Conversation>(`/api/chat/conversations/${shown}`)
        .then((c) => { if (!current.current) { setConversation(c); setChoiceState({ provider: c.provider, model: c.model, effort: c.effort }); } })
        // Deleted meanwhile, or another dashboard: a new chat it is.
        .catch(() => saveShown(workspacePath, null));
    }
    // Only when the panel opens or the workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspacePath]);

  // The chosen tool when none is chosen yet or it is no longer installed.
  useEffect(() => {
    if (!providers) return;
    const current = providers.find((p) => p.id === choice.provider);
    if (current?.installed) return;
    const pick = defaultProvider(providers, workspace?.ai_tools ?? [], choice.provider);
    if (pick) setChoiceState({ provider: pick, model: null, effort: null });
  }, [providers, choice.provider, workspace?.ai_tools]);

  // The chat shown is followed live while the panel is open.
  const conversationId = conversation?.id ?? null;
  useEffect(() => { current.current = conversation; if (workspacePath && conversation) saveShown(workspacePath, conversation.id); }, [conversation, workspacePath]);
  useEffect(() => {
    if (!active || !conversationId) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let resyncing = false;
    // Words for an answer the page does not have yet (they came before the send was answered): read it all once.
    const resync = () => {
      if (resyncing) return;
      resyncing = true;
      apiGet<Conversation>(`/api/chat/conversations/${conversationId}`)
        .then((whole) => { if (!stopped) setConversation((c) => (c?.id === conversationId ? whole : c)); })
        .catch(() => undefined)
        .finally(() => { resyncing = false; });
    };
    const connect = () => {
      source = new EventSource(`/api/chat/conversations/${conversationId}/stream`);
      source.onmessage = (message) => {
        let event: ChatStreamEvent;
        try { event = JSON.parse(message.data as string) as ChatStreamEvent; } catch { return; }
        const before = current.current?.id === conversationId ? current.current : null;
        if (event.type === 'limits') setLimits((l) => ({ ...l, [event.provider]: event.windows }));
        if (event.type === 'conversation' && before?.busy && !event.conversation.busy) {
          const last = event.conversation.messages[event.conversation.messages.length - 1];
          setAnswered({ id: last?.id ?? '', ok: last?.status === 'done' });
          void refreshList();
        }
        if ((event.type === 'text' || event.type === 'step') && !before?.messages.some((m) => m.id === event.message_id)) { resync(); return; }
        setConversation((c) => {
          const mine = c?.id === conversationId ? c : null;
          if (event.type === 'deleted') return mine ? null : c;
          return applyStreamEvent(mine, event) ?? c;
        });
      };
      source.onerror = () => {
        // The browser retries on its own; once it gives up, a new stream starts with the whole conversation.
        if (stopped || source?.readyState !== EventSource.CLOSED) return;
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [active, conversationId, refreshList]);

  const setChoice = useCallback(async (next: ChatChoice) => {
    setChoiceState(next);
    saveChoice(next);
    if (conversation && next.provider) {
      setConversation(await apiPatch<Conversation>(`/api/chat/conversations/${conversation.id}`, next));
    }
  }, [conversation]);

  const open = useCallback(async (id: string) => {
    try {
      const next = await apiGet<Conversation>(`/api/chat/conversations/${id}`);
      setConversation(next);
      setChoiceState({ provider: next.provider, model: next.model, effort: next.effort });
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  const startNew = useCallback(() => {
    setConversation(null);
    if (workspacePath) saveShown(workspacePath, null);
  }, [workspacePath]);

  /** Sends a message; a chat is created on its first message. Throws what the server said, for the page to show. */
  const send = useCallback(async (text: string, page: string | null) => {
    if (!choice.provider) return;
    setSending(true);
    try {
      let target = conversation;
      if (!target) target = await apiPost<Conversation>('/api/chat/conversations', choice);
      setConversation(target);
      const sent = await apiPost<Conversation>(`/api/chat/conversations/${target.id}/messages`, { text, ...(page ? { page } : {}) });
      // The stream may already be ahead of this answer: what it has is kept.
      setConversation((c) => (c?.id === sent.id && c.messages.length > sent.messages.length ? c : sent));
      void refreshList();
    } finally {
      setSending(false);
    }
  }, [choice, conversation, refreshList]);

  const stop = useCallback(async () => {
    if (!conversation) return;
    setConversation(await apiPost<Conversation>(`/api/chat/conversations/${conversation.id}/stop`));
  }, [conversation]);

  const remove = useCallback(async (id: string) => {
    await apiDelete(`/api/chat/conversations/${id}`);
    if (conversation?.id === id) { setConversation(null); if (workspacePath) saveShown(workspacePath, null); }
    await refreshList();
  }, [conversation, refreshList, workspacePath]);

  return {
    providers, checking, providersError, refreshProviders,
    list, refreshList, loadError,
    conversation, open, startNew, send, stop, remove, sending,
    choice, setChoice, limits, answered,
  };
}

export type ChatState = ReturnType<typeof useChat>;
