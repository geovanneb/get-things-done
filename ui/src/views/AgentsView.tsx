import React, { useEffect, useState } from 'react';
import Card, { CardGrid } from '@/components/common/Card';
import IconButton, { icons } from '@/components/common/IconButton';
import Notice from '@/components/common/Notice';
import Page, { PageHeader, Section } from '@/components/common/Page';
import { CountBadge } from '@/components/common/Tabs';
import { useNotify } from '@/hooks/useNotify';
import { useConfirm } from '@/components/common/ConfirmDialog';
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
    <Card as="article" padding="compact"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Modified {formatDate(agent.last_modified)}</span>
          <Button variant="ghost" size="sm" onClick={onView} aria-label={`View ${agent.name}`}>View</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', overflowWrap: 'anywhere' }}>
        <h3 title={agent.name} className="truncate" style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>
          <button type="button" onClick={onView} className="gtd-link-strong">{agent.name}</button>
        </h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-normal)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '3em' } as React.CSSProperties}>
          {agent.description || 'No description provided.'}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Badge variant={agent.scope === 'workspace' ? 'accent-subtle' : 'muted'}>{agent.scope}</Badge>
          {agent.model && <MonoChip muted>{agent.model}</MonoChip>}
          <ValidationDot state={agent.validation_state} />
        </div>
        {agent.tools.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} aria-label="Tools">
            {visibleTools.map((tool) => <MonoChip key={tool}>{tool}</MonoChip>)}
            {extraTools > 0 && <MonoChip muted>+{extraTools} more</MonoChip>}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Skills table row
// ---------------------------------------------------------------------------

function SkillRow({
  skill,
  onView,
  onDelete,
}: {
  skill: Skill;
  onView: () => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" onClick={onView} className="gtd-link-strong" style={{ fontFamily: 'var(--font-mono)' }}>{skill.name}</button>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <Badge variant={skill.scope === 'workspace' ? 'accent-subtle' : 'muted'}>{skill.scope}</Badge>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}><MonoChip muted>{skill.version}</MonoChip></td>
      <td title={skill.description} style={{ maxWidth: 320, color: 'var(--color-text-secondary)' }}>
        <span className="truncate" style={{ display: 'block' }}>{skill.description}</span>
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{skill.file_count}</td>
      <td><ValidationDot state={skill.validation_state} /></td>
      <td style={{ textAlign: 'right' }}>
        <IconButton label={`Delete ${skill.name}`} icon={icons.trash} tone="danger" onClick={onDelete} />
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
    <Modal isOpen={isOpen} onClose={onClose} title="Skill marketplace" size="lg"
      description={<>Skills from <a href="https://github.com/anthropics/skills" target="_blank" rel="noreferrer" className="gtd-link">github.com/anthropics/skills</a>. Installing copies a skill into your workspace.</>}>
      {loading && <LoadingSpinner text="Loading the marketplace…" />}

      {loadError && <Notice tone="critical" title="Could not load the marketplace.">{loadError}</Notice>}

      {installError && <Notice tone="critical" title="The skill was not installed." style={{ marginBottom: 'var(--space-2)' }}>{installError}</Notice>}

      {!loading && !loadError && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
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
                  {skill.installed && <Badge variant="success" size="sm">Installed</Badge>}
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
  const confirm = useConfirm();
  const notify = useNotify();
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
    const confirmed = await confirm({ title: `Delete the skill "${skill.name}"?`, message: 'Its files are removed from .claude/skills/. Agents can no longer use it.', confirmLabel: 'Delete skill', tone: 'danger' });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/skills/${encodeURIComponent(skill.name)}`);
      setSkills((prev) => prev.filter((s) => s.name !== skill.name));
    } catch (err: unknown) {
      notify.error(err, 'Could not delete the skill. Try again.');
    }
  }

  if (loading) return <LoadingSpinner text="Loading agents and skills…" />;

  if (error) {
    return (
      <Page>
        <Notice tone="critical" title="Could not load agents and skills.">{error}</Notice>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader description="Agents do the work on your tasks; skills are the frameworks they follow. Both live in your workspace's .claude folder." />

      <Section id="agents" title={<>Agents <CountBadge count={agents.length} /></>}>
        {agents.length === 0 ? (
          <Card><EmptyState size="compact" title="No agents yet" description="Agents are Markdown files in .claude/agents/ in your workspace." /></Card>
        ) : (
          <CardGrid>
            {agents.map((agent) => <AgentCard key={agent.name} agent={agent} onView={() => setSelectedAgent(agent)} />)}
          </CardGrid>
        )}
      </Section>

      <Section id="skills" title={<>Skills <CountBadge count={skills.length} /></>}
        actions={<Button variant="secondary" onClick={() => setMarketplaceOpen(true)}>Browse marketplace</Button>}>
        {skills.length === 0 ? (
          <Card>
            <EmptyState size="compact" title="No skills yet" description="Install a skill from the marketplace, or add one to .claude/skills/."
              action={{ label: 'Browse marketplace', onClick: () => setMarketplaceOpen(true) }} />
          </Card>
        ) : (
          <div className="gtd-card">
            {/* The table scrolls inside the card when the window is narrow, so every row's actions stay reachable. */}
            <div role="region" aria-label="Skills" tabIndex={0} className="gtd-table-wrap">
              <table className="gtd-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Version</th>
                    <th scope="col">Description</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Files</th>
                    <th scope="col">State</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map((skill) => (
                    <SkillRow key={skill.name} skill={skill} onView={() => setSelectedSkill(skill)} onDelete={() => handleDeleteSkill(skill)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      {/* Agent detail modal */}
      {selectedAgent && (
        <Modal isOpen size="xl" onClose={() => setSelectedAgent(null)} title={selectedAgent.name}>
          <RawContentBlock content={selectedAgent.raw_content} />
        </Modal>
      )}

      {/* Skill detail modal */}
      {selectedSkill && (
        <Modal isOpen size="xl" onClose={() => setSelectedSkill(null)} title={selectedSkill.name}>
          <RawContentBlock content={selectedSkill.raw_content} />
        </Modal>
      )}

      {/* Marketplace modal */}
      <MarketplaceModal
        isOpen={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
        onInstalled={fetchSkills}
      />
    </Page>
  );
}
