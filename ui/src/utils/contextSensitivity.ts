/** Whole-note sharing labels on context notes (#107). No label counts as internal. */
export const SENSITIVITY_OPTIONS = ['shareable', 'internal', 'personal'] as const;

/** The editor's value for a label it cannot show as a choice (anything unknown in the file). */
export const UNKNOWN_SENSITIVITY = '__unknown__';

/** Empty or missing counts as none; anything else is either a known label or unknown. */
export function sensitivityState(value: unknown): 'none' | 'known' | 'unknown' {
  if (value === undefined || value === null || value === '') return 'none';
  return (SENSITIVITY_OPTIONS as readonly unknown[]).includes(value) ? 'known' : 'unknown';
}

/** The editor's starting value: '' for none, the label, or UNKNOWN_SENSITIVITY. */
export function sensitivityFormValue(value: unknown): string {
  const state = sensitivityState(value);
  return state === 'known' ? (value as string) : state === 'none' ? '' : UNKNOWN_SENSITIVITY;
}

/**
 * What a save sends: the label only when the user changed it, so a save never rewrites a label it did not
 * choose (a newer one set elsewhere, or an unknown one kept for the user to fix). '' sends null (remove).
 */
export function sensitivityPatch(started: string, current: string): { sensitivity?: string | null } {
  if (current === started || current === UNKNOWN_SENSITIVITY) return {};
  return { sensitivity: current || null };
}
