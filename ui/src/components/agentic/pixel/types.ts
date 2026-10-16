/**
 * Shared contract for every hand-authored pixel sprite in the Agent Floor.
 *
 * A sprite is a rectangle of palette keys, one character per pixel. Keys are
 * semantic (`K` = skin, `S` = shirt, `B` = wood) rather than literal colours,
 * so a single sprite can be re-tinted per agent without duplicating the art.
 */
export interface PixelSprite {
  /** Width in pixels. Every row string must be exactly this long. */
  w: number;
  /** Height in pixels. `rows.length` must equal this. */
  h: number;
  /** One string per pixel row, top to bottom. `.` means transparent. */
  rows: string[];
}

/** Maps a palette key to a CSS colour. A `null` value means transparent. */
export type PixelPalette = Record<string, string | null>;

/** A named set of frames that plays in order. */
export interface SpriteAnimation {
  frames: PixelSprite[];
  /** Milliseconds each frame is held. */
  frameMs: number;
  /** When false the animation holds on its last frame instead of looping. */
  loop?: boolean;
}
