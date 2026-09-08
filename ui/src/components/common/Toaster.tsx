import React from 'react';
import ReactDOM from 'react-dom';
import { useAppState, useAppDispatch } from '../../store';

const AUTO_DISMISS_MS = 4000;

const ACCENT: Record<string, string> = {
  success: 'var(--color-success)',
  error: 'var(--color-critical)',
  warning: 'var(--color-warning)',
  info: 'var(--color-accent)',
};

function Toast({ id, type, message }: { id: string; type: string; message: string }) {
  const dispatch = useAppDispatch();

  React.useEffect(() => {
    const timer = setTimeout(() => {
      dispatch({ type: 'REMOVE_NOTIFICATION', payload: id });
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [id, dispatch]);

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        minWidth: 260,
        maxWidth: 380,
        padding: '10px 12px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: `3px solid ${ACCENT[type] ?? ACCENT['info']}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 8px 24px oklch(0.1 0 0 / 0.18)',
        pointerEvents: 'auto',
      }}
    >
      <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--color-text)', lineHeight: 1.45 }}>
        {message}
      </span>
      <button
        onClick={() => dispatch({ type: 'REMOVE_NOTIFICATION', payload: id })}
        aria-label="Dismiss"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          flexShrink: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--color-text-muted)',
          padding: 0,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export default function Toaster() {
  const { notifications } = useAppState();

  if (notifications.length === 0) return null;

  return ReactDOM.createPortal(
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {notifications.map((n) => (
        <Toast key={n.id} id={n.id} type={n.type} message={n.message} />
      ))}
    </div>,
    document.body
  );
}
