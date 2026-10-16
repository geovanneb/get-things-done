import * as A from '../pixel/sprites-agent';
import * as R from '../pixel/sprites-room';
import * as I from '../pixel/sprites-icons';
import * as X from '../pixel/sprites-extra';
import { BASE_PALETTE, ROOM, skinFor } from '../pixel/palette';
import { PixelSprite } from '../pixel/types';
import { bake, blit } from '../pixel/spriteUtils';
import { drawText, drawTextOutlined, textWidth } from '../pixel/text';
import {
  DECOR,
  DESKS,
  SHELF,
  STACK_MAX_SHEETS,
  STACK_OFFSET,
  STACK_STEP,
  STAGE_H,
  STAGE_W,
  WALL_H,
  WORKSTATIONS,
} from './scene';
import { Activity, Effect, FloorAgent, WorldState } from './types';

/** Pick a frame from an animation by elapsed time. */
function frameAt(frames: PixelSprite[], elapsedMs: number, frameMs: number): PixelSprite {
  if (frames.length === 0) return frames[0];
  return frames[Math.floor(elapsedMs / frameMs) % frames.length];
}

/** The sprite an agent shows for its current activity and facing. */
function agentSprite(agent: FloorAgent, t: number): { sprite: PixelSprite; flip: boolean } {
  const elapsed = t - agent.phaseStart + agent.seed;

  if (agent.activity === 'walk') {
    if (agent.facing === 'left' || agent.facing === 'right') {
      return { sprite: frameAt(A.WALK_SIDE, elapsed, 140), flip: agent.facing === 'left' };
    }
    if (agent.facing === 'up') return { sprite: frameAt(A.WALK_UP, elapsed, 140), flip: false };
    return { sprite: frameAt(A.WALK_DOWN, elapsed, 140), flip: false };
  }

  switch (agent.activity) {
    case 'reading':
      return { sprite: frameAt(A.POSE_READ, elapsed, 460), flip: false };
    case 'browsing':
      return { sprite: frameAt(A.POSE_CARRY, elapsed, 380), flip: false };
    case 'searching':
    case 'writing':
      return { sprite: frameAt(A.POSE_TYPE, elapsed, 200), flip: false };
    case 'thinking':
      return { sprite: frameAt(A.POSE_THINK, elapsed, 520), flip: false };
    case 'delivering':
      return { sprite: A.POSE_PLACE, flip: false };
    case 'celebrating':
      return { sprite: frameAt(A.POSE_CHEER, elapsed, 260), flip: false };
    default:
      if (agent.facing === 'up') return { sprite: A.IDLE_UP, flip: false };
      if (agent.facing === 'left') return { sprite: A.IDLE_SIDE, flip: true };
      if (agent.facing === 'right') return { sprite: A.IDLE_SIDE, flip: false };
      return { sprite: A.IDLE_DOWN, flip: false };
  }
}

/** What the CRT shows while an agent is standing at it. */
function screenFor(activity: Activity | null, format: string | undefined, t: number): PixelSprite {
  switch (activity) {
    case 'searching':
      return frameAt(I.SCREEN_SEARCH, t, 220);
    case 'writing':
      // Alternate between the filling-in text and the output format badge so
      // the executive can see which file type is being produced.
      return Math.floor(t / 900) % 2 === 0
        ? frameAt(I.SCREEN_WRITE, t, 260)
        : cropIcon(I.iconForFormat(format));
    case 'thinking':
      return frameAt(I.SCREEN_READ, t, 420);
    case 'reading':
      return frameAt(I.SCREEN_READ, t, 420);
    default:
      return I.SCREEN_IDLE;
  }
}

/** Format badges are 16x16; the CRT interior is 16x12, so trim two rows each end. */
const iconCropCache = new Map<PixelSprite, PixelSprite>();
function cropIcon(icon: PixelSprite): PixelSprite {
  const hit = iconCropCache.get(icon);
  if (hit) return hit;
  const cropped: PixelSprite = { w: icon.w, h: 12, rows: icon.rows.slice(2, 14) };
  iconCropCache.set(icon, cropped);
  return cropped;
}

