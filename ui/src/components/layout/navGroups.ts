/**
 * The sidebar's default structure: grouped by the job each page does, ordered by how often
 * it is used (issue #191). Ids stay stable so a saved custom order can refer to them later.
 */

export type NavItemId =
  | 'situation'
  | 'board'
  | 'meetings'
  | 'insights'
  | 'context'
  | 'stakeholders'
  | 'outputs'
  | 'agents'
  | 'routines'
  | 'agent-floor'
  | 'profile'
  | 'settings';

export interface NavEntry {
  id: NavItemId;
  path: string;
  label: string;
}

export interface NavGroup {
  id: 'work' | 'memory' | 'automation' | 'account';
  /** Shown above the group. The work group has none: it is the top of the list. */
  heading?: string;
  items: NavEntry[];
}

export function navGroups({ agentFloor }: { agentFloor: boolean }): NavGroup[] {
  const automation: NavEntry[] = [
    { id: 'agents', path: '/agents', label: 'Agents & Skills' },
    { id: 'routines', path: '/routines', label: 'Routines' },
  ];
  // Experimental view, shown only while the Settings switch is on.
  if (agentFloor) automation.push({ id: 'agent-floor', path: '/agent-floor', label: 'Agent Floor' });

  return [
    {
      id: 'work',
      items: [
        { id: 'situation', path: '/situation', label: 'Situation' },
        { id: 'board', path: '/board', label: 'Board' },
        { id: 'meetings', path: '/meetings', label: 'Meetings' },
        { id: 'insights', path: '/insights', label: 'Insights' },
      ],
    },
    {
      id: 'memory',
      heading: 'Memory',
      items: [
        { id: 'context', path: '/context', label: 'Context' },
        { id: 'stakeholders', path: '/stakeholders', label: 'Stakeholders' },
        { id: 'outputs', path: '/outputs', label: 'Output templates' },
      ],
    },
    { id: 'automation', heading: 'Automation', items: automation },
    {
      id: 'account',
      items: [
        { id: 'profile', path: '/profile', label: 'Profile' },
        { id: 'settings', path: '/settings', label: 'Settings' },
      ],
    },
  ];
}
