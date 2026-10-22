// Dan's drone icon (drone.svg, nose up) rasterised once for MapLibre: a light stroke in the --text
// token over a dark rim, so it holds 3:1 contrast on the dark basemap and on the bright heat.
// Without a canvas (jsdom) nothing is added, like base/pinImages.ts.
import type { Map } from "maplibre-gl";
import droneSvg from "./drone.svg?raw";

export const DRONE_IMAGE_ID = "heat-drone-icon";
/** Logical size of the drawn icon in CSS px; icon-size 1 keeps it at this size (about 36 px on screen). */
export const DRONE_IMAGE_PX = 36;
export const DRONE_ICON_SIZE = 1;
const VIEWBOX = 64;
const STROKE = 2.4;
const RIM = "rgba(10, 11, 13, 0.9)";

/** The icon's shapes from drone.svg: the body rect and each path's d attribute. */
export function droneShapes(svg: string = droneSvg): {
  body: { x: number; y: number; w: number; h: number; r: number } | null;
  paths: string[];
} {
  const rect = /<rect[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"[^>]*\brx="([\d.]+)"/.exec(svg);
  const body = rect
    ? { x: Number(rect[1]), y: Number(rect[2]), w: Number(rect[3]), h: Number(rect[4]), r: Number(rect[5]) }
    : null;
  const paths = [...svg.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1] as string);
  return { body, paths };
}

/** The raw SVG with its stroke colour set, for the legend. */
export function droneSvgMarkup(): string {
  return droneSvg;
}

function strokeIcon(ctx: CanvasRenderingContext2D, color: string, width: number): void {
  const { body, paths } = droneShapes();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (body) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(body.x, body.y, body.w, body.h, body.r);
    else ctx.rect(body.x, body.y, body.w, body.h);
    ctx.stroke();
  }
  for (const d of paths) ctx.stroke(new Path2D(d));
}

/** Add the drone image to the map if it is missing. Returns false when it cannot be drawn here. */
export function ensureDroneImage(map: Map, color: string): boolean {
  if (typeof document === "undefined" || typeof Path2D === "undefined") return false;
  if (map.hasImage?.(DRONE_IMAGE_ID)) return true;
  const ratio = Math.max(1, Math.min(3, Math.round(globalThis.devicePixelRatio || 1)));
  const el = document.createElement("canvas");
  el.width = DRONE_IMAGE_PX * ratio;
  el.height = DRONE_IMAGE_PX * ratio;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = el.getContext("2d", { willReadFrequently: true });
  } catch {
    ctx = null;
  }
  if (!ctx) return false;
  ctx.scale((DRONE_IMAGE_PX * ratio) / VIEWBOX, (DRONE_IMAGE_PX * ratio) / VIEWBOX);
  // Rim first (wider, dark), then the light stroke on top.
  strokeIcon(ctx, RIM, STROKE + 3.2);
  strokeIcon(ctx, color, STROKE);
  const data = ctx.getImageData(0, 0, el.width, el.height);
  map.addImage(DRONE_IMAGE_ID, { width: el.width, height: el.height, data: new Uint8Array(data.data.buffer) }, { pixelRatio: ratio });
  return true;
}
