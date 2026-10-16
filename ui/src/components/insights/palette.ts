/**
 * Chart colours for the Insights screen.
 *
 * These are not picked by eye. They are derived from the app's own oklch tokens
 * in `index.css` and then run through the dataviz palette validator:
 *
 *   categorical pair  #255691, #bd7400   -> all checks pass (light)
 *   sequential ramp   5 steps, hue 255   -> all checks pass (--ordinal)
 *
 * If you change a value here, re-run the validator rather than trusting that it
 * still looks fine.
 *
 * The literal values now live in index.css, which carries a light and a dark
 * variant of each. Both hold the hue and vary only lightness, so the validated
 * hue separation survives the theme switch.
 */

/**
 * Two-series categorical, for created vs completed. Accent blue against a warm
 * amber: adjacent ΔE 24.2 under protanopia, 30.2 for normal vision.
 */
export const SERIES = {
  created: 'var(--chart-created)',
  completed: 'var(--chart-completed)',
} as const;

/**
 * Ordered ramp on the accent hue, receding to prominent. For ordinal scales only
 * (turnaround buckets, rework run counts) — never for nominal categories, where
 * a ramp would just double-encode the bar length.
 */
export const RAMP = [
  'var(--chart-ramp-1)',
  'var(--chart-ramp-2)',
  'var(--chart-ramp-3)',
  'var(--chart-ramp-4)',
  'var(--chart-ramp-5)',
] as const;

/** Pick a ramp step for position `i` of `n`, darkest at the end. */
export function rampStep(i: number, n: number): string {
  if (n <= 1) return RAMP[RAMP.length - 1];
  const idx = Math.round((i / (n - 1)) * (RAMP.length - 1));
  return RAMP[Math.max(0, Math.min(RAMP.length - 1, idx))];
}

/**
 * Emphasis form: the leading bar carries the accent, everything else recedes to
 * grey. Used where the story is the concentration itself, not the ranking.
 */
export const EMPHASIS = {
  lead: 'var(--color-accent)',
  rest: 'var(--color-border-strong)',
} as const;

/** Reserved status colours. Never reused as a series colour. */
export const STATUS = {
  overdue: 'var(--color-critical)',
  review: 'var(--color-accent)',
  due_soon: 'var(--color-warning)',
  stalled: 'var(--color-text-muted)',
} as const;
