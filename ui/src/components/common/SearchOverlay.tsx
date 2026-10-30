import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import Badge from './Badge';
import { SearchResult } from '../../types';
import { useRecorder } from '../recording/RecordingProvider';
import { useRecordLauncher } from '../recording/RecordLauncher';

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

const typeLabels: Record<string, string> = {
  task: 'Task',
  stakeholder: 'Stakeholder',
  context: 'Context',
  output: 'Output',
  agent: 'Agent',
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

function groupResults(results: SearchResult[]) {
  const groups: Record<string, SearchResult[]> = {};
  for (const r of results) {
    if (!groups[r.type]) groups[r.type] = [];
    groups[r.type].push(r);
  }
  return groups;
}

export default function SearchOverlay({ isOpen, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const debounceRef = useRef<number | null>(null);
  const recorder = useRecorder();
  const { openRecordDialog } = useRecordLauncher();

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.results ?? data ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  const allResults = results;

  const recordAction: QuickAction | null = recorder.status === 'recording'
    ? { id: 'stop-recording', label: 'Stop recording', hint: `Stop and save ${recorder.title}`, words: 'stop recording record meeting microphone mic audio save', run: () => void recorder.stop() }
    : recorder.active ? null
    : { id: 'record-meeting', label: 'Record a meeting', hint: 'Start recording from the microphone', words: 'record recording a meeting microphone mic audio start', run: openRecordDialog };
  const actions = recordAction && actionMatches(recordAction, query) ? [recordAction] : [];
  const itemCount = actions.length + allResults.length;

  const runAction = (action: QuickAction) => {
    onClose();
    action.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, itemCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (activeIndex < actions.length) {
        runAction(actions[activeIndex]);
        return;
      }
      const r = allResults[activeIndex - actions.length];
      if (!r) return;
      navigate(typePaths[r.type]?.(r.id) ?? r.path);
      onClose();
    }
  };

  if (!isOpen) return null;

  const groups = groupResults(results);

  return ReactDOM.createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
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
            placeholder="Search tasks, stakeholders, context..."
            aria-label="Search"
            aria-autocomplete="list"
            aria-controls="search-results"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 'var(--text-md)',
              color: 'var(--color-text)',
            }}
          />
          {loading && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
              style={{ animation: 'spin 0.7s linear infinite', color: 'var(--color-accent)', flexShrink: 0 }}>
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
                Actions
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
          {query && results.length === 0 && actions.length === 0 && !loading && (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              No results for "{query}"
            </div>
          )}
          {!query && (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              Type to search across tasks, stakeholders, context, outputs, and agents.
            </div>
          )}
          {Object.entries(groups).map(([type, items]) => {
            const startIndex = actions.length + allResults.indexOf(items[0]);
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
                  {typeLabels[type] ?? type}s
                </div>
                {items.map((r, i) => {
                  const idx = startIndex + i;
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
                        {typeLabels[r.type] ?? r.type}
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
          <span><kbd style={{ fontFamily: 'var(--font-mono)' }}>↑↓</kbd> navigate</span>
          <span><kbd style={{ fontFamily: 'var(--font-mono)' }}>↵</kbd> open or run</span>
          <span><kbd style={{ fontFamily: 'var(--font-mono)' }}>Esc</kbd> close</span>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>,
    document.body
  );
}
