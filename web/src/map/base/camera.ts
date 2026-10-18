// Calm camera rules for the map: small, quick moves, and none at all when nothing needs to move.

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Review's candidate moves: a short ease, never a swooping fly. */
export const EASE_MS = 400;

/** Search next's overlay panels on wide screens (the sectors list left, the legend right, replay below). */
const OVERLAY: Padding = { top: 64, right: 300, bottom: 112, left: 352 };
const PLAIN = 48;

/**
 * Padding that frames the survey clear of the panels drawn over the map. Panels overlay the map only
 * on wide screens (`overlay`). `measured` is the padding read from the panels actually on screen
 * (overlayPadding); without it a fixed guess is used. If the map is too small for the full padding,
 * it shrinks so at least a third of the map stays for the survey.
 */
export function surveyPadding(width: number, height: number, overlay: boolean, measured?: Padding): Padding {
  if (!overlay && !measured) return { top: PLAIN, right: PLAIN, bottom: PLAIN, left: PLAIN };
  return shrinkToFit(width, height, measured ?? OVERLAY);
}

/** Scale the padding down per axis so at least a third of the map's width and height stays free. */
export function shrinkToFit(width: number, height: number, pad: Padding): Padding {
  const sx = Math.min(1, (width * 2) / 3 / Math.max(1, pad.left + pad.right));
  const sy = Math.min(1, (height * 2) / 3 / Math.max(1, pad.top + pad.bottom));
  return {
    top: Math.round(pad.top * sy),
    right: Math.round(pad.right * sx),
    bottom: Math.round(pad.bottom * sy),
    left: Math.round(pad.left * sx),
  };
}

/** A screen rectangle in CSS pixels (a DOMRect's edges). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Which edge of the map a panel drawn over it hugs. "corner" is a panel in the bottom-right corner
 * (the legend, Review's readout card): it is counted against the right or the bottom edge, whichever
 * leaves the larger square for the survey.
 */
export type OverlaySide = "left" | "right" | "top" | "bottom" | "corner";
export interface Overlay {
  side: OverlaySide;
  rect: Box;
}

/** Space kept between a panel and the photographed area. */
export const OVERLAY_GAP_PX = 16;
/** The margin on a side with no panel. */
export const EDGE_MARGIN_PX = 24;

/**
 * fitBounds padding from the panels actually drawn over the map (their measured rectangles), so the
 * photographed area lands in the visible gap between them. Pure: the DOM is read by readOverlays.
 */
export function overlayPadding(container: Box, overlays: readonly Overlay[], gap = OVERLAY_GAP_PX): Padding {
  const pad: Padding = { top: EDGE_MARGIN_PX, right: EDGE_MARGIN_PX, bottom: EDGE_MARGIN_PX, left: EDGE_MARGIN_PX };
  const width = container.right - container.left;
  const height = container.bottom - container.top;
  const corners: Box[] = [];
  for (const { side, rect } of overlays) {
    const hits =
      rect.right > container.left && rect.left < container.right && rect.bottom > container.top && rect.top < container.bottom;
    if (!hits || rect.right <= rect.left || rect.bottom <= rect.top) continue;
    if (side === "left") pad.left = Math.max(pad.left, rect.right - container.left + gap);
    else if (side === "right") pad.right = Math.max(pad.right, container.right - rect.left + gap);
    else if (side === "top") pad.top = Math.max(pad.top, rect.bottom - container.top + gap);
    else if (side === "bottom") pad.bottom = Math.max(pad.bottom, container.bottom - rect.top + gap);
    else corners.push(rect);
  }
  for (const rect of corners) {
    const right = Math.max(pad.right, container.right - rect.left + gap);
    const bottom = Math.max(pad.bottom, container.bottom - rect.top + gap);
    const squareIfRight = Math.min(width - pad.left - right, height - pad.top - pad.bottom);
    const squareIfBottom = Math.min(width - pad.left - pad.right, height - pad.top - bottom);
    if (squareIfRight >= squareIfBottom) pad.right = right;
    else pad.bottom = bottom;
  }
  return pad;
}

/** The attribute that marks a panel drawn over the map, with its OverlaySide as the value. */
export const OVERLAY_ATTR = "data-map-overlay";
const SIDES = new Set<string>(["left", "right", "top", "bottom", "corner"]);

/** The visible panels marked with OVERLAY_ATTR inside `root` (hidden ones have an empty rectangle). */
export function readOverlays(root: ParentNode | null | undefined): Overlay[] {
  if (!root) return [];
  const out: Overlay[] = [];
  root.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => {
    const side = el.getAttribute(OVERLAY_ATTR) ?? "";
    const r = el.getBoundingClientRect();
    if (SIDES.has(side) && r.width > 0 && r.height > 0) {
      out.push({ side: side as OverlaySide, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
    }
  });
  return out;
}

/** Padding for the map in `container` from the marked panels around it, or null when there are none. */
export function measuredPadding(container: HTMLElement): Padding | null {
  const overlays = readOverlays(container.parentElement);
  if (overlays.length === 0) return null;
  const r = container.getBoundingClientRect();
  return overlayPadding({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, overlays);
}

/** easeTo offset that puts the target point in the middle of the gap the padding leaves. */
export function paddingOffset(pad: Padding): [number, number] {
  return [Math.round((pad.left - pad.right) / 2), Math.round((pad.top - pad.bottom) / 2)];
}

/**
 * Whether a screen point sits inside the viewport shrunk by `inset` (a fraction of each side): a pin
 * there is already comfortably visible, so the camera need not move.
 */
export function insidePaddedViewport(
  point: { x: number; y: number },
  width: number,
  height: number,
  inset = 0.15,
): boolean {
  return (
    point.x >= width * inset &&
    point.x <= width * (1 - inset) &&
    point.y >= height * inset &&
    point.y <= height * (1 - inset)
  );
}
