import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiFor, type WorkspaceApi } from '../utils/api';
import { tr } from '../i18n/current';
import { useAppState } from '../store';
import {
  applyStreamEvent, chatError, checkEnded, defaultProvider, newerOf,
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

/** Requests of the chat panel: a refusal because another workspace is open is said in the chat's own words. */
function chatApi(api: WorkspaceApi): WorkspaceApi {
  const said = <T,>(request: Promise<T>): Promise<T> => request.catch((err: unknown) => { throw chatError(err, () => tr('chat.otherWorkspace')); });
  return {
    ...api,
    get: (path) => said(api.get(path)),
    post: (path, body) => said(api.post(path, body)),
    put: (path, body) => said(api.put(path, body)),
    patch: (path, body) => said(api.patch(path, body)),
    del: (path) => said(api.del(path)),
  };
}

/**
 * The workspace chat's state: the tools and their readiness, the chats of the open workspace, the chat shown and
 * its live stream. Only the chat shown is followed; the others are read again when opened.
 *
 * Every request and the stream say which workspace the panel shows, so the server refuses them when another one is
 * open (another tab switched it). An answer that arrives after the panel moved on (another workspace, another chat)
 * is dropped.
 */
export function useChat(active: boolean) {
  const { workspace } = useAppState();
  const workspacePath = workspace?.path ?? null;
  const api = useMemo(() => chatApi(apiFor(workspacePath ?? undefined)), [workspacePath]);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  /** The workspace whose tools are being checked: a check started for another one never counts for this one. */
  const [checkingFor, setCheckingFor] = useState<string | null>(null);
  const checking = checkingFor !== null && checkingFor === workspacePath;
  const [providersError, setProvidersError] = useState(false);
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [choice, setChoiceState] = useState<ChatChoice>(() => readChoice() ?? { provider: null, model: null, effort: null });
  const [limits, setLimits] = useState<Partial<Record<ChatProviderId, UsageWindow[]>>>({});
  const [loadError, setLoadError] = useState(false);
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState<{ id: string; ok: boolean } | null>(null);
  const current = useRef<Conversation | null>(null);
  /** The workspace and the chat selection the panel shows now; a response for an earlier one is dropped. */
  const scope = useRef({ workspace: workspacePath, selection: 0 });
  const still = useCallback((ws: string | null, selection?: number) =>
    scope.current.workspace === ws && (selection === undefined || scope.current.selection === selection), []);

  // Another workspace: its own chats, and the tools checked again for it. Reset while rendering, so nothing of the
  // previous workspace is shown, followed or remembered under the new one, not even for one render.
  const [shownFor, setShownFor] = useState(workspacePath);
  if (shownFor !== workspacePath) {
    setShownFor(workspacePath);
    setConversation(null);
    setList([]);
    setProviders(null);
    setProvidersError(false);
    setLimits({});
    setLoadError(false);
  }
  useLayoutEffect(() => {
    scope.current = { workspace: workspacePath, selection: scope.current.selection + 1 };
    current.current = null;
  }, [workspacePath]);

  const refreshProviders = useCallback(async (fresh = false) => {
    const ws = api.workspace ?? null;
    setCheckingFor(ws);
    try {
      const { providers: next } = await api.get<{ providers: ProviderStatus[] }>(`/api/chat/providers${fresh ? '?fresh=1' : ''}`);
      if (!still(ws)) return;
      setProviders(next);
      setProvidersError(false);
      setLimits((current) => ({ ...current, ...Object.fromEntries(next.filter((p) => p.limits).map((p) => [p.id, p.limits!])) }));
    } catch {
      if (still(ws)) setProvidersError(true);
    } finally {
      setCheckingFor((c) => checkEnded(c, ws));
    }
  }, [api, still]);

  const refreshList = useCallback(async () => {
    const ws = api.workspace ?? null;
    try {
      const { conversations } = await api.get<{ conversations: ConversationSummary[] }>('/api/chat/conversations');
      if (!still(ws)) return;
      setList(conversations);
      setLoadError(false);
    } catch {
      if (still(ws)) setLoadError(true);
    }
  }, [api, still]);

  useEffect(() => {
    if (!active || !workspacePath) return;
    if (!providers && !checking) void refreshProviders();
    void refreshList();
    const shown = readShown(workspacePath);
    if (shown && !current.current) {
      const ws = workspacePath;
      const selection = scope.current.selection;
      api.get<Conversation>(`/api/chat/conversations/${shown}`)
        .then((c) => { if (still(ws, selection) && !current.current) { setConversation(c); setChoiceState({ provider: c.provider, model: c.model, effort: c.effort }); } })
        // Deleted meanwhile, or another dashboard: a new chat it is.
        .catch(() => { if (still(ws)) saveShown(ws, null); });
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
      api.get<Conversation>(`/api/chat/conversations/${conversationId}`)
        .then((whole) => { if (!stopped) setConversation((c) => (c?.id === conversationId ? newerOf(c, whole) : c)); })
        .catch(() => undefined)
        .finally(() => { resyncing = false; });
    };
    const connect = () => {
      source = new EventSource(api.link(`/api/chat/conversations/${conversationId}/stream`));
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
  }, [active, conversationId, refreshList, api]);

  const setChoice = useCallback(async (next: ChatChoice) => {
    setChoiceState(next);
    saveChoice(next);
    if (conversation && next.provider) {
      const ws = api.workspace ?? null;
      const selection = scope.current.selection;
      const changed = await api.patch<Conversation>(`/api/chat/conversations/${conversation.id}`, next);
      if (still(ws, selection)) setConversation(changed);
    }
  }, [conversation, api, still]);

  const open = useCallback(async (id: string) => {
    const ws = api.workspace ?? null;
    const selection = ++scope.current.selection;
    try {
      const next = await api.get<Conversation>(`/api/chat/conversations/${id}`);
      if (!still(ws, selection)) return;
      setConversation(next);
      setChoiceState({ provider: next.provider, model: next.model, effort: next.effort });
      setLoadError(false);
    } catch {
      if (still(ws, selection)) setLoadError(true);
    }
  }, [api, still]);

  const startNew = useCallback(() => {
    scope.current.selection++;
    setConversation(null);
    if (workspacePath) saveShown(workspacePath, null);
  }, [workspacePath]);

  /** Sends a message; a chat is created on its first message. Throws what the server said, for the page to show. */
  const send = useCallback(async (text: string, page: string | null) => {
    if (!choice.provider) return;
    const ws = api.workspace ?? null;
    const selection = scope.current.selection;
    setSending(true);
    try {
      let target = conversation;
      if (!target) {
        target = await api.post<Conversation>('/api/chat/conversations', choice);
        // Another workspace meanwhile: the message is not sent to a chat the panel no longer shows.
        if (!still(ws)) return;
        if (still(ws, selection)) setConversation(target);
      }
      const sent = await api.post<Conversation>(`/api/chat/conversations/${target.id}/messages`, { text, ...(page ? { page } : {}) });
      if (!still(ws)) return;
      // The stream may already be ahead of this answer, even finished: what it has is kept.
      if (still(ws, selection)) setConversation((c) => newerOf(c, sent));
      void refreshList();
    } finally {
      setSending(false);
    }
  }, [choice, conversation, refreshList, api, still]);

  const stop = useCallback(async () => {
    if (!conversation) return;
    const ws = api.workspace ?? null;
    const selection = scope.current.selection;
    const stopped = await api.post<Conversation>(`/api/chat/conversations/${conversation.id}/stop`);
    if (still(ws, selection)) setConversation(stopped);
  }, [conversation, api, still]);

  const remove = useCallback(async (id: string) => {
    const ws = api.workspace ?? null;
    await api.del(`/api/chat/conversations/${id}`);
    if (!still(ws)) return;
    if (current.current?.id === id) {
      scope.current.selection++;
      setConversation(null);
      if (ws) saveShown(ws, null);
    }
    await refreshList();
  }, [refreshList, api, still]);

  return {
    workspace: workspacePath,
    providers, checking, providersError, refreshProviders,
    list, refreshList, loadError,
    conversation, open, startNew, send, stop, remove, sending,
    choice, setChoice, limits, answered,
  };
}

export type ChatState = ReturnType<typeof useChat>;
