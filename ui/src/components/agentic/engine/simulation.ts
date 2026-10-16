import {
  DESKS,
  LANE_BOTTOM,
  LANE_TOP,
  REST_SPOTS,
  SHELF,
  WORKSTATIONS,
  Point,
  Station,
  WALK_SPEED,
  routeTo,
} from './scene';
import { Activity, Destination, Effect, FloorAgent, TickerLine, WorldState } from './types';
import { ActivityTask, AgentActivitySnapshot } from './activityTypes';

/** How long each non-walking phase lasts, in milliseconds. */
const PHASE_MS: Record<Activity, number> = {
  idle: 2600,
  walk: 0,
  pickup: 750,
  reading: 2600,
  browsing: 3200,
  searching: 3000,
  thinking: 1500,
  writing: 4200,
  delivering: 900,
  celebrating: 1100,
};

/**
 * What an agent does while its task is genuinely in progress. It repeats: the
 * agent keeps reading, researching and writing for as long as the task file
 * says the work is still open.
 *
 * Handing the work in is deliberately NOT part of this loop. A delivery only
 * happens when the task's real status leaves In Progress — otherwise the floor
 * would show work being handed over while it is still being done.
 */
const WORK_LOOP: Activity[] = ['reading', 'browsing', 'searching', 'thinking', 'writing'];

function now(): number {
  return performance.now();
}

function hashSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** Where an activity happens. Walking targets are derived from this. */
function stationFor(activity: Activity, agent: FloorAgent): Station | null {
  switch (activity) {
    case 'pickup':
    case 'reading':
      return DESKS.backlog;
    case 'browsing':
      return SHELF;
    case 'searching':
    case 'thinking':
    case 'writing':
      return WORKSTATIONS[hashSeed(agent.id) % WORKSTATIONS.length];
    case 'delivering':
    case 'celebrating':
      return agent.destination === 'done' ? DESKS.done : DESKS.review;
    default:
      return null;
  }
}

function carryingFor(activity: Activity): FloorAgent['carrying'] {
  switch (activity) {
    case 'pickup':
    case 'reading':
      return 'paper';
    case 'browsing':
      return 'books';
    case 'searching':
    case 'thinking':
      return 'paper';
    case 'writing':
      return 'none';
    case 'delivering':
      return 'paper';
    default:
      return 'none';
  }
}

/** Short label describing an activity, used in the HUD and the ticker. */
export function describeActivity(activity: Activity): string {
  switch (activity) {
    case 'idle': return 'waiting for work';
    case 'walk': return 'crossing the floor';
    case 'pickup': return 'taking a task off the backlog';
    case 'reading': return 'reading the task brief';
    case 'browsing': return 'pulling context and stakeholder notes';
    case 'searching': return 'researching at the terminal';
    case 'thinking': return 'working out the approach';
    case 'writing': return 'writing the deliverable';
    case 'delivering': return 'handing the work in';
    case 'celebrating': return 'handed in';
    default: return activity;
  }
}

function makeEffect(
  kind: Effect['kind'],
  x: number,
  y: number,
  durationMs: number,
  text?: string,
  colour?: string,
): Effect {
  const effect: Effect = { kind, x, y, start: now(), durationMs };
  if (text !== undefined) effect.text = text;
  if (colour !== undefined) effect.colour = colour;
  return effect;
}

export function createWorld(): WorldState {
  return {
    agents: [],
    effects: [],
    ticker: [],
    piles: {
      backlog: { target: 0, shown: 0 },
      active: { target: 0, shown: 0 },
      review: { target: 0, shown: 0 },
      done: { target: 0, shown: 0 },
    },
    initialized: false,
    lastLiveEventAt: 0,
    delivered: 0,
    caretaker: null,
  };
}

