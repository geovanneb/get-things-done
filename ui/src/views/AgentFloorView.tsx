import { currentLocale } from '@/i18n/current';
import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '@/store';
import AgentFloorStage, { HudSnapshot, StageHandle } from '@/components/agentic/AgentFloorStage';
import { useAgentActivity } from '@/hooks/useAgentActivity';
import { describeActivity } from '@/components/agentic/engine/simulation';
import { Activity } from '@/components/agentic/engine/types';
import { DEMO_EVENT_PATHS, demoSnapshot } from '@/components/agentic/engine/demo';
import LoadingSpinner from '@/components/common/LoadingSpinner';

const SPEEDS = [0.5, 1, 2, 4];

const PRIORITY_COLOUR: Record<string, string> = {
  critical: 'var(--color-critical)',
  high: 'var(--color-warning)',
  medium: 'var(--color-info)',
  low: 'var(--color-text-muted)',
};

const EMPTY_HUD: HudSnapshot = {
  agents: [],
  ticker: [],
  piles: { backlog: 0, active: 0, review: 0, done: 0 },
  delivered: 0,
};

function PileCard({ label, value, colour }: { label: string; value: number; colour: string }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 12px',
      }}
    >
      <div
        style={{
          fontSize: 'var(--text-xs)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--color-text-secondary)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.5rem',
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          color: colour,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ControlChip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: '1px solid',
        borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
        background: active ? 'var(--color-accent-subtle)' : 'var(--color-surface)',
        color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        borderRadius: 'var(--radius-sm)',
        padding: '4px 10px',
        fontSize: 'var(--text-xs)',
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: '18px',
      }}
    >
      {children}
    </button>
  );
}

