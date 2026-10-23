import React, { useEffect, useState } from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Modal from '@/components/common/Modal';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import EmptyState from '@/components/common/EmptyState';
import { apiDelete, apiGet, apiPost } from '@/utils/api';
import { formatDate } from '@/utils/format';
import type { ClaudeAgent, MarketplaceSkill, Skill } from '@/types';

// ---------------------------------------------------------------------------
// Validation dot indicator
// ---------------------------------------------------------------------------

const VALIDATION_COLORS: Record<'valid' | 'warning' | 'error', string> = {
  valid: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-critical)',
};

function ValidationDot({ state }: { state: 'valid' | 'warning' | 'error' }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: VALIDATION_COLORS[state],
          flexShrink: 0,
          display: 'inline-block',
        }}
      />
      <span
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-text-secondary)',
          textTransform: 'capitalize',
        }}
      >
        {state}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small mono chip (tools, model, version)
// ---------------------------------------------------------------------------

function MonoChip({
  children,
  muted = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        backgroundColor: muted ? 'var(--color-surface-hover)' : 'var(--color-accent-subtle)',
        color: muted ? 'var(--color-text-muted)' : 'var(--color-accent)',
        borderRadius: 'var(--radius-sm)',
        padding: '2px 6px',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Raw content modal body
// ---------------------------------------------------------------------------

function RawContentBlock({ content }: { content?: string }) {
  return (
    <pre
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-sm)',
        backgroundColor: 'var(--color-bg)',
        padding: 16,
        borderRadius: 'var(--radius-md)',
        overflowX: 'auto',
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
        color: 'var(--color-text)',
        maxHeight: 480,
        lineHeight: 1.6,
      }}
    >
      <code>{content ?? '(no content available)'}</code>
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  onView,
}: {
  agent: ClaudeAgent;
  onView: () => void;
}) {
  const visibleTools = agent.tools.slice(0, 3);
  const extraTools = agent.tools.length - visibleTools.length;

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Name */}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: 'var(--text-sm)',
          color: 'var(--color-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={agent.name}
      >
        {agent.name}
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--color-text-secondary)',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: '3em',
        } as React.CSSProperties}
      >
        {agent.description || 'No description provided.'}
      </div>

      {/* Scope + Model */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Badge variant={agent.scope === 'workspace' ? 'accent-subtle' : 'muted'}>
          {agent.scope}
        </Badge>
        {agent.model && <MonoChip muted>{agent.model}</MonoChip>}
      </div>

      {/* Validation */}
      <ValidationDot state={agent.validation_state} />

      {/* Tools */}
      {agent.tools.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {visibleTools.map((tool) => (
            <MonoChip key={tool}>{tool}</MonoChip>
          ))}
          {extraTools > 0 && <MonoChip muted>+{extraTools} more</MonoChip>}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 'auto',
          paddingTop: 10,
          borderTop: '1px solid var(--color-border)',
        }}
      >
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          Modified {formatDate(agent.last_modified)}
        </span>
        <Button variant="ghost" size="sm" onClick={onView}>
          View
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills table row
// ---------------------------------------------------------------------------

