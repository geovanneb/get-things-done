import type { PlainMessageKey } from '../../../../server/src/i18n/messages';
import { useLanguage } from '@/i18n/LanguageProvider';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import Badge from './Badge';
import Notice from './Notice';
import { SearchResult } from '../../types';
import { arrangeResults, clampIndex, latestOnly } from '../../utils/searchResults';
import { useRecorder } from '../recording/RecordingProvider';
import { useRecordLauncher } from '../recording/RecordLauncher';

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

const typeLabels: Record<string, PlainMessageKey> = {
  task: 'task',
  stakeholder: 'resultStakeholder',
  context: 'context',
  output: 'resultOutput',
  agent: 'resultAgent',
};

// A group heading is its own word in each language, never a singular plus "s".
const groupLabels: Record<string, PlainMessageKey> = {
  task: 'tasks',
  stakeholder: 'stakeholders',
  context: 'resultContexts',
  output: 'resultOutputs',
  agent: 'resultAgents',
};

const typePaths: Record<string, (id: string) => string> = {
  task: (id) => `/board/task/${id}`,
  stakeholder: (id) => `/stakeholders/${id}`,
  context: () => `/context`,
  output: () => `/outputs`,
  agent: () => `/agents`,
};

const typeBadgeVariant = (type: string): 'accent' | 'info' | 'success' | 'warning' | 'default' => {
  const map: Record<string, 'accent' | 'info' | 'success' | 'warning' | 'default'> = {
    task: 'accent',
    stakeholder: 'info',
    context: 'success',
    output: 'warning',
    agent: 'default',
  };
  return map[type] ?? 'default';
};

/** Something to do rather than a file to open. Shown above the results, when the query fits its words. */
interface QuickAction {
  id: string;
  label: string;
  hint: string;
  words: string;
  run: () => void;
}

/** Every word typed starts one of the action's words, so "rec", "mic" or "stop rec" all find it. */
function actionMatches(action: QuickAction, query: string): boolean {
  const words = action.words.split(' ');
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).every((q) => words.some((w) => w.startsWith(q)));
}