/** Draw the tiled floor and wall. Cached to one offscreen canvas after first use. */
let backdrop: HTMLCanvasElement | null = null;
function drawBackdrop(ctx: CanvasRenderingContext2D): void {
  if (!backdrop) {
    const canvas = document.createElement('canvas');
    canvas.width = STAGE_W;
    canvas.height = STAGE_H;
    const c = canvas.getContext('2d');
    if (c) {
      c.imageSmoothingEnabled = false;

      const wall = bake('wall', R.WALL_TILE);
      for (let x = 0; x < STAGE_W; x += wall.w) {
        blit(c, wall, x, WALL_H - wall.h);
      }
      // Fill anything above the wall tiles with the darker wall colour.
      c.fillStyle = ROOM.wallTop;
      c.fillRect(0, 0, STAGE_W, Math.max(0, WALL_H - wall.h));

      const tileA = bake('floorA', R.FLOOR_TILE);
      const tileB = bake('floorB', R.FLOOR_TILE_ALT);
      let row = 0;
      for (let y = WALL_H; y < STAGE_H; y += tileA.h) {
        for (let x = 0, col = 0; x < STAGE_W; x += tileA.w, col++) {
          blit(c, (row + col) % 2 === 0 ? tileA : tileB, x, y);
        }
        row++;
      }

      // Soft vignette toward the front of the room.
      const grad = c.createLinearGradient(0, WALL_H, 0, STAGE_H);
      grad.addColorStop(0, 'rgba(18,16,28,0.22)');
      grad.addColorStop(0.35, 'rgba(18,16,28,0)');
      grad.addColorStop(1, 'rgba(18,16,28,0.28)');
      c.fillStyle = grad;
      c.fillRect(0, WALL_H, STAGE_W, STAGE_H - WALL_H);
    }
    backdrop = canvas;
  }
  ctx.drawImage(backdrop, 0, 0);
}

/** Draw a stack of paper sheets on a desk, growing upward from the surface. */
function drawStack(
  ctx: CanvasRenderingContext2D,
  deskX: number,
  deskY: number,
  count: number,
): void {
  const sheets = Math.min(Math.round(count), STACK_MAX_SHEETS);
  const flat = bake('paper', R.PAPER_SHEET);
  const tilt = bake('paperTilt', R.PAPER_SHEET_TILT);
  const baseX = deskX + STACK_OFFSET.x;
  const baseY = deskY + STACK_OFFSET.y;

  for (let i = 0; i < sheets; i++) {
    const jitter = i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0;
    blit(ctx, i % 2 === 0 ? flat : tilt, baseX + jitter, baseY - i * STACK_STEP);
  }

  const shown = Math.round(count);
  if (shown > STACK_MAX_SHEETS) {
    drawTextOutlined(
      ctx,
      `+${shown - STACK_MAX_SHEETS}`,
      baseX + 12,
      baseY - sheets * STACK_STEP - 8,
      '#f2c14e',
    );
  }

}

/**
 * Desk name plate with its live count, drawn after the agents so a body never
 * hides it, and mounted on the desk front so a growing stack never covers it.
 */
function drawDeskLabel(
  ctx: CanvasRenderingContext2D,
  deskX: number,
  deskY: number,
  label: string,
  count: number,
  colour: string,
): void {
  const text = `${label} ${Math.round(count)}`;
  const w = textWidth(text) + 8;
  const left = Math.round(deskX + 24 - w / 2);
  const top = deskY + 15;
  ctx.fillStyle = 'rgba(18,16,28,0.88)';
  ctx.fillRect(left, top, w, 11);
  ctx.fillStyle = colour;
  ctx.fillRect(left, top, w, 1);
  ctx.fillRect(left, top + 10, w, 1);
  drawText(ctx, text, left + 4, top + 2, '#f6f3e6');
}

