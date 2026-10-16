/**
 * Fixed layout of the Agent Floor room, in logical pixels.
 *
 * The canvas renders at this size and is then scaled up by an integer factor,
 * which is what keeps the pixel art crisp. Every coordinate below is a whole
 * number on purpose — sub-pixel placement is what makes pixel art look muddy.
 */
export const STAGE_W = 480;
export const STAGE_H = 270;

/** Height of the back wall band. Everything below this is floor. */
export const WALL_H = 56;

/** Agents are 16x24 and are positioned by their feet. */
export const AGENT_W = 16;
export const AGENT_H = 24;

/** Horizontal travel lanes. Agents never walk diagonally through furniture. */
export const LANE_TOP = 116;
export const LANE_BOTTOM = 234;

export interface Point {
  x: number;
  y: number;
}

/** A place an agent can stand and do something. */
export interface Station {
  id: string;
  /** Top-left of the furniture sprite. */
  sprite: Point;
  /** Where the agent's feet go when using it. */
  anchor: Point;
  /** Which lane the agent uses to approach. */
  lane: number;
  label?: string;
}

/** The three paper desks: where work waits, waits for review, and lands. */
export const DESKS = {
  backlog: {
    id: 'desk-backlog',
    sprite: { x: 36, y: 150 },
    anchor: { x: 60, y: 194 },
    lane: LANE_BOTTOM,
    label: 'BACKLOG',
  } as Station,
  review: {
    id: 'desk-review',
    sprite: { x: 216, y: 150 },
    anchor: { x: 240, y: 194 },
    lane: LANE_BOTTOM,
    label: 'REVIEW',
  } as Station,
  done: {
    id: 'desk-done',
    sprite: { x: 396, y: 150 },
    anchor: { x: 420, y: 194 },
    lane: LANE_BOTTOM,
    label: 'DONE',
  } as Station,
};

/** Where a paper stack sits on a desk, relative to the desk sprite origin. */
export const STACK_OFFSET: Point = { x: 19, y: 4 };
/** Vertical pixels each additional sheet adds to a stack. */
export const STACK_STEP = 3;
/** Sheets drawn before the stack stops growing and a "+N" label takes over. */
export const STACK_MAX_SHEETS = 12;

/** The bookshelf — context notes, stakeholder files, everything the agent reads. */
export const SHELF: Station = {
  id: 'shelf',
  sprite: { x: 86, y: 40 },
  anchor: { x: 106, y: LANE_TOP },
  lane: LANE_TOP,
  label: 'CONTEXT',
};

/** Three CRT workstations: research and output generation happen here. */
export const WORKSTATIONS: Station[] = [
  { id: 'ws-0', sprite: { x: 164, y: 52 }, anchor: { x: 184, y: LANE_TOP }, lane: LANE_TOP },
  { id: 'ws-1', sprite: { x: 220, y: 52 }, anchor: { x: 240, y: LANE_TOP }, lane: LANE_TOP },
  { id: 'ws-2', sprite: { x: 276, y: 52 }, anchor: { x: 296, y: LANE_TOP }, lane: LANE_TOP },
];

/** Idle agents loiter here rather than standing on top of each other. */
export const REST_SPOTS: Point[] = [
  { x: 96, y: 252 },
  { x: 132, y: 252 },
  { x: 168, y: 252 },
  { x: 300, y: 252 },
  { x: 336, y: 252 },
  { x: 372, y: 252 },
];

/** Purely decorative furniture, drawn once per frame in this order. */
export const DECOR = {
  whiteboard: { x: 26, y: 16 },
  windowLeft: { x: 140, y: 14 },
  clock: { x: 196, y: 18 },
  poster: { x: 246, y: 16 },
  windowRight: { x: 344, y: 14 },
  serverRack: { x: 344, y: 54 },
  waterCooler: { x: 392, y: 62 },
  plantLeft: { x: 12, y: 62 },
  plantRight: { x: 452, y: 62 },
  rug: { x: 216, y: 96 },
  chairs: [
    { x: 168, y: 92 },
    { x: 224, y: 92 },
    { x: 280, y: 92 },
  ],
  mug: { x: 44, y: 146 },
  // Front-of-room props. They fill the walking floor so the room reads as an
  // office rather than an empty stage. Everything sits in the bands between the
  // two walking lanes, so an agent never walks through a filing cabinet.
  printer: { x: 300, y: 196 },
  filingCabinet: { x: 14, y: 184 },
  boxes: { x: 48, y: 198 },
  coffeeMachine: { x: 428, y: 62 },
  floorLamp: { x: 8, y: 124 },
  trashBin: { x: 352, y: 202 },
  plantSmall: { x: 464, y: 200 },
  paperTray: { x: 404, y: 146 },
  clipboard: { x: 228, y: 144 },
};

/**
 * Route between two points using the axis-aligned lanes. Returns the waypoints
 * an agent walks through, so nobody clips a desk on the way to the bookshelf.
 */
export function routeTo(from: Point, to: Point, lane: number): Point[] {
  const path: Point[] = [];
  if (Math.abs(from.y - lane) > 1) path.push({ x: from.x, y: lane });
  if (Math.abs(from.x - to.x) > 1) path.push({ x: to.x, y: lane });
  path.push({ x: to.x, y: to.y });
  return path;
}

/** Walking speed in logical pixels per second. */
export const WALK_SPEED = 42;
