export type MentionType = 'stakeholder' | 'context' | 'template' | 'task';

const ICON_PATHS: Record<MentionType, string> = {
  stakeholder: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 6c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5',
  context: 'M4 1.5h5.5L12.5 4.5V14a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5ZM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5',
  template: 'M2.5 2.5h4.5v4.5H2.5ZM9 2.5h4.5v4.5H9ZM2.5 9h4.5v4.5H2.5ZM9 9h4.5v4.5H9Z',
  task: 'M2.5 2.5h11v11h-11ZM5 8l2 2 4-4',
};

export default function MentionIcon({ type, size = 14 }: { type: MentionType; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d={ICON_PATHS[type]} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
