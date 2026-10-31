import { useCallback, useEffect } from 'react';
import { useAppDispatch, useAppState } from '@/store';
import { apiGet, apiPut } from '@/utils/api';
import { DEFAULT_SIDEBAR, type SidebarPrefs } from '@/components/layout/navGroups';

/** Loads the sidebar preferences of the open workspace, again whenever another workspace opens. */
export function useLoadSidebar(): void {
  const dispatch = useAppDispatch();
  const workspacePath = useAppState().workspace?.path;
  useEffect(() => {
    if (!workspacePath) return;
    let current = true;
    apiGet<SidebarPrefs>('/api/workspace/sidebar')
      .then((prefs) => { if (current) dispatch({ type: 'SET_SIDEBAR', payload: prefs }); })
      .catch(() => { if (current) dispatch({ type: 'SET_SIDEBAR', payload: DEFAULT_SIDEBAR }); });
    return () => { current = false; };
  }, [workspacePath, dispatch]);
}

/** Shows a change at once and saves it to the workspace. A failed save reloads what is really saved. */
export function useSaveSidebar(): (next: SidebarPrefs) => void {
  const dispatch = useAppDispatch();
  return useCallback((next: SidebarPrefs) => {
    dispatch({ type: 'SET_SIDEBAR', payload: next });
    apiPut('/api/workspace/sidebar', next).catch(() => {
      dispatch({ type: 'ADD_NOTIFICATION', payload: { type: 'error', message: 'Could not save the sidebar order.' } });
      apiGet<SidebarPrefs>('/api/workspace/sidebar')
        .then((saved) => dispatch({ type: 'SET_SIDEBAR', payload: saved }))
        .catch(() => undefined);
    });
  }, [dispatch]);
}