function drawEffect(ctx: CanvasRenderingContext2D, effect: Effect, t: number): void {
  const progress = (t - effect.start) / effect.durationMs;
  if (progress < 0 || progress > 1) return;

  ctx.save();
  ctx.globalAlpha = 1 - progress * progress;

  if (effect.kind === 'sparkle') {
    const frame = R.SPARKLE[Math.min(R.SPARKLE.length - 1, Math.floor(progress * R.SPARKLE.length))];
    blit(ctx, bake(`sparkle-${R.SPARKLE.indexOf(frame)}`, frame), effect.x - frame.w / 2, effect.y - progress * 10);
  } else if (effect.kind === 'dust') {
    const frame = R.DUST_PUFF[Math.min(R.DUST_PUFF.length - 1, Math.floor(progress * R.DUST_PUFF.length))];
    blit(ctx, bake(`dust-${R.DUST_PUFF.indexOf(frame)}`, frame), effect.x - frame.w / 2, effect.y - 4);
  } else if (effect.kind === 'exclaim') {
    blit(ctx, bake('exclaim', R.EXCLAIM), effect.x - 4, effect.y - progress * 6);
  } else if (effect.kind === 'zzz') {
    const frame = R.ZZZ[Math.floor(t / 400) % R.ZZZ.length];
    blit(ctx, bake(`zzz-${R.ZZZ.indexOf(frame)}`, frame), effect.x, effect.y - progress * 12);
  } else if (effect.kind === 'float' && effect.text) {
    drawTextOutlined(ctx, effect.text, effect.x, effect.y - progress * 14, effect.colour ?? ROOM.ink);
  }

  ctx.restore();
}

/** A small speech bubble above an agent naming what it is doing. */
function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, accent: string): void {
  const w = textWidth(text) + 8;
  const h = 13;
  const left = Math.round(Math.max(2, Math.min(STAGE_W - w - 2, x - w / 2)));
  const top = Math.round(y - h);

  ctx.fillStyle = 'rgba(18,16,28,0.86)';
  ctx.fillRect(left, top, w, h);
  ctx.fillStyle = accent;
  ctx.fillRect(left, top, w, 1);
  ctx.fillRect(left, top + h - 1, w, 1);
  ctx.fillRect(left, top, 1, h);
  ctx.fillRect(left + w - 1, top, 1, h);
  // Tail
  ctx.fillStyle = 'rgba(18,16,28,0.86)';
  ctx.fillRect(Math.round(x) - 1, top + h, 3, 2);

  drawText(ctx, text, left + 4, top + 3, '#f6f3e6');
}

export interface RenderOptions {
  /** Task id whose agent should be highlighted, from a HUD hover or click. */
  focusedTaskId?: string | null;
  /** Draw the labelled overlay explaining each station. */
  showLegend: boolean;
  /** Draw CRT scanlines and a slight bloom over the whole stage. */
  crtEffect: boolean;
  /** Draw the per-agent speech bubbles. */
  showBubbles: boolean;
}

/** Short caption shown in an agent's bubble. */
function bubbleText(agent: FloorAgent): string {
  if (agent.blocked) return 'Blocked';
  switch (agent.activity) {
    case 'pickup': return 'Taking a task';
    case 'reading': return 'Reading brief';
    case 'browsing': return 'Loading context';
    case 'searching': return 'Researching';
    case 'thinking': return 'Planning';
    case 'writing': return `Writing ${(agent.outputFormat ?? 'output').toUpperCase()}`;
    case 'delivering': return agent.destination === 'done' ? 'Filing to Done' : 'Sending to Review';
    case 'celebrating': return 'Handed in';
    case 'walk': return agent.taskId;
    default: return 'Idle';
  }
}

const PRIORITY_ACCENT: Record<string, string> = {
  critical: '#e0555a',
  high: '#e8853f',
  medium: '#57d4c4',
  low: '#8b88ab',
};

