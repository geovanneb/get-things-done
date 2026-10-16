import { PixelSprite, PixelPalette } from './types';
import { BASE_PALETTE } from './palette';

/**
 * A sprite baked onto an offscreen canvas so the render loop can blit it with a
 * single `drawImage` instead of thousands of `fillRect` calls per frame.
 */
export interface BakedSprite {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

const cache = new Map<string, BakedSprite>();

function paletteKey(overrides?: PixelPalette): string {
  if (!overrides) return '-';
  return Object.keys(overrides)
    .sort()
    .map((k) => `${k}${overrides[k]}`)
    .join('');
}

/**
 * Rasterise a sprite once and keep it. `cacheId` must be unique per sprite;
 * the palette override is folded into the key so two agents with different
 * shirts each get their own baked copy.
 */
export function bake(cacheId: string, sprite: PixelSprite, overrides?: PixelPalette): BakedSprite {
  const key = `${cacheId}|${paletteKey(overrides)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const palette: PixelPalette = overrides ? { ...BASE_PALETTE, ...overrides } : BASE_PALETTE;
  const canvas = document.createElement('canvas');
  canvas.width = sprite.w;
  canvas.height = sprite.h;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < sprite.rows.length; y++) {
      const row = sprite.rows[y];
      for (let x = 0; x < row.length; x++) {
        const colour = palette[row[x]];
        if (!colour) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  const baked: BakedSprite = { canvas, w: sprite.w, h: sprite.h };
  cache.set(key, baked);
  return baked;
}

/** Blit a baked sprite at integer coordinates, optionally mirrored. */
export function blit(
  ctx: CanvasRenderingContext2D,
  baked: BakedSprite,
  x: number,
  y: number,
  flipX = false,
): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (!flipX) {
    ctx.drawImage(baked.canvas, px, py);
    return;
  }
  ctx.save();
  ctx.translate(px + baked.w, py);
  ctx.scale(-1, 1);
  ctx.drawImage(baked.canvas, 0, 0);
  ctx.restore();
}

/**
 * Draw a baked sprite tinted by a flat colour at a given alpha — used for the
 * soft "ghost" trail behind a walking agent and for selection highlights.
 */
export function blitTinted(
  ctx: CanvasRenderingContext2D,
  baked: BakedSprite,
  x: number,
  y: number,
  colour: string,
  alpha: number,
  flipX = false,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  blit(ctx, baked, x, y, flipX);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x), Math.round(y), baked.w, baked.h);
  ctx.restore();
}

/** Validate a sprite's rows against its declared size. Dev aid, cheap to run. */
export function assertSprite(name: string, sprite: PixelSprite): PixelSprite {
  if (sprite.rows.length !== sprite.h) {
    // eslint-disable-next-line no-console
    console.warn(`[pixel] ${name}: declared h=${sprite.h} but has ${sprite.rows.length} rows`);
  }
  const bad = sprite.rows.findIndex((r) => r.length !== sprite.w);
  if (bad >= 0) {
    // eslint-disable-next-line no-console
    console.warn(`[pixel] ${name}: row ${bad} has length ${sprite.rows[bad].length}, expected ${sprite.w}`);
  }
  return sprite;
}
