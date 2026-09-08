import React, { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { KaizenProposal } from '../types';
import Badge from '../components/common/Badge';
import LoadingSpinner from '../components/common/LoadingSpinner';
import EmptyState from '../components/common/EmptyState';
import { formatRelativeTime } from '../utils/format';

/* ---- Status helpers -------------------------------------------------- */
const STATUS_CONFIG: Record<KaizenProposal['status'], { label: string; color: string; badgeVariant: string }> = {
  proposed: { label: 'Proposed', color: 'var(--color-warning)', badgeVariant: 'warning' },
  applied:  { label: 'Applied',  color: 'var(--color-success)', badgeVariant: 'success' },
  rejected: { label: 'Rejected', color: 'var(--color-text-muted)', badgeVariant: 'default' },
};

/* ---- Copy button ------------------------------------------------------ */
function CopyIdButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy ID for /gtd-kaizen command"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: copied ? 'color-mix(in oklch, var(--color-success) 12%, transparent)' : 'var(--color-bg)',
        color: copied ? 'var(--color-success)' : 'var(--color-text-muted)',
        fontSize: 'var(--text-xs)',
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        whiteSpace: 'nowrap',
      }}
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <path d="M2 5.5L4.5 8L9 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M1.5 7.5V1.5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          {id}
        </>
      )}
    </button>
  );
}

/* ---- Kaizen card ------------------------------------------------------ */
function KaizenCard({ proposal, onRefetch }: { proposal: KaizenProposal; onRefetch: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const cfg = STATUS_CONFIG[proposal.status] ?? STATUS_CONFIG.proposed;

  const handleReject = async () => {
    setRejecting(true);
    try {
      await fetch(`/api/kaizen/${proposal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      });
      onRefetch();
    } finally {
      setRejecting(false);
    }
  };

  return (
    <article
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: `3px solid ${cfg.color}`,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <CopyIdButton id={proposal.id} />
            <Badge variant={cfg.badgeVariant as 'warning'} size="sm">{cfg.label}</Badge>
            <span
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-accent)',
                background: 'color-mix(in oklch, var(--color-accent) 10%, transparent)',
                border: '1px solid color-mix(in oklch, var(--color-accent) 20%, transparent)',
                borderRadius: 'var(--radius-sm)',
                padding: '1px 6px',
              }}
            >
              {proposal.area}
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
              {formatRelativeTime(proposal.created_at)}
            </span>
          </div>
          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)', margin: 0 }}>
            {proposal.title}
          </h3>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-text-muted)',
            padding: 4,
            flexShrink: 0,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
            aria-hidden="true"
          >
            <path d="M3 5L7 9L11 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Summary row (always visible) */}
      <div
        style={{
          padding: '0 16px 12px',
          fontSize: 'var(--text-sm)',
          color: 'var(--color-text-secondary)',
          lineHeight: 1.5,
        }}
      >
        {proposal.root_cause.split('\n')[0]}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--color-border)',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <Section title="Root cause" body={proposal.root_cause} />
          <Section title="Proposed fix" body={proposal.proposed_fix} />

          {proposal.files_affected.length > 0 && (
            <div>
              <div style={sectionLabel}>Files affected</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {proposal.files_affected.map((f) => (
                  <code
                    key={f}
                    style={{
                      fontSize: 'var(--text-xs)',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-secondary)',
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '2px 6px',
                      display: 'inline-block',
                    }}
                  >
                    {f}
                  </code>
                ))}
              </div>
            </div>
          )}

          {proposal.applied_at && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              Applied {formatRelativeTime(proposal.applied_at)}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div
              style={{
                flex: 1,
                padding: '10px 14px',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>To apply: </span>
              /gtd-kaizen {proposal.id}
            </div>

            {proposal.status === 'proposed' && (
              <button
                onClick={handleReject}
                disabled={rejecting}
                style={{
                  padding: '6px 14px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  color: 'var(--color-text-muted)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  cursor: rejecting ? 'not-allowed' : 'pointer',
                  opacity: rejecting ? 0.5 : 1,
                  whiteSpace: 'nowrap',
                  transition: 'color 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-danger, #e53e3e)';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-danger, #e53e3e)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border)';
                }}
              >
                {rejecting ? 'Rejecting...' : 'Reject'}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 600,
  color: 'var(--color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 6,
};

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div style={sectionLabel}>{title}</div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.6, margin: 0 }}>
        {body}
      </p>
    </div>
  );
}

/* ---- Main view -------------------------------------------------------- */
export default function KaizenView() {
  const { data, loading, refetch } = useApi<KaizenProposal[]>('/api/kaizen');

  if (loading) return <LoadingSpinner text="Loading kaizen proposals..." />;
  if (!data) {
    return (
      <EmptyState
        title="No kaizen proposals"
        description="Proposals appear here when the agent self-reflects after follow-up corrections."
      />
    );
  }

  const proposed = data.filter((p) => p.status === 'proposed');
  const applied  = data.filter((p) => p.status === 'applied');
  const rejected = data.filter((p) => p.status === 'rejected');

  return (
    <div style={{ padding: 24, maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Page header */}
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, margin: 0 }}>Kaizen proposals</h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginTop: 4, marginBottom: 0 }}>
          Self-improvement proposals created after follow-up corrections. Copy an ID and run{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>/gtd-kaizen ID</code> to apply.
        </p>
      </div>

      {/* Proposed */}
      {proposed.length > 0 && (
        <section aria-labelledby="proposed-heading">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h2 id="proposed-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: 0 }}>
              Open proposals
            </h2>
            <Badge variant="warning" size="sm">{proposed.length}</Badge>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {proposed.map((p) => <KaizenCard key={p.id} proposal={p} onRefetch={refetch} />)}
          </div>
        </section>
      )}

      {/* Applied */}
      {applied.length > 0 && (
        <section aria-labelledby="applied-heading">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h2 id="applied-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: 0 }}>
              Applied
            </h2>
            <Badge variant="success" size="sm">{applied.length}</Badge>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {applied.map((p) => <KaizenCard key={p.id} proposal={p} onRefetch={refetch} />)}
          </div>
        </section>
      )}

      {/* Rejected */}
      {rejected.length > 0 && (
        <section aria-labelledby="rejected-heading">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h2 id="rejected-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: 0 }}>
              Rejected
            </h2>
            <Badge size="sm">{rejected.length}</Badge>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rejected.map((p) => <KaizenCard key={p.id} proposal={p} onRefetch={refetch} />)}
          </div>
        </section>
      )}

      {data.length === 0 && (
        <EmptyState
          title="No proposals yet"
          description="When the agent makes a mistake that requires follow-up, it will create a kaizen proposal here."
        />
      )}
    </div>
  );
}
