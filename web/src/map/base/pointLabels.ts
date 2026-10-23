// The live map's point labels, placed in one pass across every kind of mark (heat/labelPlacement.ts's
// boxes and visibility test). MapLibre's own collision placed each label layer on its own terms: it kept
// text off other text but not off the other layers' icons, and wrapped long labels over their neighbours
// ("Found by Team One in C2" over T1 and c001). Here every icon is an obstacle and the labels go in
// priority order: the find, the last known point, base camp, teams, drones, clues. Each tries eight spots
// next to its own icon, then the same eight further out (drawn with a leader line back to the icon), and
// is left off the map when none is free (the find and the last known point always show). Teams waiting at
// base camp share one chip, "T1 T2 T3 at base". Pure: the caller projects and draws. Built by lane A.
import type { Box } from "./camera";
import { boxVisible, LABEL_SIZE_PX, labelBox, type TextAnchor } from "../heat/labelPlacement";

export type PointLabelKind = "found" | "lkp" | "base" | "team" | "drone" | "clue";

/** Who wins a contested spot: lower first. */
export const LABEL_PRIORITY: Record<PointLabelKind, number> = { found: 0, lkp: 1, base: 2, team: 3, drone: 4, clue: 5 };

export interface PointLabelInput {
  id: string;
  kind: PointLabelKind;
  text: string;
  /** The icon's centre in container pixels. */
  at: { x: number; y: number };
  /** Text size in px. */
  size?: number;
  /** Shown even when every spot is taken (then it takes its first spot): the find, the last known point. */
  required?: boolean;
}

export interface PlacedLabel {
  id: string;
  anchor: TextAnchor;
  /** The text's offset from the icon's centre in px (MapLibre takes ems: divide by the text size). */
  offset: [number, number];
  box: Box;
  /** On the outer ring: the map draws a leader line from the icon to the label. */
  displaced: boolean;
}

/** Half a mark's icon (iconImages: 22 px discs) plus a little air. */
export const ICON_RADIUS_PX = 12;
/** Mixed-case Noto Sans: about 0.55 em a character on average; 0.6 is an upper estimate. */
export const MIXED_CHAR_EM = 0.6;
/** The eight spots around an icon: the text's anchor and the unit direction from the icon to it. */
const DIRECTIONS: readonly [TextAnchor, number, number][] = [
  ["left", 1, 0],
  ["right", -1, 0],
  ["bottom", 0, -1],
  ["top", 0, 1],
  ["bottom-left", 0.75, -0.75],
  ["top-left", 0.75, 0.75],
  ["bottom-right", -0.75, -0.75],
  ["top-right", -0.75, 0.75],
];
/** How far out the two rings are from the icon's centre (px): next to it, then far enough for a leader line. */
export const LABEL_RINGS_PX = [ICON_RADIUS_PX + 2, ICON_RADIUS_PX + 26] as const;

const iconBox = (p: { x: number; y: number }, r = ICON_RADIUS_PX - 2): Box => ({ left: p.x - r, top: p.y - r, right: p.x + r, bottom: p.y + r });
const hits = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/**
 * Place every label. `icons` are the centres of every mark on the map (labelled or not); `view` and
 * `blockers` (panels over the map) are in the same container pixels. Returns the placed labels by id.
 */
export function layoutPointLabels(
  labels: readonly PointLabelInput[],
  icons: readonly { x: number; y: number }[],
  view: Box,
  blockers: readonly Box[] = [],
): Map<string, PlacedLabel> {
  const out = new Map<string, PlacedLabel>();
  // a label may sit over its own icon's box (and a mark drawn on the very same spot), never another's
  const taken: { box: Box; at?: { x: number; y: number } }[] = icons.map((p) => ({ box: iconBox(p), at: p }));
  const order = [...labels].sort((a, b) => LABEL_PRIORITY[a.kind] - LABEL_PRIORITY[b.kind]);
  for (const l of order) {
    const size = l.size ?? LABEL_SIZE_PX;
    let first: PlacedLabel | null = null;
    let chosen: PlacedLabel | null = null;
    for (const [ring, dist] of LABEL_RINGS_PX.entries()) {
      for (const [anchor, ux, uy] of DIRECTIONS) {
        const offset: [number, number] = [ux * dist, uy * dist];
        const box = labelBox(l.at, anchor, [offset[0] / size, offset[1] / size], l.text, size, MIXED_CHAR_EM);
        const cand: PlacedLabel = { id: l.id, anchor, offset, box, displaced: ring > 0 };
        first ??= cand;
        if (!boxVisible(box, view, blockers)) continue;
        if (taken.some((t) => !(t.at && near(t.at, l.at)) && hits(box, t.box))) continue;
        chosen = cand;
        break;
      }
      if (chosen) break;
    }
    const placed = chosen ?? (l.required ? first : null);
    if (!placed) continue;
    out.set(l.id, placed);
    taken.push({ box: placed.box });
  }
  return out;
}

/** The point a leader line ends at: the label box's nearest point to the icon, pulled 2 px back. */
export function leaderEnd(at: { x: number; y: number }, box: Box): { x: number; y: number } {
  const x = Math.min(box.right, Math.max(box.left, at.x));
  const y = Math.min(box.bottom, Math.max(box.top, at.y));
  const dx = x - at.x;
  const dy = y - at.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: x - (dx / d) * 2, y: y - (dy / d) * 2 };
}

/** The point a leader line starts at: the icon's edge, towards the label. */
export function leaderStart(at: { x: number; y: number }, end: { x: number; y: number }): { x: number; y: number } {
  const dx = end.x - at.x;
  const dy = end.y - at.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: at.x + (dx / d) * ICON_RADIUS_PX, y: at.y + (dy / d) * ICON_RADIUS_PX };
}

/**
 * Teams waiting at base camp share one chip ("T1 T2 T3 at base") instead of three labels on one spot:
 * the ids of the teams within `withinM` metres of the camp, in the order given.
 */
export function teamsAtBase(
  teams: readonly { id: string; lon: number; lat: number }[],
  camp: { lon: number; lat: number } | null | undefined,
  withinM = 40,
): string[] {
  if (!camp) return [];
  const k = Math.cos((camp.lat * Math.PI) / 180);
  return teams.filter((t) => Math.hypot((t.lat - camp.lat) * 111_320, (t.lon - camp.lon) * 111_320 * k) <= withinM).map((t) => t.id);
}

/** The chip for the teams at base: "T1 T2 T3 at base" (one team: "T1 at base"). */
export function atBaseText(shorts: readonly string[]): string {
  return `${[...shorts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(" ")} at base`;
}
