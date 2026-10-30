/**
 * Geometry of the square crop for a workspace picture. The image sits inside a square
 * viewport of `view` px: `scale` is screen px per image px, `x`/`y` the image's top-left
 * corner relative to the viewport (zero or negative, since the image always covers it).
 */
export interface CropState {
  scale: number;
  x: number;
  y: number;
}

export const MAX_ZOOM = 4;

/** The smallest scale at which the image still fills the viewport. */
export function coverScale(width: number, height: number, view: number): number {
  return view / Math.min(width, height);
}

/** Keeps the image covering the viewport, so the crop never shows an empty edge. */
export function clampOffset(state: CropState, width: number, height: number, view: number): CropState {
  const clamp = (value: number, min: number) => Math.min(0, Math.max(min, value));
  return { scale: state.scale, x: clamp(state.x, view - width * state.scale), y: clamp(state.y, view - height * state.scale) };
}

/** Centered at the smallest scale: the starting crop for a new picture. */
export function initialCrop(width: number, height: number, view: number): CropState {
  const scale = coverScale(width, height, view);
  return { scale, x: (view - width * scale) / 2, y: (view - height * scale) / 2 };
}

/** Zooms to `zoom` (1 = cover) while the viewport's center keeps showing the same spot. */
export function zoomTo(state: CropState, zoom: number, width: number, height: number, view: number): CropState {
  const base = coverScale(width, height, view);
  const scale = base * Math.min(MAX_ZOOM, Math.max(1, zoom));
  const cx = (view / 2 - state.x) / state.scale;
  const cy = (view / 2 - state.y) / state.scale;
  return clampOffset({ scale, x: view / 2 - cx * scale, y: view / 2 - cy * scale }, width, height, view);
}

/** The square of the original image that the viewport shows, in image px. */
export function sourceRect(state: CropState, view: number): { sx: number; sy: number; size: number } {
  return { sx: (0 - state.x) / state.scale, sy: (0 - state.y) / state.scale, size: view / state.scale };
}
