import { getInitials } from '../../utils/format';

type AvatarSize = 'sm' | 'md' | 'lg';

interface AvatarProps {
  name: string;
  size?: AvatarSize;
  color?: string;
  /** Explicit initials (e.g. a stakeholder's `avatar_initials`); derived from `name` when omitted. */
  initials?: string;
  /** Shown next to the name on hover ("Jane Doe · CFO") when provided. */
  role?: string;
}

function hashColor(name: string): string {
  const hues = [25, 60, 100, 155, 200, 240, 280, 320];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % hues.length;
  }
  const hue = hues[Math.abs(hash)];
  return `oklch(0.55 0.12 ${hue})`;
}

const sizeMap: Record<AvatarSize, { size: number; fontSize: string }> = {
  // Two initials have to fit inside 24px, so the small size uses a fixed, tighter font.
  sm: { size: 24, fontSize: '10px' },
  md: { size: 32, fontSize: 'var(--text-sm)' },
  lg: { size: 44, fontSize: 'var(--text-md)' },
};

export default function Avatar({ name, size = 'md', color, initials: explicitInitials, role }: AvatarProps) {
  const { size: px, fontSize } = sizeMap[size];
  const bg = color ?? hashColor(name);
  const initials = explicitInitials?.trim() || getInitials(name);
  const label = role?.trim() ? `${name} · ${role.trim()}` : name;

  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: px,
        height: px,
        borderRadius: '50%',
        background: bg,
        color: 'oklch(1 0 0)',
        fontSize,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        // A ring in the surface colour keeps overlapping avatars in a stack readable.
        boxShadow: '0 0 0 2px var(--color-surface)',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {initials}
    </span>
  );
}
