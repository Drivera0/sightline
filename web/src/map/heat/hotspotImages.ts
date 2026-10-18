// The numbered badges on the search-next circles (1, 2, 3… in the list's order), drawn once on a
// canvas because MapLibre symbols need images. An accent disc with a dark rim and a dark numeral: the
// rim keeps it apart from the orange and red heat underneath (Carbon's status-indicator rule: shape
// and label as well as colour). Without a canvas (jsdom) nothing is added, like droneImage.ts.
import type { Map } from "maplibre-gl";

/** How many ranks get a badge (the Search next list shows 5). */
export const HOTSPOT_BADGE_COUNT = 5;
export const HOTSPOT_BADGE_PREFIX = "heat-hotspot-badge-";
export const hotspotBadgeId = (rank: number) => `${HOTSPOT_BADGE_PREFIX}${rank}`;

/** Logical size of a badge in CSS px. */
export const HOTSPOT_BADGE_PX = 20;
const RIM = "rgba(10, 11, 13, 0.92)";

export interface BadgeColors {
  accent: string;
  /** The numeral and the rim: the app background. */
  veil: string;
}

/** Add the badge images if they are missing. Returns false when they cannot be drawn here. */
export function ensureHotspotBadges(map: Map, colors: BadgeColors): boolean {
  if (typeof document === "undefined" || typeof map.hasImage !== "function") return false;
  if (map.hasImage(hotspotBadgeId(1))) return true;
  const ratio = Math.max(1, Math.min(3, Math.round(globalThis.devicePixelRatio || 1)));
  for (let rank = 1; rank <= HOTSPOT_BADGE_COUNT; rank++) {
    const el = document.createElement("canvas");
    el.width = HOTSPOT_BADGE_PX * ratio;
    el.height = HOTSPOT_BADGE_PX * ratio;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = el.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return false;
    ctx.scale(ratio, ratio);
    const c = HOTSPOT_BADGE_PX / 2;
    ctx.beginPath();
    ctx.arc(c, c, c - 0.5, 0, Math.PI * 2);
    ctx.fillStyle = RIM;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, c - 2.5, 0, Math.PI * 2);
    ctx.fillStyle = colors.accent;
    ctx.fill();
    ctx.fillStyle = colors.veil || RIM;
    ctx.font = "700 11px 'Geist Mono Variable', ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(rank), c, c + 0.75);
    const data = ctx.getImageData(0, 0, el.width, el.height);
    map.addImage(hotspotBadgeId(rank), { width: el.width, height: el.height, data: new Uint8Array(data.data.buffer) }, { pixelRatio: ratio });
  }
  return true;
}
