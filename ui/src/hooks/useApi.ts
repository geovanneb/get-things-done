import { useLanguage } from '@/i18n/LanguageProvider';
import { useState, useEffect, useCallback, useRef } from 'react';

interface ApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** `workspace`: the request says it is about that workspace, and is refused when another is open (see apiFor). */
export function useApi<T>(url: string, deps: unknown[] = [], workspace?: string): ApiResult<T> {
  const { t } = useLanguage();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Once a url has loaded we refetch it quietly, so background refreshes
  // (file watcher events, mutations) never blank the view with a spinner.
  const loadedUrlRef = useRef<string | null>(null);

  const fetchData = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    if (loadedUrlRef.current !== url) setLoading(true);
    setError(null);

    try {
      const res = await fetch(url, { signal: controller.signal, headers: workspace ? { 'X-GTD-Workspace': encodeURIComponent(workspace) } : {} });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(text || `HTTP ${res.status}`);
      }
      const json = await res.json();
      if (controller.signal.aborted) return;
      setData(json);
      loadedUrlRef.current = url;
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : t('useApi.unknownError'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, workspace, ...deps, t]);

  useEffect(() => {
    fetchData();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
