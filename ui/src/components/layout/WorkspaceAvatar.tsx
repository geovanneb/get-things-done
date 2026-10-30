import React from 'react';

/** Same folder, same color, on every machine: recognisable at a glance in the rail. */
function workspaceHue(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The picture of a workspace; the version in the URL makes a changed picture load fresh. */
export function workspaceIconUrl(path: string, version: string): string {
  return `/api/workspace/icon?path=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}`;
}

/** The workspace's picture when it has one, otherwise its first letter on a color from its path. */
export default function WorkspaceAvatar({ name, path, iconVersion, size = 24 }: {
  name: string;
  path: string;
  iconVersion?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [path, iconVersion]);

  const box: React.CSSProperties = { width: size, height: size, flexShrink: 0, borderRadius: 'var(--radius-sm)' };

  if (iconVersion && !broken) {
    return (
      <img
        src={workspaceIconUrl(path, iconVersion)}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setBroken(true)}
        style={{ ...box, objectFit: 'cover', display: 'block' }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        ...box,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `oklch(0.62 0.13 ${workspaceHue(path)})`, color: 'white',
        fontSize: size >= 24 ? 'var(--text-sm)' : 'var(--text-xs)', fontWeight: 700, lineHeight: 1,
      }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
