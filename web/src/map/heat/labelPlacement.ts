// Where the sector labels go on screen. MapLibre draws a symbol even when part of it runs off the
// canvas or sits under a panel drawn over the map, which left stray fragments ("CT", "ECTOR 1") at
// the map's edges. Each label has candidate positions; the first whose estimated text box lies fully
// inside the visible map, clear of every panel, is used, and a label with none is hidden.
// Pure functions: the caller projects points and measures the panels.
import type { Box } from "../base/camera";

export type TextAnchor = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** The sector labels' text size (layers.ts) and the line height MapLibre uses (1.2 em). */
export const LABEL_SIZE_PX = 11;
const LINE_HEIGHT_EM = 1.2;
/**
 * Upper estimate of one uppercase character's advance in Noto Sans at 11 px with 0.03 em letter
 * spacing (the widest capitals are about 0.72 em). Over-estimating only hides a label slightly early.
 */
const CHAR_EM = 0.72;

export interface LabelCandidate {
  anchor: TextAnchor;
  /** text-offset in ems, as MapLibre takes it. */
  offset: [number, number];
  /** [lon, lat] of the anchor point. */
  at: [number, number];
}

/** Estimated screen box of a label whose anchor point projects to `point`. */
export function labelBox(
  point: { x: number; y: number },
  anchor: TextAnchor,
  offset: readonly [number, number],
  text: string,
  sizePx = LABEL_SIZE_PX,
  charEm = CHAR_EM,
): Box {
  const lines = text.split("\n");
  const w = Math.max(...lines.map((l) => l.length)) * charEm * sizePx;
  const h = lines.length * LINE_HEIGHT_EM * sizePx;
  const x = point.x + offset[0] * sizePx;
  const y = point.y + offset[1] * sizePx;
  const left = anchor.endsWith("left") ? x : anchor.endsWith("right") ? x - w : x - w / 2;
  const top = anchor.startsWith("top") ? y : anchor.startsWith("bottom") ? y - h : y - h / 2;
  return { left, top, right: left + w, bottom: top + h };
}

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Whether the box lies inside `view` (shrunk by `margin`) and clear of every blocker. */
export function boxVisible(box: Box, view: Box, blockers: readonly Box[], margin = 2): boolean {
  if (box.left < view.left + margin || box.right > view.right - margin) return false;
  if (box.top < view.top + margin || box.bottom > view.bottom - margin) return false;
  return !blockers.some((b) => overlaps(box, b));
}

/**
 * The first candidate whose label is fully visible, or null (hide the label). `project` maps
 * [lon, lat] to container pixels; `view` and `blockers` are in the same pixels.
 */
export function placeLabel(
  candidates: readonly LabelCandidate[],
  text: string,
  project: (at: [number, number]) => { x: number; y: number },
  view: Box,
  blockers: readonly Box[],
): LabelCandidate | null {
  for (const c of candidates) {
    if (boxVisible(labelBox(project(c.at), c.anchor, c.offset, text), view, blockers)) return c;
  }
  return null;
}
