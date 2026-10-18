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
 * on wide screens (`overlay`); if the map is too small for the full padding, it shrinks so at least
 * a third of the map stays for the survey.
 */
export function surveyPadding(width: number, height: number, overlay: boolean): Padding {
  if (!overlay) return { top: PLAIN, right: PLAIN, bottom: PLAIN, left: PLAIN };
  const sx = Math.min(1, (width * 2) / 3 / (OVERLAY.left + OVERLAY.right));
  const sy = Math.min(1, (height * 2) / 3 / (OVERLAY.top + OVERLAY.bottom));
  return {
    top: Math.round(OVERLAY.top * sy),
    right: Math.round(OVERLAY.right * sx),
    bottom: Math.round(OVERLAY.bottom * sy),
    left: Math.round(OVERLAY.left * sx),
  };
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
