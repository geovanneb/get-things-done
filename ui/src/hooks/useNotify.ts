import { useMemo } from 'react';
import { useAppDispatch } from '@/store';

/**
 * Short-lived feedback after an action, shown as a toast. See docs/design-system.md, "States".
 * Use it instead of alert(): `notify.error(err, 'Could not delete the note.')`.
 */
export function useNotify() {
  const dispatch = useAppDispatch();
  return useMemo(() => {
    const add = (type: 'success' | 'error' | 'warning' | 'info', message: string) =>
      dispatch({ type: 'ADD_NOTIFICATION', payload: { type, message } });
    return {
      success: (message: string) => add('success', message),
      info: (message: string) => add('info', message),
      warning: (message: string) => add('warning', message),
      /** Shows the error's own message when it has one, the fallback otherwise. */
      error: (err: unknown, fallback: string) => add('error', err instanceof Error && err.message ? err.message : fallback),
    };
  }, [dispatch]);
}