/** Draw the whole frame. Called once per animation frame from the view. */
export function render(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  options: RenderOptions,
): void {
  const t = performance.now();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);

  drawBackdrop(ctx);

  // --- Wall decor -----------------------------------------------------------
  blit(ctx, bake('whiteboard', R.WHITEBOARD), DECOR.whiteboard.x, DECOR.whiteboard.y);
  blit(ctx, bake('windowL', R.WINDOW), DECOR.windowLeft.x, DECOR.windowLeft.y);
  blit(ctx, bake('poster', R.POSTER), DECOR.poster.x, DECOR.poster.y);
  blit(ctx, bake('windowR', R.WINDOW), DECOR.windowRight.x, DECOR.windowRight.y);

  // The clock hand sweeps with real time, so the room reads as live.
  blit(ctx, bake('clock', R.CLOCK), DECOR.clock.x, DECOR.clock.y);
  const seconds = (Date.now() / 1000) % 60;
  const angle = (seconds / 60) * Math.PI * 2 - Math.PI / 2;
  ctx.fillStyle = '#12101c';
  ctx.fillRect(
    Math.round(DECOR.clock.x + 6 + Math.cos(angle) * 3),
    Math.round(DECOR.clock.y + 6 + Math.sin(angle) * 3),
    1,
    1,
  );

  // --- Floor decor ----------------------------------------------------------
  blit(ctx, bake('rug', R.RUG), DECOR.rug.x, DECOR.rug.y);

  // --- Back-row furniture ---------------------------------------------------
  blit(ctx, bake('shelf', R.BOOKSHELF), SHELF.sprite.x, SHELF.sprite.y);

  const agentAt = new Map<string, FloorAgent>();
  for (const agent of world.agents) {
    if (agent.station && agent.activity !== 'walk') agentAt.set(agent.station.id, agent);
  }

  for (const ws of WORKSTATIONS) {
    blit(ctx, bake('workstation', R.WORKSTATION), ws.sprite.x, ws.sprite.y);
    const user = agentAt.get(ws.id);
    const screen = screenFor(user ? user.activity : null, user?.outputFormat, t);
    blit(
      ctx,
      bake(`screen-${screenKey(user?.activity, user?.outputFormat, t)}`, screen),
      ws.sprite.x + R.WORKSTATION_SCREEN.x,
      ws.sprite.y + R.WORKSTATION_SCREEN.y,
    );
    if (user && (user.activity === 'writing' || user.activity === 'searching')) {
      // Monitor bloom.
      ctx.fillStyle = ROOM.glow;
      ctx.fillRect(ws.sprite.x + 2, ws.sprite.y + 4, 36, 26);
    }
  }

  blit(ctx, bake('rack', R.SERVER_RACK), DECOR.serverRack.x, DECOR.serverRack.y);
  blit(ctx, bake('coffee', X.COFFEE_MACHINE), DECOR.coffeeMachine.x, DECOR.coffeeMachine.y);
  blit(ctx, bake('cooler', R.WATER_COOLER), DECOR.waterCooler.x, DECOR.waterCooler.y);
  blit(ctx, bake('plant', R.PLANT), DECOR.plantLeft.x, DECOR.plantLeft.y);
  blit(ctx, bake('plant', R.PLANT), DECOR.plantRight.x, DECOR.plantRight.y);
  for (const chair of DECOR.chairs) {
    blit(ctx, bake('chair', R.CHAIR_SIDE), chair.x, chair.y);
  }

  // --- Desks and their paper stacks ----------------------------------------
  // Floor props, painted before the desks so the desks sit in front of them.
  blit(ctx, bake('lamp', X.FLOOR_LAMP), DECOR.floorLamp.x, DECOR.floorLamp.y);
  blit(ctx, bake('cabinet', X.FILING_CABINET), DECOR.filingCabinet.x, DECOR.filingCabinet.y);
  // The printer runs whenever somebody is producing an output.
  const printing = world.agents.some((a) => a.activity === 'writing');
  if (printing) {
    const frame = X.PRINTER_BUSY[Math.floor(t / 180) % X.PRINTER_BUSY.length];
    blit(ctx, bake(`printerBusy-${X.PRINTER_BUSY.indexOf(frame)}`, frame), DECOR.printer.x, DECOR.printer.y);
  } else {
    blit(ctx, bake('printer', X.PRINTER), DECOR.printer.x, DECOR.printer.y);
  }
  blit(ctx, bake('boxes', X.BOX_STACK), DECOR.boxes.x, DECOR.boxes.y);
  blit(ctx, bake('bin', X.TRASH_BIN), DECOR.trashBin.x, DECOR.trashBin.y);
  blit(ctx, bake('plantSmall', X.PLANT_SMALL), DECOR.plantSmall.x, DECOR.plantSmall.y);

  const desk = bake('desk', R.DESK);
  blit(ctx, desk, DESKS.backlog.sprite.x, DESKS.backlog.sprite.y);
  blit(ctx, desk, DESKS.review.sprite.x, DESKS.review.sprite.y);
  blit(ctx, desk, DESKS.done.sprite.x, DESKS.done.sprite.y);
  blit(ctx, bake('mug', R.MUG), DECOR.mug.x, DECOR.mug.y);
  blit(ctx, bake('tray', X.PAPER_TRAY), DECOR.paperTray.x, DECOR.paperTray.y);

  drawStack(ctx, DESKS.backlog.sprite.x, DESKS.backlog.sprite.y, world.piles.backlog.shown);
  drawStack(ctx, DESKS.review.sprite.x, DESKS.review.sprite.y, world.piles.review.shown);
  drawStack(ctx, DESKS.done.sprite.x, DESKS.done.sprite.y, world.piles.done.shown);
  blit(ctx, bake('clipboard', X.CLIPBOARD), DECOR.clipboard.x, DECOR.clipboard.y);

  // --- Agents, painted back to front so nearer ones overlap -----------------
  const cast = world.caretaker ? [...world.agents, world.caretaker] : world.agents;
  const ordered = cast.slice().sort((a, b) => a.pos.y - b.pos.y);
  for (const agent of ordered) {
    drawAgent(ctx, agent, t, options);
  }

  // The printed number is the workspace's real count. Only the stack height
  // above uses the eased value, so a growing pile animates while the label
  // stays truthful.
  const p = world.piles;
  drawDeskLabel(ctx, DESKS.backlog.sprite.x, DESKS.backlog.sprite.y, 'BACKLOG', p.backlog.target, '#8b88ab');
  drawDeskLabel(ctx, DESKS.review.sprite.x, DESKS.review.sprite.y, 'REVIEW', p.review.target, '#f2c14e');
  drawDeskLabel(ctx, DESKS.done.sprite.x, DESKS.done.sprite.y, 'DONE', p.done.target, '#5fbb62');

  if (world.caretaker && world.agents.length === 0) {
    drawTextOutlined(ctx, 'NO TASKS IN PROGRESS', 176, 258, '#8b88ab');
  }

  // --- Effects --------------------------------------------------------------
  for (const effect of world.effects) {
    drawEffect(ctx, effect, t);
  }

  if (options.showLegend) drawLegend(ctx);
  if (options.crtEffect) drawScanlines(ctx);
}

