import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { STAGE_H, STAGE_W } from './engine/scene';
import { render, RenderOptions } from './engine/renderer';
import { applyLiveEvent, createWorld, syncSnapshot, tick } from './engine/simulation';
import { WorldState } from './engine/types';
import { ActivityTask, AgentActivitySnapshot } from './engine/activityTypes';

/** What the React HUD needs from the world, sampled a few times per second. */
export interface HudSnapshot {
  agents: Array<{
    taskId: string;
    taskTitle: string;
    agentName: string;
    activity: string;
    priority: string;
    outputFormat?: string;
    destination: string;
    stage: string;
    blocked: boolean;
    live: boolean;
  }>;
  ticker: Array<{ id: string; text: string; at: number; live: boolean }>;
  piles: { backlog: number; active: number; review: number; done: number };
  delivered: number;
}

export interface StageHandle {
  /** Feed a real file-change path into the simulation. */
  applyEvent: (path: string) => void;
}

interface Props {
  snapshot: AgentActivitySnapshot | null;
  options: RenderOptions;
  /** Animation speed multiplier from the HUD speed control. */
  speed: number;
  paused: boolean;
  onHud: (hud: HudSnapshot) => void;
  onPickAgent: (taskId: string | null) => void;
  /** Control row, rendered directly under the canvas at the same width. */
  footer?: React.ReactNode;
}

function toHud(world: WorldState): HudSnapshot {
  const nowMs = Date.now();
  return {
    agents: world.agents.map((a) => {
      const entry: HudSnapshot['agents'][number] = {
        taskId: a.taskId,
        taskTitle: a.taskTitle,
        agentName: a.agentName,
        activity: a.activity,
        priority: a.priority,
        destination: a.destination,
        stage: a.stage,
        blocked: a.blocked,
        live: Boolean(a.signal?.live && nowMs - a.signal.at < 15000),
      };
      if (a.outputFormat) entry.outputFormat = a.outputFormat;
      return entry;
    }),
    ticker: world.ticker.slice(0, 12),
    // Counts come from `target`, which is the workspace's own number. `shown`
    // is only the eased height of the drawn stack and must never be reported
    // as a count — that is what made the HUD disagree with the board.
    piles: {
      backlog: world.piles.backlog.target,
      active: world.piles.active.target,
      review: world.piles.review.target,
      done: world.piles.done.target,
    },
    delivered: world.delivered,
  };
}

/**
 * The pixel stage. Owns the world state and the animation loop; React only sees
 * a low-frequency HUD summary so a 60fps canvas never triggers a re-render.
 */
/** Vertical space kept free under the canvas for the control row. */
const FOOTER_RESERVE = 46;

const AgentFloorStage = forwardRef<StageHandle, Props>(function AgentFloorStage(
  { snapshot, options, speed, paused, onHud, onPickAgent, footer },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<WorldState>(createWorld());
  const optionsRef = useRef(options);
  const speedRef = useRef(speed);
  const pausedRef = useRef(paused);
  const onHudRef = useRef(onHud);
  const [scale, setScale] = useState(2);

  optionsRef.current = options;
  speedRef.current = speed;
  pausedRef.current = paused;
  onHudRef.current = onHud;

  const tasksById = useMemo(() => {
    const map = new Map<string, ActivityTask>();
    for (const task of snapshot?.tasks ?? []) map.set(task.id, task);
    return map;
  }, [snapshot]);
  const tasksRef = useRef(tasksById);
  tasksRef.current = tasksById;

  useImperativeHandle(
    ref,
    () => ({
      applyEvent: (path: string) => applyLiveEvent(worldRef.current, path),
    }),
    [],
  );

  // Reconcile whenever a fresh snapshot arrives.
  useEffect(() => {
    if (snapshot) syncSnapshot(worldRef.current, snapshot);
  }, [snapshot]);

  // Fit the stage to the space available, snapped to half-pixel steps. Anything
  // finer makes some source pixels a screen pixel wider than their neighbours,
  // which reads as a wobble across the floorboards and the 5px font.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const measure = () => {
      const { width, height } = wrap.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      // Reserve room for the control row that sits under the canvas.
      const fit = Math.min(width / STAGE_W, Math.max(80, height - FOOTER_RESERVE) / STAGE_H);
      setScale(Math.max(1, Math.floor(fit * 2) / 2));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // The animation loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let last = performance.now();
    let lastHud = 0;

    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      // Clamp dt so a backgrounded tab does not teleport every agent on return.
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;

      if (!pausedRef.current) {
        tick(worldRef.current, dt * speedRef.current, tasksRef.current);
      }
      render(ctx, worldRef.current, optionsRef.current);

      if (t - lastHud > 250) {
        lastHud = t;
        onHudRef.current(toHud(worldRef.current));
      }
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Clicking an agent focuses it in the HUD roster.
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * STAGE_W;
      const y = ((e.clientY - rect.top) / rect.height) * STAGE_H;

      let best: string | null = null;
      let bestDist = 18;
      for (const agent of worldRef.current.agents) {
        const dist = Math.hypot(agent.pos.x - x, agent.pos.y - 12 - y);
        if (dist < bestDist) {
          bestDist = dist;
          best = agent.taskId;
        }
      }
      onPickAgent(best);
    },
    [onPickAgent],
  );

  return (
    <div
      ref={wrapRef}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 10,
      }}
    >
      {/* Sized to exactly the scaled canvas, so there is no letterboxing. */}
      <div
        style={{
          width: STAGE_W * scale,
          height: STAGE_H * scale,
          background: '#0b0a12',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--color-border)',
          overflow: 'hidden',
          boxShadow: 'inset 0 0 40px rgba(0,0,0,0.55)',
          flexShrink: 0,
        }}
      >
        <canvas
          ref={canvasRef}
          width={STAGE_W}
          height={STAGE_H}
          onClick={handleClick}
          aria-label="Pixel-art view of agents working through the task backlog"
          style={{
            width: '100%',
            height: '100%',
            imageRendering: 'pixelated',
            cursor: 'pointer',
            display: 'block',
          }}
        />
      </div>
      {footer && <div style={{ width: STAGE_W * scale, maxWidth: '100%' }}>{footer}</div>}
    </div>
  );
});

export default AgentFloorStage;
