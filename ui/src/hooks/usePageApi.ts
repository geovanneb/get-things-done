import { createContext, useContext, useMemo } from 'react';
import { apiFor, type WorkspaceApi } from '@/utils/api';

/** The workspace a page belongs to (an update opened from a run-finished notice), for its children's requests. */
export const PageWorkspace = createContext<string | undefined>(undefined);

/** Requests bound to the page's workspace (plain ones when it has none). */
export function usePageApi(): WorkspaceApi {
  const workspace = useContext(PageWorkspace);
  return useMemo(() => apiFor(workspace), [workspace]);
}
