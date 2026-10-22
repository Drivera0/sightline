// Images for the live map's labels, drawn once on a canvas (MapLibre symbols need images, not CSS):
// the "SIM" chip that sits on every simulated drone, and an invisible square that gives a dot a
// place in MapLibre's symbol collision so labels move off the dots instead of covering them.
// Built by lane A for lane B.
import type { Map } from "maplibre-gl";

export const FLEET_IMAGES = { sim: "fleet-sim-chip", hit: "fleet-dot-hit" } as const;

const RATIO = 2;

interface ChipColors {
  background: string;
  border: string;
  text: string;
}

function canvas(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const el = document.createElement("canvas");
  el.width = w * RATIO;
  el.height = h * RATIO;
  const ctx = el.getContext("2d");
  if (!ctx) return null;
  ctx.scale(RATIO, RATIO);
  return ctx;
}

function simChip(c: ChipColors): ImageData | null {
  const w = 24;
  const h = 12;
  const ctx = canvas(w, h);
  if (!ctx) return null;
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, w - 1, h - 1, 3);
  ctx.fillStyle = c.background;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = c.border;
  ctx.stroke();
  ctx.fillStyle = c.text;
  ctx.font = "600 8px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SIM", w / 2, h / 2 + 0.5);
  return ctx.getImageData(0, 0, w * RATIO, h * RATIO);
}

/** Add the chip and the hit square to the map once (they are lost when the style reloads). */
export function ensureFleetImages(map: Map, colors: ChipColors): void {
  if (!map.hasImage(FLEET_IMAGES.sim)) {
    const chip = simChip(colors);
    if (chip) map.addImage(FLEET_IMAGES.sim, chip, { pixelRatio: RATIO });
  }
  if (!map.hasImage(FLEET_IMAGES.hit)) {
    // 14 px: the drone's dot and its link ring. Fully transparent: only its collision box matters.
    const n = 14 * RATIO;
    map.addImage(FLEET_IMAGES.hit, { width: n, height: n, data: new Uint8Array(n * n * 4) }, { pixelRatio: RATIO });
  }
}
