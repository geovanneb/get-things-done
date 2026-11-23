import { useEffect, useRef, useState } from 'react';
import { throttleDelay } from '../utils/liveEvents';

/**
 * `value`, changed at most once every `ms`: the first change at once, later ones at the end of the window with the
 * latest value, so nothing is missed. For a data version that moves often (a running transcription announces itself
 * about once a second) where a view only needs to follow it now and then.
 */
export function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (Object.is(value, shown)) return undefined;
    const pass = () => {
      last.current = Date.now();
      setShown(value);
    };
    const wait = throttleDelay(last.current, Date.now(), ms);
    if (wait === 0) {
      pass();
      return undefined;
    }
    const timer = setTimeout(pass, wait);
    return () => clearTimeout(timer);
  }, [value, shown, ms]);
  return shown;
}
