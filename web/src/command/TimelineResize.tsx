// The timeline's height (V3 §3): taller by default than it was (20 rem, not 15), a handle along its top
// edge to drag it taller or shorter (or the arrow keys on the handle, Home and End), and the height this
// browser last chose remembered. Desktop only: phones stack the regions and scroll. Built by lane A.
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** The default height (px): 20 rem. */
export const TIMELINE_DEFAULT_PX = 320;
export const TIMELINE_MIN_PX = 160;
/** At most this share of the window: the map keeps the rest. */
export const TIMELINE_MAX_SHARE = 0.7;
export const TIMELINE_STEP_PX = 24;
export const TIMELINE_KEY = "sightline.timelineHeight";

export const maxTimeline = (viewport: number) => Math.max(TIMELINE_MIN_PX, Math.round(viewport * TIMELINE_MAX_SHARE));
export const clampTimeline = (px: number, viewport: number) => Math.round(Math.min(maxTimeline(viewport), Math.max(TIMELINE_MIN_PX, px)));

/** The height this browser last left the timeline at, else the default. */
export function savedTimeline(viewport: number): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(TIMELINE_KEY));
    return Number.isFinite(v) && v > 0 ? clampTimeline(v, viewport) : clampTimeline(TIMELINE_DEFAULT_PX, viewport);
  } catch {
    return clampTimeline(TIMELINE_DEFAULT_PX, viewport);
  }
}
function save(px: number) {
  try {
    globalThis.localStorage?.setItem(TIMELINE_KEY, String(px));
  } catch {
    /* private mode: this page only */
  }
}

const viewportH = () => (typeof window === "undefined" ? 900 : window.innerHeight);

/** The height and its setter (clamped and remembered). */
export function useTimelineHeight(): [number, (px: number) => void] {
  const [h, setH] = useState(() => savedTimeline(viewportH()));
  const set = useCallback((px: number) => {
    const v = clampTimeline(px, viewportH());
    setH(v);
    save(v);
  }, []);
  return [h, set];
}

/** The handle along the timeline's top edge: drag it, or focus it and use the arrow keys. */
export function TimelineHandle({ height, onResize }: { height: number; onResize: (px: number) => void }) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const [active, setActive] = useState(false);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, h: height };
    setActive(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(drag.current.h - (e.clientY - drag.current.y)); // up is taller
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setActive(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? TIMELINE_STEP_PX * 4 : TIMELINE_STEP_PX;
    if (e.key === "ArrowUp") onResize(height + by);
    else if (e.key === "ArrowDown") onResize(height - by);
    else if (e.key === "Home") onResize(maxTimeline(viewportH()));
    else if (e.key === "End") onResize(TIMELINE_MIN_PX);
    else return;
    e.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the timeline"
      aria-valuenow={height}
      aria-valuemin={TIMELINE_MIN_PX}
      aria-valuemax={maxTimeline(viewportH())}
      tabIndex={0}
      title="Drag to resize the timeline (or the arrow keys)"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      className="group absolute inset-x-0 -top-2.5 z-10 hidden h-3 cursor-row-resize touch-none items-center justify-center lg:flex focus-visible:outline-none"
    >
      <span className={`h-1 w-12 rounded-full transition-colors ${active ? "bg-accent" : "bg-border group-hover:bg-text-3 group-focus-visible:bg-accent"}`} />
    </div>
  );
}
