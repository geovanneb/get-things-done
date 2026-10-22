import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;
export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100));

export interface ViewportHandle {
  /** Zooms so the whole chart is visible (never above 100%) and scrolls to the start. */
  fit: () => void;
}

interface ViewportProps {
  scale: number;
  onScale: (scale: number) => void;
  /** Fill the available height (full screen); otherwise the viewport is as tall as the scaled chart. */
  fill: boolean;
  children: ReactNode;
}

/**
 * The one scroll container for the chart view: zoom (CSS scale), with a sizer that has the scaled
 * size so scroll bars match what is on screen, drag-on-background to pan, and Ctrl/⌘ + wheel to zoom.
 * Cards keep their own HTML drag and drop; panning only starts on empty space.
 */
const OrgChartViewport = forwardRef<ViewportHandle, ViewportProps>(function OrgChartViewport({ scale, onScale, fill, children }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const latest = useRef({ scale, onScale });
  latest.current = { scale, onScale };

  // Natural (unscaled) size of the chart; offsetWidth/Height ignore the transform.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    fit() {
      const b = box.current;
      const el = content.current;
      if (!b || !el || !el.offsetWidth || !el.offsetHeight) return;
      const byWidth = (b.clientWidth - 16) / el.offsetWidth;
      const byHeight = fill ? (b.clientHeight - 16) / el.offsetHeight : Infinity;
      latest.current.onScale(clampScale(Math.min(byWidth, byHeight, 1)));
      b.scrollTo({ left: 0, top: 0 });
    },
  }), [fill]);

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report as ctrl + wheel) zooms.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { scale: s, onScale: set } = latest.current;
      set(clampScale(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.org-node, button, a, input, [role="menu"]')) return;
    const b = box.current!;
    pan.current = { x: e.clientX, y: e.clientY, left: b.scrollLeft, top: b.scrollTop };
    b.setPointerCapture(e.pointerId);
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p) return;
    box.current!.scrollLeft = p.left - (e.clientX - p.x);
    box.current!.scrollTop = p.top - (e.clientY - p.y);
  };
  const endPan = () => { pan.current = null; setPanning(false); };

  return (
    <div
      ref={box}
      className={`org-viewport${fill ? ' org-viewport--fill' : ''}${panning ? ' org-viewport--panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <div className="org-viewport__sizer" style={{ width: size.w * scale, height: size.h * scale }}>
        <div ref={content} className="org-viewport__content" style={{ transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
    </div>
  );
});

export default OrgChartViewport;