export default function SearchOverlay({ isOpen, onClose }: SearchOverlayProps) {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const debounceRef = useRef<number | null>(null);
  const latestRef = useRef(latestOnly());
  const recorder = useRecorder();
  const { openRecordDialog } = useRecordLauncher();

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setFailed(false);
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const search = useCallback(async (q: string) => {
    const latest = latestRef.current;
    const id = latest.start();
    setLoading(true);
    let found: SearchResult[] | null = null;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        found = data.results ?? data ?? [];
      }
    } catch {
      // Shown below as a failed search.
    }
    // A slower answer to an earlier query never replaces a newer one.
    if (!latest.isLatest(id)) return;
    setLoading(false);
    setResults(found ?? []);
    setFailed(found === null);
  }, []);

  useEffect(() => {
    // Any search still on its way is for an older query, or for an overlay that has closed: drop it now, not after the
    // debounce, so its answer can never fill the list.
    const latest = latestRef.current;
    latest.cancel();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!isOpen || !query.trim()) {
      setResults([]);
      setFailed(false);
      setLoading(false);
      return;
    }
    // Results already displayed also belong to the previous query: Enter must not open them during the debounce.
    setResults([]);
    setFailed(false);
    setLoading(true);
    debounceRef.current = window.setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      latest.cancel();
    };
  }, [query, isOpen, search]);

  // Rows are grouped by type, so the highlight, the mouse and Enter all use the displayed order.
  const { groups, ordered } = arrangeResults(results);

  const recordAction: QuickAction | null = recorder.status === 'recording'
    ? { id: 'stop-recording', label: t('stopRecording'), hint: t('stopAndSave', { title: recorder.title }), words: 'stop recording record meeting microphone mic audio save', run: () => void recorder.stop() }
    : recorder.active ? null
    : { id: 'record-meeting', label: t('recordMeeting'), hint: t('recordFromMic'), words: 'record recording a meeting microphone mic audio start', run: openRecordDialog };
  const actions = recordAction && actionMatches(recordAction, query) ? [recordAction] : [];
  const itemCount = actions.length + ordered.length;

  useEffect(() => {
    setActiveIndex((i) => clampIndex(i, itemCount));
  }, [itemCount]);

  const runAction = (action: QuickAction) => {
    onClose();
    action.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => clampIndex(i + 1, itemCount));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (activeIndex < actions.length) {
        runAction(actions[activeIndex]);
        return;
      }
      const r = ordered[activeIndex - actions.length];
      if (!r) return;
      navigate(typePaths[r.type]?.(r.id) ?? r.path);
      onClose();
    }
  };

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('searchLabel')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-command)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '10vh',
      }}
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(3px)' }}
      />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: 640,
          maxWidth: 'calc(100vw - 32px)',
          background: 'var(--color-surface)',
          borderRadius: 'var(--radius-xl)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '70vh',
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"
            style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12 12L15.5 15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')}
            aria-autocomplete="list"
            aria-controls="search-results"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              // design-exception: the palette's only field, focused whenever it is open; the open palette is the indicator
              outline: 'none',
              fontSize: 'var(--text-md)',
              color: 'var(--color-text)',
            }}
          />
          {loading && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
              className="gtd-spin" style={{ color: 'var(--color-accent)', flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" stroke="var(--color-border)" strokeWidth="3" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          <kbd
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-muted)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 6px',
            }}
          >
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div id="search-results" role="listbox" style={{ overflowY: 'auto', flex: 1 }}>
          {actions.length > 0 && (
            <div>
              <div style={{ padding: '8px 16px 4px', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('actions')}
              </div>
              {actions.map((action, idx) => (
                <button key={action.id} role="option" aria-selected={idx === activeIndex}
                  onClick={() => runAction(action)} onMouseEnter={() => setActiveIndex(idx)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 16px', textAlign: 'left', background: idx === activeIndex ? 'var(--color-surface-hover)' : 'transparent', border: 'none', cursor: 'pointer', transition: 'background 0.1s' }}>
                  <span aria-hidden="true" style={{ display: 'inline-flex', width: 18, justifyContent: 'center', color: action.id === 'stop-recording' ? 'var(--color-critical)' : 'var(--color-text-secondary)' }}>●</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)' }}>{action.label}</span>
                    <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 2 }} className="truncate">{action.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {query && failed && !loading && (
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <Notice tone="critical">{t('searchFailed')}</Notice>
            </div>
          )}
          {query && !failed && results.length === 0 && actions.length === 0 && !loading && (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              {t('noResultsFor', { query })}
            </div>
          )}
          {!query && (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              {t('searchHint')}
            </div>
          )}
          {groups.map(({ type, items }) => {
            return (
              <div key={type}>
                <div style={{
                  padding: '8px 16px 4px',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}>
                  {groupLabels[type] ? t(groupLabels[type]) : type}
                </div>
                {items.map(({ result: r, index }) => {
                  const idx = actions.length + index;
                  const isActive = idx === activeIndex;
                  return (
                    <button
                      key={r.id}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => {
                        navigate(typePaths[r.type]?.(r.id) ?? r.path);
                        onClose();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        width: '100%',
                        padding: '8px 16px',
                        textAlign: 'left',
                        background: isActive ? 'var(--color-surface-hover)' : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <Badge variant={typeBadgeVariant(r.type)} size="sm">
                        {typeLabels[r.type] ? t(typeLabels[r.type]) : r.type}
                      </Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)' }} className="truncate">
                          {r.title}
                        </div>
                        {r.excerpt && (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 2 }} className="truncate">
                            {r.excerpt}
                          </div>
                        )}
                      </div>
                      {r.status && (
                        <Badge variant={`status-${r.status}` as 'status-done'} size="sm">
                          {r.status}
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex',
          gap: 16,
          padding: '8px 16px',
          borderTop: '1px solid var(--color-border)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-text-muted)',
        }}>
          <span><kbd style={{ fontFamily: 'var(--font-mono)' }}>↑↓</kbd> {t('navigateKey')}</span>
          <span><kbd style={{ fontFamily: 'var(--font-mono)' }}>↵</kbd> {t('openOrRun')}</span>
          <span><kbd style={{ fontFamily: 'var(--font-mono)' }}>Esc</kbd> {t('closeKey')}</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
