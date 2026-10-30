import React from 'react';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import { apiPut } from '@/utils/api';
import { CropState, MAX_ZOOM, clampOffset, coverScale, initialCrop, sourceRect, zoomTo } from '@/utils/iconCrop';

const VIEW = 240;
/** Sharp at the sizes the dashboard shows, small enough to stay well under the server limit. */
const OUTPUT = 256;
const PREVIEW = 28;

/**
 * Crops a local picture to a square and saves it as the current workspace's icon. The file is
 * read in the browser and only the cropped PNG reaches the local server; nothing leaves the machine.
 */
export default function WorkspaceIconCrop({ file, onClose, onSaved }: {
  file: File | null;
  onClose: () => void;
  onSaved: (iconVersion: string | null) => void;
}) {
  const [image, setImage] = React.useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = React.useState<CropState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const drag = React.useRef<{ pointer: number; startX: number; startY: number; from: CropState } | null>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);

  // Decode the chosen file. An unsupported format (HEIC in most browsers, for example) fails here.
  React.useEffect(() => {
    if (!file) return;
    setImage(null);
    setCrop(null);
    setError(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      setImage(img);
      setCrop(initialCrop(img.naturalWidth, img.naturalHeight, VIEW));
    };
    img.onerror = () => {
      if (!cancelled) setError('This picture could not be opened. Try a PNG, JPG or WebP file.');
    };
    img.src = url;
    return () => { cancelled = true; URL.revokeObjectURL(url); };
  }, [file]);

  const w = image?.naturalWidth ?? 1;
  const h = image?.naturalHeight ?? 1;
  const zoom = crop ? crop.scale / coverScale(w, h, VIEW) : 1;

  const move = (dx: number, dy: number, from: CropState) =>
    setCrop(clampOffset({ scale: from.scale, x: from.x + dx, y: from.y + dy }, w, h, VIEW));

  // Wheel zoom needs a non-passive listener so the page does not scroll at the same time.
  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el || !image) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setCrop((prev) => prev && zoomTo(prev, (prev.scale / coverScale(w, h, VIEW)) * Math.exp(-e.deltaY / 400), w, h, VIEW));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [image, w, h]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!crop) return;
    const step = e.shiftKey ? 40 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); move(moves[e.key][0], moves[e.key][1], crop); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setCrop(zoomTo(crop, zoom * 1.1, w, h, VIEW)); }
    if (e.key === '-') { e.preventDefault(); setCrop(zoomTo(crop, zoom / 1.1, w, h, VIEW)); }
  };

  const save = async () => {
    if (!image || !crop) return;
    setSaving(true);
    setError(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Your browser could not prepare the picture.');
      ctx.imageSmoothingQuality = 'high';
      const { sx, sy, size } = sourceRect(crop, VIEW);
      ctx.drawImage(image, sx, sy, size, size, 0, 0, OUTPUT, OUTPUT);
      const result = await apiPut<{ icon_version: string | null }>('/api/workspace/icon', { image: canvas.toDataURL('image/png') });
      onSaved(result.icon_version);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the picture.');
    } finally {
      setSaving(false);
    }
  };

  /** The image placed for a square of `box` px, from the same crop. */
  const placed = (box: number): React.CSSProperties | undefined => crop ? {
    position: 'absolute', left: 0, top: 0, maxWidth: 'none', userSelect: 'none', pointerEvents: 'none',
    width: w * crop.scale * (box / VIEW), height: h * crop.scale * (box / VIEW),
    transform: `translate(${crop.x * (box / VIEW)}px, ${crop.y * (box / VIEW)}px)`,
  } : undefined;

  return (
    <Modal isOpen={file !== null} onClose={() => { if (!saving) onClose(); }} title="Workspace Picture" size="sm">
      <p style={{ margin: '0 0 16px 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
        Drag to move the picture, and zoom to choose what shows. It stays on this computer.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div
          ref={viewportRef}
          tabIndex={0}
          role="img"
          aria-label="Crop area. Use the arrow keys to move the picture, and plus or minus to zoom."
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            if (!crop) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, from: crop };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d && d.pointer === e.pointerId) move(e.clientX - d.startX, e.clientY - d.startY, d.from);
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          style={{
            position: 'relative', width: VIEW, height: VIEW, overflow: 'hidden', touchAction: 'none',
            borderRadius: 'var(--radius-lg)', background: 'var(--color-bg)', border: '1px solid var(--color-border)',
            cursor: crop ? 'grab' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {image && crop
            ? <img src={image.src} alt="" draggable={false} style={placed(VIEW)} />
            : !error && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Loading...</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: VIEW }}>
          <label htmlFor="workspace-icon-zoom" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
            Zoom
          </label>
          <input
            id="workspace-icon-zoom"
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!crop}
            onChange={(e) => crop && setCrop(zoomTo(crop, Number(e.target.value), w, h, VIEW))}
            style={{ flex: 1, accentColor: 'var(--color-accent)' }}
          />
          {/* What it looks like at the size the sidebar shows. */}
          <span
            aria-hidden="true"
            title="How it looks in the sidebar"
            style={{ position: 'relative', width: PREVIEW, height: PREVIEW, flexShrink: 0, overflow: 'hidden', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
          >
            {image && crop && <img src={image.src} alt="" draggable={false} style={placed(PREVIEW)} />}
          </span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 16, padding: '10px 14px', background: 'var(--color-critical-subtle)', border: '1px solid var(--color-critical)',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', color: 'var(--color-critical)',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!crop || saving}>
          {saving ? 'Saving...' : 'Save Picture'}
        </Button>
      </div>
    </Modal>
  );
}
