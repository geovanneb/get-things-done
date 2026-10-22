import { useEffect, useState } from 'react';
import { useDataVersion } from '../store';

/** The slice of a stakeholder an avatar needs. */
export interface StakeholderSummary {
  name: string;
  role?: string;
  initials?: string;
}

/**
 * Tasks store stakeholders as refs ("STK-0001"). Avatars need the person's name,
 * otherwise every initial reads "S". Avatar stacks render once per card, so one
 * fetch is shared by every caller and only repeated when stakeholders change.
 */
let cache: { version: number; promise: Promise<Map<string, StakeholderSummary>> } | null = null;

function loadStakeholders(version: number): Promise<Map<string, StakeholderSummary>> {
  if (cache && cache.version === version) return cache.promise;
  const promise = fetch('/api/stakeholders')
    .then((res) => (res.ok ? res.json() : []))
    .then((list: { id: string; name: string; role?: string; avatar_initials?: string }[]) =>
      new Map(list.map((s) => [s.id, { name: s.name, role: s.role, initials: s.avatar_initials }])))
    .catch(() => new Map<string, StakeholderSummary>());
  cache = { version, promise };
  return promise;
}

/** Returns a lookup that turns a stakeholder ref into its summary, falling back to the ref as the name. */
export function useStakeholderNames(): (ref: string) => StakeholderSummary {
  const version = useDataVersion('stakeholders');
  const [stakeholders, setStakeholders] = useState<Map<string, StakeholderSummary>>(new Map());

  useEffect(() => {
    let alive = true;
    loadStakeholders(version).then((map) => { if (alive) setStakeholders(map); });
    return () => { alive = false; };
  }, [version]);

  return (ref: string) => stakeholders.get(ref) ?? { name: ref };
}