function screenKey(activity: Activity | undefined, format: string | undefined, t: number): string {
  if (!activity) return 'idle';
  if (activity === 'searching') return `search-${Math.floor(t / 220) % 4}`;
  if (activity === 'writing') {
    return Math.floor(t / 900) % 2 === 0 ? `write-${Math.floor(t / 260) % 4}` : `fmt-${format ?? 'generic'}`;
  }
  if (activity === 'thinking' || activity === 'reading') return `read-${Math.floor(t / 420) % 2}`;
  return 'idle';
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  agent: FloorAgent,
  t: number,
  options: RenderOptions,
): void {
  const skin = skinFor(agent.agentName);
  const { sprite, flip } = agentSprite(agent, t);
  const x = agent.pos.x - sprite.w / 2;
  const y = agent.pos.y - sprite.h;

  // Ground shadow.
  const shadow = bake('shadow', A.SHADOW);
  ctx.save();
  ctx.globalAlpha = 0.5;
  blit(ctx, shadow, agent.pos.x - shadow.w / 2, agent.pos.y - 2);
  ctx.restore();

  if (options.focusedTaskId === agent.taskId) {
    // Selection ring under the focused agent.
    ctx.strokeStyle = '#f2c14e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(Math.round(agent.pos.x), Math.round(agent.pos.y), 9, 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  const cacheId = `agent-${skin.id}-${agent.activity}-${sprite.rows.join('').length}-${sprite.rows[0]}-${sprite.rows[12] ?? ''}`;
  blit(ctx, bake(cacheId, sprite, skin.overrides), x, y, flip);

  // Carried props ride on top of the pose.
  if (agent.carrying === 'paper' && agent.activity === 'walk') {
    blit(ctx, bake('paperHeld', R.PAPER_HELD), x + (flip ? -2 : sprite.w - 8), y + 10);
  }
  if (agent.carrying === 'books' && agent.activity === 'walk') {
    blit(ctx, bake('bookStack', R.BOOK_STACK), x + 1, y + 8);
  }
  if (agent.activity === 'idle' && agent.taskId && !agent.blocked) {
    const frame = R.ZZZ[Math.floor(t / 500) % R.ZZZ.length];
    ctx.save();
    ctx.globalAlpha = 0.7;
    blit(ctx, bake(`zzz-idle-${R.ZZZ.indexOf(frame)}`, frame), x + sprite.w - 2, y - 8);
    ctx.restore();
  }
  if (agent.activity === 'browsing') {
    blit(ctx, bake('bookOpen', R.BOOK_OPEN), x + 1, y + 9);
  }

  // Walking agents get no bubble: a floor full of drifting labels is unreadable,
  // and the interesting states are the ones where the agent has stopped. A
  // blocked agent is the exception — standing still is exactly its state.
  const worthLabelling = agent.blocked || (agent.activity !== 'idle' && agent.activity !== 'walk');
  if (options.showBubbles && worthLabelling && agent.taskId) {
    drawBubble(
      ctx,
      agent.pos.x,
      y - 4,
      bubbleText(agent),
      agent.blocked ? '#e0555a' : PRIORITY_ACCENT[agent.priority] ?? PRIORITY_ACCENT['medium'],
    );
  }
}

/** Labels pointing at each station, toggled from the HUD. */
const LEGEND: Array<{ x: number; y: number; text: string }> = [
  { x: 88, y: 34, text: 'CONTEXT SHELF' },
  { x: 170, y: 44, text: 'TERMINALS' },
  { x: 340, y: 46, text: 'TOOLS' },
  { x: 36, y: 208, text: 'WAITING WORK' },
  { x: 216, y: 208, text: 'NEEDS REVIEW' },
  { x: 396, y: 208, text: 'FINISHED' },
];

function drawLegend(ctx: CanvasRenderingContext2D): void {
  for (const item of LEGEND) {
    const w = textWidth(item.text) + 6;
    ctx.fillStyle = 'rgba(18,16,28,0.78)';
    ctx.fillRect(item.x, item.y, w, 11);
    drawText(ctx, item.text, item.x + 3, item.y + 2, '#7de3f4');
  }
}

/** Faint scanlines and a subtle horizontal jitter band, for the CRT feel. */
function drawScanlines(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#000000';
  for (let y = 0; y < STAGE_H; y += 2) {
    ctx.fillRect(0, y, STAGE_W, 1);
  }
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#7de3f4';
  const band = Math.floor((performance.now() / 24) % (STAGE_H + 40)) - 20;
  ctx.fillRect(0, band, STAGE_W, 12);
  ctx.restore();
}

/** Reset cached art. Call if the palette ever becomes user-configurable. */
export function invalidateBackdrop(): void {
  backdrop = null;
}

export { BASE_PALETTE };