function pushTicker(world: WorldState, text: string, live: boolean): void {
  world.ticker.unshift({
    id: `${now()}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    at: Date.now(),
    live,
  });
  if (world.ticker.length > 40) world.ticker.length = 40;
}

/** Pick a resting spot that no other agent is standing on. */
function freeRestSpot(world: WorldState, id: string): Point {
  const taken = new Set(
    world.agents
      .filter((a) => a.id !== id && a.activity === 'idle')
      .map((a) => `${Math.round(a.pos.x)},${Math.round(a.pos.y)}`),
  );
  const start = hashSeed(id) % REST_SPOTS.length;
  for (let i = 0; i < REST_SPOTS.length; i++) {
    const spot = REST_SPOTS[(start + i) % REST_SPOTS.length];
    if (!taken.has(`${spot.x},${spot.y}`)) return { ...spot };
  }
  return { ...REST_SPOTS[start] };
}

/** The first deliverable that is not finished yet — that is what gets written. */
function pendingFormat(task: ActivityTask): string | undefined {
  const pending = task.deliverables.find((d) => d.status !== 'complete');
  const chosen = pending ?? task.deliverables[0];
  return chosen?.format;
}

function spawnAgent(world: WorldState, task: ActivityTask): FloorAgent {
  const agent: FloorAgent = {
    id: task.id,
    taskId: task.id,
    taskTitle: task.title,
    agentName: task.agent ?? 'assistant',
    priority: task.priority,
    pos: freeRestSpot(world, task.id),
    facing: 'down',
    path: [],
    activity: 'idle',
    pending: null,
    station: null,
    carrying: 'none',
    destination: 'review',
    phaseStart: now(),
    phaseMs: 400,
    stage: 'arriving',
    loopIndex: -1,
    blocked: task.status === 'blocked',
    signal: null,
    expired: false,
    seed: hashSeed(task.id) % 1000,
  };
  const format = pendingFormat(task);
  if (format) agent.outputFormat = format;
  return agent;
}

/**
 * Lateral offset so several agents using the same station stand side by side
 * instead of on top of each other. Deterministic per agent, so nobody shuffles.
 */
function stationOffset(agent: FloorAgent, station: Station): number {
  const spread = station.id.startsWith('desk-') ? 13 : 11;
  const slot = hashSeed(agent.id) % 3;
  return (slot - 1) * spread;
}

function startActivity(agent: FloorAgent, activity: Activity): void {
  agent.activity = activity;
  agent.pending = null;
  agent.phaseStart = now();
  agent.phaseMs = PHASE_MS[activity];
  agent.carrying = carryingFor(activity);
  if (
    activity === 'browsing' ||
    activity === 'searching' ||
    activity === 'thinking' ||
    activity === 'writing' ||
    activity === 'delivering'
  ) {
    agent.facing = 'up';
  } else {
    agent.facing = 'down';
  }
}

/** Send the agent walking to `activity`'s station, then start that activity. */
function goTo(world: WorldState, agent: FloorAgent, activity: Activity): void {
  const station = stationFor(activity, agent);
  agent.pending = activity;
  agent.station = station;
  if (!station) {
    startActivity(agent, activity);
    return;
  }
  const stand = { x: station.anchor.x + stationOffset(agent, station), y: station.anchor.y };
  agent.path = routeTo(agent.pos, stand, station.lane);
  agent.activity = 'walk';
  agent.phaseStart = now();
  agent.phaseMs = 0;
  // While walking the agent keeps whatever the destination activity needs, so
  // it is visibly carrying the brief on its way to the shelf or the terminal.
  agent.carrying = carryingFor(activity === 'pickup' ? 'idle' : activity);
  world.effects.push(makeEffect('dust', agent.pos.x, agent.pos.y, 420));
}

/** Walk the agent to a rest spot and leave the floor once it gets there. */
function leaveFloor(world: WorldState, agent: FloorAgent): void {
  agent.stage = 'leaving';
  agent.carrying = 'none';
  agent.path = routeTo(agent.pos, freeRestSpot(world, agent.id), LANE_BOTTOM);
  agent.activity = 'walk';
  agent.pending = 'idle';
}

/**
 * Move to the next step of the work loop, skipping steps this task does not
 * involve — no context refs means no trip to the bookshelf, no deliverables
 * means nothing to write.
 */
function nextWorkStep(agent: FloorAgent, task: ActivityTask | undefined): Activity {
  for (let i = 1; i <= WORK_LOOP.length; i++) {
    const index = (agent.loopIndex + i) % WORK_LOOP.length;
    const candidate = WORK_LOOP[index];
    if (candidate === 'browsing' && task && task.context_count + task.stakeholder_count === 0) {
      continue;
    }
    if (candidate === 'writing' && task && task.deliverables.length === 0) continue;
    agent.loopIndex = index;
    return candidate;
  }
  agent.loopIndex = 0;
  return WORK_LOOP[0];
}

/** Decide what an agent does after its current phase finishes. */
function advance(world: WorldState, agent: FloorAgent, task: ActivityTask | undefined): void {
  if (agent.stage === 'leaving') {
    agent.expired = true;
    return;
  }

  if (agent.stage === 'handover') {
    if (agent.activity === 'delivering') {
      startActivity(agent, 'celebrating');
      onEnterPhase(world, agent, 'celebrating');
      return;
    }
    leaveFloor(world, agent);
    return;
  }

  // A blocked task is not being worked on. The agent waits by the desk instead
  // of miming research it is not doing.
  if (agent.blocked) {
    startActivity(agent, 'idle');
    agent.phaseMs = 3000;
    return;
  }

  agent.stage = 'working';
  goTo(world, agent, nextWorkStep(agent, task));
}

/** Move an agent along its path. Returns true when the walk finished. */
function stepWalk(agent: FloorAgent, dtSec: number): boolean {
  let budget = WALK_SPEED * dtSec;
  while (budget > 0 && agent.path.length > 0) {
    const target = agent.path[0];
    const dx = target.x - agent.pos.x;
    const dy = target.y - agent.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) {
      agent.path.shift();
      continue;
    }
    // Face the direction of travel before moving, so a single-step hop to a
    // waypoint still turns the sprite.
    if (Math.abs(dx) > Math.abs(dy)) agent.facing = dx > 0 ? 'right' : 'left';
    else agent.facing = dy > 0 ? 'down' : 'up';

    if (dist <= budget) {
      agent.pos = { x: target.x, y: target.y };
      agent.path.shift();
      budget -= dist;
      continue;
    }
    agent.pos = { x: agent.pos.x + (dx / dist) * budget, y: agent.pos.y + (dy / dist) * budget };
    budget = 0;
  }
  return agent.path.length === 0;
}

/**
 * Effects fired when an agent enters a phase that deserves a flourish.
 *
 * Note that nothing here touches a pile count. Pile counts come from the
 * workspace and only from the workspace — a delivery animates the stack the
 * server has already reported, it never invents one.
 */
function onEnterPhase(world: WorldState, agent: FloorAgent, activity: Activity): void {
  if (activity === 'pickup') {
    world.effects.push(makeEffect('exclaim', agent.pos.x, agent.pos.y - 30, 900));
    pushTicker(world, `${agent.agentName} picked up ${agent.taskId}`, true);
  }
  if (activity === 'delivering') {
    world.delivered += 1;
    world.effects.push(makeEffect('sparkle', agent.pos.x + 10, agent.pos.y - 40, 900));
    pushTicker(
      world,
      `${agent.taskId} moved to ${agent.destination === 'done' ? 'Done' : 'Needs Review'}`,
      true,
    );
  }
  if (activity === 'celebrating') {
    world.effects.push(makeEffect('sparkle', agent.pos.x, agent.pos.y - 34, 800));
  }
}

/** Start the hand-in walk. Only ever called from a real status change. */
function beginHandover(world: WorldState, agent: FloorAgent, destination: Destination): void {
  agent.stage = 'handover';
  agent.destination = destination;
  agent.carrying = 'paper';
  goTo(world, agent, 'delivering');
}

/**
 * Reconcile the world with a fresh snapshot from the server.
 *
 * The snapshot is the single source of truth: pile counts are copied straight
 * across, agents are spawned for tasks that are really in progress, and an
 * agent hands its work in only because its task really changed status.
 */
export function syncSnapshot(world: WorldState, snapshot: AgentActivitySnapshot): void {
  world.piles.backlog.target = snapshot.counts.backlog;
  world.piles.active.target = snapshot.counts.active;
  world.piles.review.target = snapshot.counts.review;
  world.piles.done.target = snapshot.counts.done;

  if (!world.initialized) {
    // First snapshot: start the stacks at their real height rather than
    // animating up from zero.
    world.piles.backlog.shown = snapshot.counts.backlog;
    world.piles.active.shown = snapshot.counts.active;
    world.piles.review.shown = snapshot.counts.review;
    world.piles.done.shown = snapshot.counts.done;
    world.initialized = true;
  }

  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const active = snapshot.tasks.filter((t) => t.pile === 'active');
  const activeIds = new Set(active.map((t) => t.id));

  for (const task of active) {
    const existing = world.agents.find((a) => a.id === task.id);
    if (existing) {
      existing.taskTitle = task.title;
      existing.agentName = task.agent ?? existing.agentName;
      existing.priority = task.priority;
      existing.blocked = task.status === 'blocked';
      const format = pendingFormat(task);
      if (format) existing.outputFormat = format;
      // The task came back to In Progress mid hand-in (rework). Put the agent
      // back to work rather than letting it walk off.
      if (existing.stage === 'handover' || existing.stage === 'leaving') {
        existing.stage = 'working';
        existing.expired = false;
        pushTicker(world, `${task.id} is back in progress — ${existing.agentName} resumed`, true);
        goTo(world, existing, nextWorkStep(existing, task));
      }
      continue;
    }
    const agent = spawnAgent(world, task);
    world.agents.push(agent);
    pushTicker(world, `${agent.agentName} started ${task.id}`, true);
    goTo(world, agent, 'pickup');
  }

  for (const agent of world.agents) {
    if (activeIds.has(agent.id)) continue;
    if (agent.stage === 'handover' || agent.stage === 'leaving') continue;

    const task = byId.get(agent.id);
    if (task?.pile === 'review') {
      beginHandover(world, agent, 'review');
    } else if (task?.pile === 'done') {
      beginHandover(world, agent, 'done');
    } else {
      // Sent back to the backlog, archived or deleted. Nothing was handed in,
      // so the agent just leaves.
      pushTicker(world, `${agent.taskId} left In Progress`, true);
      leaveFloor(world, agent);
    }
  }
}

/**
 * Path fragments that tell us what a changed file means for the floor.
 *
 * A status change is deliberately not classified here. Status is read from the
 * snapshot that follows the event, so the floor reacts to what the file now
 * says rather than guessing from the fact that it was touched.
 */
export function classifyEvent(path: string): { activity: Activity | null; label: string } {
  const p = path.replace(/\\/g, '/');
  if (p.includes('/executions/')) return { activity: null, label: 'execution log written' };
  if (p.includes('/deliverables/')) return { activity: 'writing', label: 'deliverable written' };
  if (p.includes('/context/')) return { activity: 'browsing', label: 'context note read' };
  if (p.includes('/stakeholders/')) return { activity: 'browsing', label: 'stakeholder file read' };
  if (p.includes('/outputs/')) return { activity: 'writing', label: 'output template touched' };
  if (p.includes('/kaizen/')) return { activity: 'thinking', label: 'kaizen proposal written' };
  if (/\/tasks\/.*task\.md$/.test(p)) return { activity: null, label: 'task file updated' };
  return { activity: null, label: 'workspace file changed' };
}

/**
 * A real file change arrived.
 *
 * The agent is only steered when the path names its task, or when exactly one
 * agent is working and the attribution is therefore unambiguous. Guessing an
 * owner out of a crowd made the floor jitter without telling the truth.
 */
export function applyLiveEvent(world: WorldState, path: string): void {
  const { activity, label } = classifyEvent(path);
  world.lastLiveEventAt = Date.now();

  const working = world.agents.filter((a) => a.stage === 'working' || a.stage === 'arriving');
  const named = world.agents.find((a) => a.taskId && path.includes(a.taskId));
  const owner = named ?? (working.length === 1 ? working[0] : undefined);

  if (!owner) {
    pushTicker(world, label, true);
    return;
  }

  pushTicker(world, `${owner.agentName} — ${label}`, true);
  owner.signal = { label, at: Date.now(), live: true };

  // Never interrupt a hand-in or an exit walk; those follow the task's status.
  if (!activity || owner.stage === 'handover' || owner.stage === 'leaving') return;
  if (owner.blocked) return;

  const idx = WORK_LOOP.indexOf(activity);
  if (idx >= 0) owner.loopIndex = idx;
  owner.stage = 'working';
  goTo(world, owner, activity);
}

/**
 * Places the caretaker drifts between when the floor is empty. These are not
 * work stations — the caretaker is scenery, so the room is not a dead screen
 * when nothing is in progress.
 */
const CARETAKER_SPOTS: Point[] = [
  { x: 106, y: LANE_TOP },
  { x: 240, y: LANE_TOP },
  { x: 396, y: LANE_TOP },
  { x: 60, y: 194 },
  { x: 240, y: 194 },
  { x: 420, y: 194 },
  { x: 132, y: 252 },
  { x: 336, y: 252 },
];

function makeCaretaker(): FloorAgent {
  return {
    id: '__caretaker__',
    taskId: '',
    taskTitle: '',
    agentName: 'caretaker',
    priority: 'low',
    pos: { x: 240, y: 252 },
    facing: 'down',
    path: [],
    activity: 'idle',
    pending: null,
    station: null,
    carrying: 'none',
    destination: 'review',
    phaseStart: now(),
    phaseMs: 2000,
    stage: 'working',
    loopIndex: 0,
    blocked: false,
    signal: null,
    expired: false,
    seed: 0,
  };
}

/**
 * Keep the caretaker in step with the floor: present and wandering while no
 * agent is working, gone the moment real work starts.
 */
function updateCaretaker(world: WorldState, dtSec: number): void {
  if (world.agents.length > 0) {
    world.caretaker = null;
    return;
  }
  if (!world.caretaker) {
    world.caretaker = makeCaretaker();
    return;
  }

  const care = world.caretaker;
  const t = now();

  if (care.activity === 'walk') {
    if (stepWalk(care, dtSec)) {
      care.activity = 'idle';
      care.facing = 'down';
      care.phaseStart = t;
      care.phaseMs = 2600 + Math.random() * 3200;
    }
    return;
  }

  if (t - care.phaseStart >= care.phaseMs) {
    const target = CARETAKER_SPOTS[Math.floor(Math.random() * CARETAKER_SPOTS.length)];
    const lane = target.y <= LANE_TOP + 4 ? LANE_TOP : LANE_BOTTOM;
    care.path = routeTo(care.pos, target, lane);
    care.activity = 'walk';
    care.phaseStart = t;
  }
}

/** Ease a pile's drawn height toward the real count. */
function easePile(pile: { target: number; shown: number }, dtSec: number): void {
  const diff = pile.target - pile.shown;
  if (Math.abs(diff) < 0.02) {
    pile.shown = pile.target;
    return;
  }
  pile.shown += diff * Math.min(1, dtSec * 4);
}

/** Advance the whole world by `dtSec` seconds. */
export function tick(world: WorldState, dtSec: number, tasksById: Map<string, ActivityTask>): void {
  const t = now();

  for (const agent of world.agents) {
    if (agent.activity === 'walk') {
      const arrived = stepWalk(agent, dtSec);
      if (!arrived) continue;

      if (agent.stage === 'leaving') {
        agent.expired = true;
        continue;
      }
      if (agent.pending) {
        const next = agent.pending;
        startActivity(agent, next);
        onEnterPhase(world, agent, next);
      }
      continue;
    }

    if (t - agent.phaseStart >= agent.phaseMs) {
      advance(world, agent, tasksById.get(agent.taskId));
    }
  }

  world.agents = world.agents.filter((a) => !a.expired);

  updateCaretaker(world, dtSec);

  world.effects = world.effects.filter((e) => t - e.start < e.durationMs);

  easePile(world.piles.backlog, dtSec);
  easePile(world.piles.active, dtSec);
  easePile(world.piles.review, dtSec);
  easePile(world.piles.done, dtSec);
}

export type { TickerLine };
