import { useEffect, useState } from 'react';
import { followDesktopUpdate, hasDesktopUpdates, type DesktopUpdate } from '@/utils/desktop';

/** The desktop app's own update as it changes (#284); null in a browser or until the app answers. */
export function useDesktopUpdate(): DesktopUpdate | null {
  const [state, setState] = useState<DesktopUpdate | null>(null);
  useEffect(() => (hasDesktopUpdates() ? followDesktopUpdate(setState) : undefined), []);
  return state;
}
