import type { Map } from "maplibre-gl";

/**
 * Marker images for the review states, drawn once on a canvas because MapLibre symbols need
 * images, not CSS. Each state differs in shape and icon as well as colour (Carbon's status
 * indicator rule: never colour alone), and every mark has a dark rim so it holds 3:1 contrast
 * on both the offline basemap and satellite imagery.
 */
export const PIN_IMAGES = {
  person: "pin-person",
  unsure: "pin-unsure",
  notPerson: "pin-not-person",
  unreviewed: "pin-unreviewed",
  chipPerson: "pin-chip-person",
  chipUnsure: "pin-chip-unsure",
  chipNeutral: "pin-chip-neutral",
} as const;

interface PinColors {
  accent: string;
  background: string;
  text: string;
  textSecondary: string;
  warning: string;
}

const RATIO = 2;
const RIM = "rgba(10, 10, 12, 0.85)";

function canvas(
  widthPx: number,
  heightPx: number,
): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const el = document.createElement("canvas");
  el.width = widthPx * RATIO;
  el.height = heightPx * RATIO;
  const ctx = el.getContext("2d");
  if (!ctx) return null;
  ctx.scale(RATIO, RATIO);
  return ctx;
}

function disc(
  ctx: CanvasRenderingContext2D,
  c: number,
  r: number,
  fill: string,
  ring: string,
  ringPx: number,
) {
  ctx.beginPath();
  ctx.arc(c, c, r + ringPx / 2 + 1.25, 0, Math.PI * 2);
  ctx.fillStyle = RIM;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = ringPx;
  ctx.strokeStyle = ring;
  ctx.stroke();
}

function stroke(
  ctx: CanvasRenderingContext2D,
  color: string,
  widthPx: number,
  points: [number, number][][],
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [w, c] of [
    [widthPx + 2.5, RIM],
    [widthPx, color],
  ] as const) {
    ctx.lineWidth = w;
    ctx.strokeStyle = c;
    for (const line of points) {
      ctx.beginPath();
      line.forEach(([x, y], i) =>
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y),
      );
      ctx.stroke();
    }
  }
}

function image(ctx: CanvasRenderingContext2D): ImageData {
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** A rounded pill that stretches around its text (MapLibre's icon-text-fit). */
function chip(
  color: string,
  background: string,
): { data: ImageData; options: object } | null {
  const w = 32;
  const h = 24;
  const r = 9;
  const ctx = canvas(w, h);
  if (!ctx) return null;
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, h - 2, r);
  ctx.fillStyle = background;
  ctx.globalAlpha = 0.94;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.stroke();
  return {
    data: image(ctx),
    options: {
      pixelRatio: RATIO,
      stretchX: [[(r + 1) * RATIO, (w - r - 1) * RATIO]],
      stretchY: [[(r + 1) * RATIO, (h - r - 1) * RATIO]],
      content: [
        (r - 2) * RATIO,
        4 * RATIO,
        (w - r + 2) * RATIO,
        (h - 4) * RATIO,
      ],
    },
  };
}

// Add every marker image the pin layers use, once per map.
export function ensurePinImages(map: Map, colors: PinColors): void {
  if (typeof map.hasImage !== "function" || map.hasImage(PIN_IMAGES.person))
    return;
  const add = (
    id: string,
    data: ImageData | null,
    options: object = { pixelRatio: RATIO },
  ) => {
    if (data && !map.hasImage(id)) map.addImage(id, data, options);
  };

  // Person: a filled disc with a check, the strongest mark on the map.
  let ctx = canvas(26, 26);
  if (ctx) {
    disc(ctx, 13, 9.5, colors.accent, colors.text, 2);
    stroke(ctx, colors.text, 2.4, [
      [
        [8.6, 13.3],
        [11.7, 16.3],
        [17.6, 10.1],
      ],
    ]);
    add(PIN_IMAGES.person, image(ctx));
  }

  // Unsure: an open amber ring with a question mark, so it reads as "still open".
  ctx = canvas(26, 26);
  if (ctx) {
    disc(ctx, 13, 9, colors.background, colors.warning, 2.25);
    ctx.fillStyle = colors.warning;
    ctx.font = "700 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", 13, 13.8);
    add(PIN_IMAGES.unsure, image(ctx));
  }

  // Not a person: a small grey cross, quiet so it never competes with real finds.
  ctx = canvas(16, 16);
  if (ctx) {
    stroke(ctx, colors.textSecondary, 1.8, [
      [
        [5, 5],
        [11, 11],
      ],
      [
        [11, 5],
        [5, 11],
      ],
    ]);
    add(PIN_IMAGES.notPerson, image(ctx));
  }

  // Not answered yet: a small solid dot marking the candidate's centre.
  ctx = canvas(14, 14);
  if (ctx) {
    disc(ctx, 7, 3.25, colors.accent, colors.accent, 0.5);
    add(PIN_IMAGES.unreviewed, image(ctx));
  }

  for (const [id, color] of [
    [PIN_IMAGES.chipPerson, colors.accent],
    [PIN_IMAGES.chipUnsure, colors.warning],
    [PIN_IMAGES.chipNeutral, colors.textSecondary],
  ] as const) {
    const pill = chip(color, colors.background);
    if (pill) add(id, pill.data, pill.options);
  }
}