export default function AgentFloorView() {
  const { t } = useLanguage();
  const { agenticVisualMode } = useAppState();
  const navigate = useNavigate();
  const stageRef = useRef<StageHandle | null>(null);

  const [hud, setHud] = useState<HudSnapshot>(EMPTY_HUD);
  const [focused, setFocused] = useState<string | null>(null);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [paused, setPaused] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [crtEffect, setCrtEffect] = useState(true);
  const [showBubbles, setShowBubbles] = useState(true);
  const [demo, setDemo] = useState(false);

  // Respect the OS "reduce motion" setting: start paused and without the CRT
  // sweep, and let the user opt back in with the controls.
  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  useEffect(() => {
    if (reducedMotion) {
      setPaused(true);
      setCrtEffect(false);
    }
  }, [reducedMotion]);

  const handleFileChange = useCallback((path: string) => {
    stageRef.current?.applyEvent(path);
  }, []);

  const { snapshot: liveSnapshot, error, loading, lastEventAt } = useAgentActivity(
    handleFileChange,
    agenticVisualMode,
  );

  // Demo mode replaces the whole snapshot rather than blending with real data,
  // so nothing on screen is ever half real and half invented.
  const [demoData, setDemoData] = useState(() => demoSnapshot());
  const snapshot = demo ? demoData : liveSnapshot;

  useEffect(() => {
    if (!demo) return;
    let step = 0;
    const timer = setInterval(() => {
      stageRef.current?.applyEvent(DEMO_EVENT_PATHS[step % DEMO_EVENT_PATHS.length]);
      step += 1;
    }, 5200);
    return () => clearInterval(timer);
  }, [demo]);

  useEffect(() => {
    if (demo) setDemoData(demoSnapshot());
  }, [demo]);

  const options = useMemo(
    () => ({ focusedTaskId: focused, showLegend, crtEffect, showBubbles }),
    [focused, showLegend, crtEffect, showBubbles],
  );

  const liveRecently = lastEventAt > 0 && Date.now() - lastEventAt < 60000;

  if (!agenticVisualMode) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {t('agentFloor.agenticVisualModeIsOff')}
        </p>
      </div>
    );
  }

  const controls = (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <ControlChip active={paused} onClick={() => setPaused((p) => !p)}>
              {paused ? t('agentFloor.resume') : t('agentFloor.pause')}
            </ControlChip>
            {SPEEDS.map((s, i) => (
              <ControlChip key={s} active={speedIndex === i} onClick={() => setSpeedIndex(i)}>
                {s}×
              </ControlChip>
            ))}
            <span style={{ width: 8 }} />
            <ControlChip active={showLegend} onClick={() => setShowLegend((v) => !v)}>
              {t('agentFloor.labels')}
            </ControlChip>
            <ControlChip active={showBubbles} onClick={() => setShowBubbles((v) => !v)}>
              {t('agentFloor.bubbles')}
            </ControlChip>
            <ControlChip active={crtEffect} onClick={() => setCrtEffect((v) => !v)}>
              CRT
            </ControlChip>
            <ControlChip active={demo} onClick={() => setDemo((v) => !v)}>
              {t('agentFloor.demo')}
            </ControlChip>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
                fontFamily: 'var(--font-sans)',
              }}
            >
              {t('agentFloor.clickAnAgentToFollow')}
            </span>
          </div>
  );

  return (
    <div
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Header row: piles and the live indicator */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <PileCard label={t('routineEditor.backlog')} value={hud.piles.backlog} colour="var(--color-text)" />
        <PileCard label="In Progress" value={hud.piles.active} colour="var(--color-info)" />
        <PileCard label={t('simulation.needsReview')} value={hud.piles.review} colour="var(--color-warning)" />
        <PileCard label={t('done')} value={hud.piles.done} colour="var(--color-success)" />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 6,
            padding: '10px 12px',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            minWidth: 168,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: demo
                  ? 'var(--color-warning)'
                  : liveRecently
                  ? 'var(--color-success)'
                  : 'var(--color-text-muted)',
              }}
            />
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {demo ? t('agentFloor.demoData') : liveRecently ? t('agentFloor.liveFileEvents') : t('agentFloor.noRecentChanges')}
            </span>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {demo
              ? t('agentFloor.sampleTasksNotYourWorkspace')
              : lastEventAt > 0
              ? t('agentFloor.lastChange', { toLocaleTimeString: new Date(lastEventAt).toLocaleTimeString(currentLocale()) })
              : t('agentFloor.waitingForTheFileWatcher')}
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--color-critical-subtle)',
            border: '1px solid var(--color-critical)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-critical)',
          }}
        >
          {error}
        </div>
      )}

      {/* Stage + side panel */}
      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading && !snapshot ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#0b0a12',
                borderRadius: 'var(--radius-lg)',
              }}
            >
              <LoadingSpinner />
            </div>
          ) : (
            <AgentFloorStage
              ref={stageRef}
              snapshot={snapshot}
              options={options}
              speed={SPEEDS[speedIndex]}
              paused={paused}
              onHud={setHud}
              onPickAgent={setFocused}
              footer={controls}
            />
          )}

        </div>

        {/* Side panel: roster and ticker */}
        <div
          style={{
            width: 248,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minHeight: 0,
          }}
        >
          <div
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 12,
              flex: '0 1 auto',
              minHeight: 0,
              overflowY: 'auto',
            }}
          >
            <h2
              style={{
                margin: '0 0 10px 0',
                fontSize: 'var(--text-xs)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-text-secondary)',
              }}
            >
              {rich(t, 'agentFloor.onTheFloor', { length: hud.agents.length })}
            </h2>

            {hud.agents.length === 0 ? (
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                {rich(t, 'agentFloor.nothingIsInProgressMove', { code: <code style={{ fontFamily: 'var(--font-mono)' }}>/gtd-task</code> })}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {hud.agents.map((agent) => (
                  <button
                    key={agent.taskId}
                    onClick={() => {
                      setFocused((cur) => (cur === agent.taskId ? null : agent.taskId));
                    }}
                    onDoubleClick={() => navigate(`/board/task/${agent.taskId}`)}
                    style={{
                      textAlign: 'left',
                      background:
                        focused === agent.taskId ? 'var(--color-accent-subtle)' : 'var(--color-bg)',
                      border: '1px solid',
                      borderColor:
                        focused === agent.taskId ? 'var(--color-accent)' : 'var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '8px 10px',
                      cursor: 'pointer',
                      display: 'block',
                      width: '100%',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: agent.blocked
                          ? 'var(--color-critical)'
                          : PRIORITY_COLOUR[agent.priority] ?? 'var(--color-text-muted)',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 'var(--text-xs)',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        {agent.taskId}
                      </span>
                      {agent.live && (
                        <span
                          style={{
                            marginLeft: 'auto',
                            fontSize: '0.62rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--color-success)',
                            border: '1px solid var(--color-success)',
                            borderRadius: 3,
                            padding: '0 4px',
                          }}
                        >
                          {t('agentFloor.live')}
                        </span>
                      )}
                    </div>
                    <div
                      className="truncate"
                      style={{
                        fontSize: 'var(--text-sm)',
                        color: 'var(--color-text)',
                        fontWeight: 500,
                        marginTop: 2,
                      }}
                      title={agent.taskTitle}
                    >
                      {agent.taskTitle}
                    </div>
                    <div
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-text-muted)',
                        marginTop: 2,
                      }}
                    >
                      {agent.agentName} —{' '}
                      {agent.blocked
                        ? t('agentFloor.blockedWaiting')
                        : agent.stage === 'handover'
                        ? t('agentFloor.handingInTo', { value: agent.destination === 'done' ? t('done') : t('simulation.needsReview') })
                        : agent.stage === 'leaving'
                        ? t('agentFloor.wrappingUpLeavingTheFloor')
                        : describeActivity(agent.activity as Activity)}
                      {agent.outputFormat && !agent.blocked
                        ? ` (${agent.outputFormat.toUpperCase()})`
                        : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 12,
              flex: 1,
              minHeight: 120,
              overflowY: 'auto',
            }}
          >
            <h2
              style={{
                margin: '0 0 10px 0',
                fontSize: 'var(--text-xs)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-text-secondary)',
              }}
            >
              {t('agentFloor.activityLog')}
            </h2>
            {hud.ticker.length === 0 ? (
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                {t('agentFloor.nothingYet')}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {hud.ticker.map((line) => (
                  <div key={line.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span
                      style={{
                        fontSize: '0.62rem',
                        fontFamily: 'var(--font-mono)',
                        color: line.live ? 'var(--color-success)' : 'var(--color-text-muted)',
                        flexShrink: 0,
                      }}
                    >
                      {new Date(line.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text)' }}>
                      {line.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
