import { Point, Station } from './scene';

/** What an agent is doing right now. Each maps to a pose and a screen state. */
export type Activity =
  | 'idle'
  | 'walk'
  | 'pickup'
  | 'reading'
  | 'browsing'
  | 'searching'
  | 'thinking'
  | 'writing'
  | 'delivering'
  | 'celebrating';

export type Facing = 'down' | 'up' | 'left' | 'right';

/** What the agent has in its hands, drawn on top of the walk pose. */
export type Carrying = 'none' | 'paper' | 'books';

/** Where a finished sheet is headed. */
export type Destination = 'review' | 'done';

/**
 * Where an agent is in its life on the floor.
 *
 * `working` repeats for as long as the task is really in progress. Nothing
 * moves to `handover` until the task file itself leaves In Progress, so the
 * floor can never show a handover that has not actually happened.
 */
export type AgentStage = 'arriving' | 'working' | 'handover' | 'leaving';

export interface AgentSignal {
  /** Human-readable reason, shown in the HUD ticker. */
  label: string;
  /** When the signal arrived. */
  at: number;
  /** True when a real file-change event caused it, false for the ambient loop. */
  live: boolean;
}

export interface FloorAgent {
  /** Same as the task id — one agent per in-flight task. */
  id: string;
  taskId: string;
  taskTitle: string;
  /** `preferred_agent` from the task, or a generic label. */
  agentName: string;
  priority: string;
  pos: Point;
  facing: Facing;
  /** Remaining waypoints for the current walk. */
  path: Point[];
  activity: Activity;
  /** Activity to switch into once the current walk or timer ends. */
  pending: Activity | null;
  station: Station | null;
  carrying: Carrying;
  /** Format of the deliverable being produced, drives the CRT icon. */
  outputFormat?: string;
  destination: Destination;
  phaseStart: number;
  phaseMs: number;
  stage: AgentStage;
  /** Index into WORK_LOOP while `stage` is `working`. */
  loopIndex: number;
  /** True while the task's status is `blocked`; the agent waits instead of working. */
  blocked: boolean;
  signal: AgentSignal | null;
  /** Marks the agent for removal after its exit walk. */
  expired: boolean;
  /** Cosmetic bob offset so a crowd of agents does not animate in lockstep. */
  seed: number;
}

/** A short-lived visual effect: sparkle, dust puff, floating label. */
export interface Effect {
  kind: 'sparkle' | 'dust' | 'exclaim' | 'zzz' | 'float';
  x: number;
  y: number;
  start: number;
  durationMs: number;
  text?: string;
  colour?: string;
}

/** One line in the on-screen activity ticker. */
export interface TickerLine {
  id: string;
  text: string;
  at: number;
  live: boolean;
}

export interface PileState {
  /**
   * The real count from the workspace. This is the number shown to the user;
   * the simulation never writes to it.
   */
  target: number;
  /** Eased toward `target`, used only for the drawn height of the stack. */
  shown: number;
}

export interface WorldState {
  agents: FloorAgent[];
  effects: Effect[];
  ticker: TickerLine[];
  piles: {
    backlog: PileState;
    active: PileState;
    review: PileState;
    done: PileState;
  };
  /** False until the first snapshot lands, so piles start at their real size. */
  initialized: boolean;
  /** Wall-clock ms of the last real file-change event. */
  lastLiveEventAt: number;
  /** Total deliveries made since the view opened, for the HUD score. */
  delivered: number;
  /** The caretaker keeps the room alive when nothing is in flight. */
  caretaker: FloorAgent | null;
}