function SkillRow({
  skill,
  isLast,
  onView,
  onDelete,
}: {
  skill: Skill;
  isLast: boolean;
  onView: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <tr
      style={{
        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
        backgroundColor: hovered ? 'var(--color-surface-hover)' : 'transparent',
        transition: 'background-color 0.12s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Name */}
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            fontSize: 'var(--text-sm)',
            color: 'var(--color-text)',
          }}
        >
          {skill.name}
        </span>
      </td>

      {/* Scope */}
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <Badge variant={skill.scope === 'workspace' ? 'accent-subtle' : 'muted'}>
          {skill.scope}
        </Badge>
      </td>

      {/* Version */}
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            backgroundColor: 'var(--color-surface-hover)',
            color: 'var(--color-text-muted)',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 6px',
            display: 'inline-block',
          }}
        >
          {skill.version}
        </span>
      </td>

      {/* Description */}
      <td
        style={{
          padding: '10px 12px',
          fontSize: 'var(--text-sm)',
          color: 'var(--color-text-secondary)',
          maxWidth: 180,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={skill.description}
      >
        {skill.description}
      </td>

      {/* File count */}
      <td style={{ padding: '10px 12px', textAlign: 'center' }}>
        <Badge variant="muted">{skill.file_count}</Badge>
      </td>

      {/* State */}
      <td style={{ padding: '10px 12px' }}>
        <ValidationDot state={skill.validation_state} />
      </td>

      {/* Actions */}
      <td style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" onClick={onView}>View</Button>
          <Button variant="ghost" size="sm" onClick={onDelete}
            style={{ color: 'var(--color-critical)' }}>Delete</Button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Marketplace modal
// ---------------------------------------------------------------------------

function MarketplaceModal({
  isOpen,
  onClose,
  onInstalled,
}: {
  isOpen: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [skills, setSkills] = useState<MarketplaceSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoadError(null);
    setInstallError(null);
    setLoading(true);
    apiGet<MarketplaceSkill[]>('/api/skills/marketplace')
      .then((data) => setSkills(data ?? []))
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load marketplace'))
      .finally(() => setLoading(false));
  }, [isOpen]);

  async function handleInstall(slug: string) {
    setInstalling(slug);
    setInstallError(null);
    try {
      await apiPost('/api/skills/install', { slug });
      setSkills((prev) => prev.map((s) => s.slug === slug ? { ...s, installed: true } : s));
      onInstalled();
    } catch (err: unknown) {
      setInstallError(err instanceof Error ? err.message : 'Install failed');
    } finally {
      setInstalling(null);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Skill Marketplace" size="lg">
      <div style={{ marginBottom: 12, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
        Skills from{' '}
        <a href="https://github.com/anthropics/skills" target="_blank" rel="noreferrer"
          style={{ color: 'var(--color-accent)', textDecoration: 'none' }}>
          github.com/anthropics/skills
        </a>
      </div>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
          <LoadingSpinner />
        </div>
      )}

      {loadError && (
        <p role="alert" style={{ color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{loadError}</p>
      )}

      {installError && (
        <p role="alert" style={{ color: 'var(--color-critical)', fontSize: 'var(--text-sm)', marginBottom: 8 }}>{installError}</p>
      )}

      {!loading && !loadError && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 520, overflowY: 'auto', paddingRight: 4 }}>
          {skills.map((skill) => (
            <div
              key={skill.slug}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
                    {skill.name}
                  </span>
                  {skill.installed && (
                    <span style={{
                      fontSize: 'var(--text-xs)', fontWeight: 600, padding: '1px 6px',
                      borderRadius: 9, background: 'var(--color-success-subtle, color-mix(in oklch, var(--color-success) 15%, transparent))',
                      color: 'var(--color-success)',
                    }}>
                      Installed
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  {skill.description}
                </p>
              </div>
              <div style={{ flexShrink: 0, paddingTop: 2 }}>
                {skill.installed ? (
                  <Button variant="ghost" size="sm" disabled>Installed</Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={installing === skill.slug}
                    disabled={installing !== null}
                    onClick={() => handleInstall(skill.slug)}
                  >
                    Install
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function AgentsView() {
  const [agents, setAgents] = useState<ClaudeAgent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<ClaudeAgent | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);

  async function fetchSkills() {
    const data = await apiGet<Skill[]>('/api/skills');
    setSkills(data ?? []);
  }

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const [agentsData, skillsData] = await Promise.all([
          apiGet<ClaudeAgent[]>('/api/agents'),
          apiGet<Skill[]>('/api/skills'),
        ]);
        if (!cancelled) {
          setAgents(agentsData ?? []);
          setSkills(skillsData ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load agents and skills. Please try again.');
          console.error(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => { cancelled = true; };
  }, []);

  async function handleDeleteSkill(skill: Skill) {
    const confirmed = window.confirm(`Delete skill "${skill.name}"? This removes the files from .claude/skills/`);
    if (!confirmed) return;
    try {
      await apiDelete(`/api/skills/${encodeURIComponent(skill.name)}`);
      setSkills((prev) => prev.filter((s) => s.name !== skill.name));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: 320,
        }}
      >
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message={error} />
      </div>
    );
  }

  const TABLE_HEADERS = ['Name', 'Scope', 'Version', 'Description', 'Files', 'State', ''];

  return (
    <div style={{ padding: 24 }}>
      {/* Page title */}
      <h1
        style={{
          fontSize: 'var(--text-xl)',
          fontWeight: 700,
          color: 'var(--color-text)',
          margin: '0 0 24px 0',
        }}
      >
        Agents &amp; Skills
      </h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>

        {/* Agents */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 16,
            }}
          >
            <h2
              style={{
                fontSize: 'var(--text-lg)',
                fontWeight: 600,
                color: 'var(--color-text)',
                margin: 0,
              }}
            >
              Agents
            </h2>
            <Badge variant="muted">{agents.length}</Badge>
          </div>

          {agents.length === 0 ? (
            <EmptyState message="No agents configured." />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 16,
              }}
            >
              {agents.map((agent) => (
                <AgentCard
                  key={agent.name}
                  agent={agent}
                  onView={() => setSelectedAgent(agent)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Skills */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 16,
            }}
          >
            <h2
              style={{
                fontSize: 'var(--text-lg)',
                fontWeight: 600,
                color: 'var(--color-text)',
                margin: 0,
              }}
            >
              Skills
            </h2>
            <Badge variant="muted">{skills.length}</Badge>
            <div style={{ marginLeft: 'auto' }}>
              <Button variant="primary" size="sm" onClick={() => setMarketplaceOpen(true)}>
                + Browse Marketplace
              </Button>
            </div>
          </div>

          {skills.length === 0 ? (
            <EmptyState message="No skills configured." />
          ) : (
            <div
              style={{
                backgroundColor: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-lg)',
                overflow: 'hidden',
              }}
            >
              {/* The table scrolls inside the card when the window is narrow, so every row's actions stay reachable. */}
              <div role="region" aria-label="Skills table" tabIndex={0} style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--color-border)',
                      backgroundColor: 'var(--color-bg)',
                    }}
                  >
                    {TABLE_HEADERS.map((col, i) => (
                      <th
                        key={i}
                        style={{
                          padding: '10px 12px',
                          textAlign: 'left',
                          fontWeight: 600,
                          fontSize: 'var(--text-xs)',
                          color: 'var(--color-text-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {skills.map((skill, idx) => (
                    <SkillRow
                      key={skill.name}
                      skill={skill}
                      isLast={idx === skills.length - 1}
                      onView={() => setSelectedSkill(skill)}
                      onDelete={() => handleDeleteSkill(skill)}
                    />
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Agent detail modal */}
      {selectedAgent && (
        <Modal
          isOpen
          onClose={() => setSelectedAgent(null)}
          title={selectedAgent.name}
        >
          <RawContentBlock content={selectedAgent.raw_content} />
        </Modal>
      )}

      {/* Skill detail modal */}
      {selectedSkill && (
        <Modal
          isOpen
          onClose={() => setSelectedSkill(null)}
          title={selectedSkill.name}
        >
          <RawContentBlock content={selectedSkill.raw_content} />
        </Modal>
      )}

      {/* Marketplace modal */}
      <MarketplaceModal
        isOpen={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
        onInstalled={fetchSkills}
      />
    </div>
  );
}
