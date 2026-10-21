import { useEffect, useState } from 'react';
import { useDataVersion } from '../store';

/**
 * Tasks store stakeholders as refs ("STK-0001"). Avatars need the person's name,
 * otherwise every initial reads "S". Avatar stacks render once per card, so one
 * fetch is shared by every caller and only repeated when stakeholders change.
 */
let cache: { version: number; promise: Promise<Map<string, string>> } | null = null;

function loadNames(version: number): Promise<Map<string, string>> {
  if (cache && cache.version === version) return cache.promise;
  const promise = fetch('/api/stakeholders')
    .then((res) => (res.ok ? res.json() : []))
    .then((list: { id: string; name: string }[]) => new Map(list.map((s) => [s.id, s.name])))
    .catch(() => new Map<string, string>());
  cache = { version, promise };
  return promise;
}

/** Returns a lookup that turns a stakeholder ref into a name, falling back to the ref. */
export function useStakeholderNames(): (ref: string) => string {
  const version = useDataVersion('stakeholders');
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    loadNames(version).then((map) => { if (alive) setNames(map); });
    return () => { alive = false; };
  }, [version]);

  return (ref: string) => names.get(ref) ?? ref;
}
