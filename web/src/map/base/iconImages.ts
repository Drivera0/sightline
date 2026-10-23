// The console's icon set (shell/icons.tsx) as MapLibre images: the same 24-unit paths, stroked 2 px at
// one size (20 px), in each status colour, on a small dark disc so a mark reads over the heat and over
// imagery. A symbol layer picks one with ["concat", "icon-", kind, "-", tone]. Built by lane A.
import type { Map } from "maplibre-gl";
import { ICONS, type IconName } from "../../shell/icons";

export const ICON_PX = 20;
const RATIO = 2;
export const MAP_ICON_KINDS: readonly IconName[] = ["drone", "team", "clue", "base", "lkp", "found"];
export type IconTone = "accent" | "warn" | "ok" | "info" | "muted" | "text";
export const ICON_TONES: readonly IconTone[] = ["accent", "warn", "ok", "info", "muted", "text"];

export const iconImageId = (kind: IconName, tone: IconTone) => `icon-${kind}-${tone}`;

export interface IconColors extends Record<IconTone, string> {
  disc: string;
}

function draw(kind: IconName, stroke: string, disc: string): ImageData | null {
  if (typeof document === "undefined" || typeof Path2D === "undefined") return null;
  const el = document.createElement("canvas");
  const n = (ICON_PX + 4) * RATIO;
  el.width = n;
  el.height = n;
  const ctx = el.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.scale(RATIO, RATIO);
  // the disc: the icon's own ground (the heat and the imagery stay out from under the stroke)
  ctx.beginPath();
  ctx.arc((ICON_PX + 4) / 2, (ICON_PX + 4) / 2, (ICON_PX + 4) / 2 - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = disc;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.globalAlpha = 0.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  // the icon, 24 units into 16 px: a 2 px stroke at that scale is 2 × 24 / 16 = 3 units
  const s = 16 / 24;
  ctx.translate(4, 4);
  ctx.scale(s, s);
  ctx.lineWidth = 2 / s;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke;
  const icon = ICONS[kind];
  for (const d of icon.d) ctx.stroke(new Path2D(d));
  for (const [cx, cy, r] of icon.c) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, n, n);
}

/** Add every kind in every tone once (they go when the style reloads). */
export function ensureIconImages(map: Map, colors: IconColors): void {
  for (const kind of MAP_ICON_KINDS) {
    for (const tone of ICON_TONES) {
      const id = iconImageId(kind, tone);
      if (map.hasImage(id)) continue;
      const img = draw(kind, colors[tone], colors.disc);
      if (img) map.addImage(id, img, { pixelRatio: RATIO });
    }
  }
}
