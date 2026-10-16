import { FONT, GLYPH_H, GLYPH_W, glyphFor } from './font';

/** Pixels between glyphs when drawing a string. */
export const LETTER_SPACING = 1;

export function textWidth(text: string): number {
  if (text.length === 0) return 0;
  return text.length * (GLYPH_W + LETTER_SPACING) - LETTER_SPACING;
}

/**
 * Draw a string with the 5x7 bitmap font at integer coordinates. Canvas text
 * rendering would blur at these sizes, so every glyph is filled by hand.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colour: string,
): number {
  ctx.fillStyle = colour;
  let cursor = Math.round(x);
  const top = Math.round(y);
  for (const ch of text) {
    const glyph = glyphFor(ch);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const row = glyph[gy] ?? '';
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (row[gx] === '#') ctx.fillRect(cursor + gx, top + gy, 1, 1);
      }
    }
    cursor += GLYPH_W + LETTER_SPACING;
  }
  return cursor - x;
}

/** Draw text with a 1px dark outline so it stays readable over any background. */
export function drawTextOutlined(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colour: string,
  outline = '#12101c',
): void {
  for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    drawText(ctx, text, x + ox, y + oy, outline);
  }
  drawText(ctx, text, x, y, colour);
}

export { FONT, GLYPH_H, GLYPH_W };
