const BASE_URL = '';

/** The header that says which workspace a request is about (none when not given). */
function workspaceHeader(workspace: string | undefined): Record<string, string> {
  return workspace ? { 'X-GTD-Workspace': encodeURIComponent(workspace) } : {};
}

/**
 * What to tell the user about a failed request. The server's error handler sends `{ error, message }`,
 * where `error` is only a name such as "Error" or "Bad Request"; a few routes send just `{ error }`.
 */
export function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const { message, error } = body as { message?: unknown; error?: unknown };
  if (typeof message === 'string' && message.trim()) return message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const fallback = `HTTP ${res.status}: ${res.statusText}`;
    let message = fallback;
    try {
      message = errorMessage(await res.json(), fallback);
    } catch {
      // ignore parse error
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function apiGet<T>(path: string, workspace?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...workspaceHeader(workspace) },
  });
  return handleResponse<T>(res);
}

export async function apiPost<T>(path: string, body?: unknown, workspace?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...workspaceHeader(workspace) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function apiPut<T>(path: string, body?: unknown, workspace?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...workspaceHeader(workspace) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function apiPatch<T>(path: string, body?: unknown, workspace?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...workspaceHeader(workspace) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function apiDelete(path: string, workspace?: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', ...workspaceHeader(workspace) },
  });
  await handleResponse<void>(res);
}

/**
 * Requests for a page that belongs to one workspace (an update opened from a run-finished notice): each says which, and
 * the server refuses it when another workspace is open (#246 follow-up). Bound to the page, so an operation keeps its
 * workspace even after the page closes, and no other page is affected. Without a workspace, plain requests.
 */
export interface WorkspaceApi {
  workspace: string | undefined;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** A link the page opens (a material): it carries the workspace in the address, since a link sends no header. */
  link(path: string): string;
}

export function apiFor(workspace?: string): WorkspaceApi {
  return {
    workspace,
    get: (path) => apiGet(path, workspace),
    post: (path, body) => apiPost(path, body, workspace),
    put: (path, body) => apiPut(path, body, workspace),
    patch: (path, body) => apiPatch(path, body, workspace),
    del: (path) => apiDelete(path, workspace),
    link: (path) => (workspace ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspace)}` : path),
  };
}
