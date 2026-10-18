// The heat map as a raster: one RGBA pixel per grid cell, drawn into a canvas that MapLibre shows as
// a canvas source with nearest-neighbour resampling (so every cell stays a crisp square; nothing is
// blurred or interpolated between cells). Pure functions except HeatRaster, which owns the canvas.
//
// Colour: a sequential ramp built from the theme tokens and interpolated in OKLab, so equal steps in
// probability give roughly equal steps in perceived lightness (the idea behind matplotlib's
// viridis/inferno, Smith & van der Walt 2015, and Carbon's sequential palettes). On the dark basemap
// "more likely" is lighter and more opaque, and "less likely" recedes towards the background.
import type { MapFile } from "../../contract";
import type { MapState } from "../../search/update";
import { edgeLat, edgeLon, relativeHeatLevels } from "./geometry";

type Grid = MapFile["grid"];
export type RGB = [number, number, number];

/** Opacity of the "not yet searched" veil (cells not photographed at this step). */
export const VEIL_ALPHA = 0.62;
/** Heat opacity at the low and the high end of the ramp: low cells stay visible, high cells leave the basemap readable. */
export const HEAT_ALPHA_MIN = 0.5;
export const HEAT_ALPHA_MAX = 0.9;
/** Fill of a cell awaiting review: a neutral light tone (no update yet), outlined dashed on the map. */
export const HELD_ALPHA = 0.3;
/** Ramp resolution. */
export const RAMP_STEPS = 256;

/** Theme values used when a CSS token is missing (tests, or before the stylesheet loads). */
export const FALLBACK_TOKENS = {
  bg: "#0a0b0d",
  text: "#f2f2f0",
  accent: "#ff7a1a",
  accentSoft: "#ffb27a",
  warn: "#ffc48f",
  ok: "#7ee2a0",
} as const;

/** "#rrggbb" or "#rgb" to [r, g, b]; the fallback for anything else. */
export function parseHex(css: string, fallback: string): RGB {
  const s = (css || "").trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : fallback;
  const h = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// --- OKLab (Ottosson 2020) ---------------------------------------------------------------------
const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

export function rgbToOklab([r8, g8, b8]: RGB): [number, number, number] {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, A, B]: [number, number, number]): RGB {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Mix two colours in OKLab: t = 0 gives a, t = 1 gives b. */
export function mixOklab(a: RGB, b: RGB, t: number): RGB {
  const x = rgbToOklab(a);
  const y = rgbToOklab(b);
  return oklabToRgb([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Evenly spaced stops interpolated in OKLab into RAMP_STEPS colours (r, g, b per step). */
export function buildRamp(stops: readonly RGB[], steps = RAMP_STEPS): Uint8ClampedArray {
  const out = new Uint8ClampedArray(steps * 3);
  const labs = stops.map(rgbToOklab);
  for (let i = 0; i < steps; i++) {
    const pos = (i / (steps - 1)) * (labs.length - 1);
    const k = Math.min(labs.length - 2, Math.floor(pos));
    const t = pos - k;
    const a = labs[k] as [number, number, number];
    const b = labs[k + 1] as [number, number, number];
    const rgb = oklabToRgb([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    out.set(rgb, i * 3);
  }
  return out;
}

export interface RasterPalette {
  ramp: Uint8ClampedArray;
  veil: RGB;
  held: RGB;
}

export interface RasterTokens {
  bg: string;
  text: string;
  accent: string;
  accentSoft: string;
}

/**
 * The heat ramp from the theme: a dark ember (the accent mixed into the background), the accent,
 * the soft accent, then a pale warm tone. Lightness rises monotonically along it (OKLab L about
 * 0.42 → 0.71 → 0.83 → 0.92), the hue stays in the app's one accent family (05_FRONTEND_SHARED §5).
 */
export function paletteFromTokens(tokens: RasterTokens): RasterPalette {
  const bg = parseHex(tokens.bg, FALLBACK_TOKENS.bg);
  const text = parseHex(tokens.text, FALLBACK_TOKENS.text);
  const accent = parseHex(tokens.accent, FALLBACK_TOKENS.accent);
  const soft = parseHex(tokens.accentSoft, FALLBACK_TOKENS.accentSoft);
  const ember = mixOklab(bg, accent, 0.5);
  const pale = mixOklab(soft, text, 0.55);
  return { ramp: buildRamp([ember, accent, soft, pale]), veil: bg, held: text };
}

/** Read the tokens from the document (MapLibre and canvases cannot read CSS variables). */
export function readRasterTokens(root: Element = document.documentElement): RasterTokens {
  const styles = getComputedStyle(root);
  const v = (name: string) => styles.getPropertyValue(name).trim();
  return { bg: v("--bg"), text: v("--text"), accent: v("--accent"), accentSoft: v("--accent-soft") };
}

/** Ramp colour and alpha (0–255) for a heat level t in [0, 1]. */
export function heatColor(palette: RasterPalette, t: number): [number, number, number, number] {
  const k = Math.round(Math.min(1, Math.max(0, t)) * (RAMP_STEPS - 1)) * 3;
  const r = palette.ramp;
  const alpha = HEAT_ALPHA_MIN + (HEAT_ALPHA_MAX - HEAT_ALPHA_MIN) * t;
  return [r[k] as number, r[k + 1] as number, r[k + 2] as number, Math.round(alpha * 255)];
}

/**
 * RGBA per cell (row-major, row 0 = north: the canvas's own pixel order).
 * - not photographed at this step: the background colour at VEIL_ALPHA ("not yet searched");
 * - photographed and awaiting review: the neutral held tone at HELD_ALPHA;
 * - photographed: the ramp at the cell's level among the photographed cells (relativeHeatLevels).
 */
export function heatPixels(
  state: MapState,
  covered: Uint8Array,
  held: Uint8Array,
  palette: RasterPalette,
  out = new Uint8ClampedArray(state.p.length * 4),
): Uint8ClampedArray {
  const levels = relativeHeatLevels(state.p, covered, held);
  const veilA = Math.round(VEIL_ALPHA * 255);
  const heldA = Math.round(HELD_ALPHA * 255);
  for (let i = 0; i < state.p.length; i++) {
    const o = i * 4;
    if (covered[i] !== 1) {
      out[o] = palette.veil[0];
      out[o + 1] = palette.veil[1];
      out[o + 2] = palette.veil[2];
      out[o + 3] = veilA;
    } else if (held[i] === 1) {
      out[o] = palette.held[0];
      out[o + 1] = palette.held[1];
      out[o + 2] = palette.held[2];
      out[o + 3] = heldA;
    } else {
      const c = heatColor(palette, levels[i] as number);
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3];
    }
  }
  return out;
}

/** The grid's corners for a MapLibre image/canvas source: NW, NE, SE, SW as [lon, lat]. */
export function gridCorners(grid: Grid): [[number, number], [number, number], [number, number], [number, number]] {
  const n = edgeLat(grid, 0);
  const s = edgeLat(grid, grid.rows);
  const w = edgeLon(grid, 0);
  const e = edgeLon(grid, grid.cols);
  return [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ];
}

/** Ease out (cubic): fast start, gentle landing. */
export const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/**
 * One animation frame: each cell moves from `from` to `to`. With `delays` (0–1 per cell) a cell
 * starts at delay × (1 − fade) of the timeline and takes `fade` of it; without, all cells move
 * together over the whole timeline. tau is the timeline position in [0, 1]. Writes into `out`.
 */
export function blendPixels(
  from: Uint8ClampedArray,
  to: Uint8ClampedArray,
  tau: number,
  out: Uint8ClampedArray,
  delays?: Float32Array | null,
  fade = 1,
): Uint8ClampedArray {
  const n = to.length / 4;
  const span = Math.max(1e-6, fade);
  for (let i = 0; i < n; i++) {
    const start = delays ? (delays[i] as number) * (1 - span) : 0;
    const k = delays ? easeOut((tau - start) / span) : easeOut(tau);
    const o = i * 4;
    for (let c = 0; c < 4; c++) {
      const a = from[o + c] as number;
      out[o + c] = a + ((to[o + c] as number) - a) * k;
    }
  }
  return out;
}

/** Reveal delays for the build-up: a cell photographed after frame k of n starts at (k − 1) / n. */
export function sweepDelays(firstStep: Int32Array, stepCount: number): Float32Array {
  const d = new Float32Array(firstStep.length);
  if (stepCount <= 0) return d;
  for (let i = 0; i < firstStep.length; i++) {
    const k = firstStep[i] as number;
    d[i] = k > 0 ? Math.min(1, (k - 1) / stepCount) : 0;
  }
  return d;
}

/** Each raster by its canvas, so tests (and debugging) can read the pixels the map is showing. */
const rasters = new WeakMap<HTMLCanvasElement, HeatRaster>();
export function rasterForCanvas(canvas: HTMLCanvasElement): HeatRaster | undefined {
  return rasters.get(canvas);
}

export interface AnimateOptions {
  durationMs: number;
  delays?: Float32Array | null;
  fade?: number;
}

/**
 * Owns the displayed pixels and the canvas. `show` jumps; `animate` tweens from what is on screen
 * now (so a new answer mid-tween continues smoothly). `onDraw(playing)` is called after every
 * canvas write so the caller can tell MapLibre to upload the texture.
 */
export class HeatRaster {
  readonly cols: number;
  readonly rows: number;
  readonly canvas: HTMLCanvasElement;
  shown: Uint8ClampedArray;
  private target: Uint8ClampedArray;
  private from: Uint8ClampedArray;
  private frame = 0;
  private startedAt = 0;
  private options: AnimateOptions = { durationMs: 0 };
  private onDraw: (playing: boolean) => void = () => {};
  private readonly now: () => number;
  private readonly raf: (fn: (t: number) => void) => number;
  private readonly caf: (id: number) => void;

  constructor(
    grid: Pick<Grid, "rows" | "cols">,
    doc: Document = document,
    clock: { now?: () => number; raf?: (fn: (t: number) => void) => number; caf?: (id: number) => void } = {},
  ) {
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.canvas = doc.createElement("canvas");
    this.canvas.width = grid.cols;
    this.canvas.height = grid.rows;
    const n = grid.rows * grid.cols * 4;
    this.shown = new Uint8ClampedArray(n);
    this.target = new Uint8ClampedArray(n);
    this.from = new Uint8ClampedArray(n);
    this.now = clock.now ?? (() => performance.now());
    this.raf = clock.raf ?? ((fn) => requestAnimationFrame(fn));
    this.caf = clock.caf ?? ((id) => cancelAnimationFrame(id));
    rasters.set(this.canvas, this);
  }

  setOnDraw(fn: (playing: boolean) => void): void {
    this.onDraw = fn;
  }

  get animating(): boolean {
    return this.frame !== 0;
  }

  /** Show these pixels now (stops any animation). */
  show(pixels: Uint8ClampedArray): void {
    this.stop();
    this.target.set(pixels);
    this.shown.set(pixels);
    this.draw(false);
  }

  /** Tween from the pixels on screen to `pixels`. */
  animate(pixels: Uint8ClampedArray, options: AnimateOptions, from?: Uint8ClampedArray): void {
    this.stop();
    this.from.set(from ?? this.shown);
    this.target.set(pixels);
    this.options = options;
    if (options.durationMs <= 0) {
      this.shown.set(pixels);
      this.draw(false);
      return;
    }
    this.startedAt = this.now();
    this.shown.set(this.from);
    this.draw(true);
    const tick = () => {
      const tau = Math.min(1, (this.now() - this.startedAt) / this.options.durationMs);
      blendPixels(this.from, this.target, tau, this.shown, this.options.delays, this.options.fade ?? 1);
      if (tau >= 1) {
        this.frame = 0;
        this.shown.set(this.target);
        this.draw(false);
        return;
      }
      this.draw(true);
      this.frame = this.raf(tick);
    };
    this.frame = this.raf(tick);
  }

  /** Jump to the end of the running animation. */
  finish(): void {
    if (!this.frame) return;
    this.stop();
    this.shown.set(this.target);
    this.draw(false);
  }

  stop(): void {
    if (this.frame) this.caf(this.frame);
    this.frame = 0;
  }

  private ctx: CanvasRenderingContext2D | null | undefined;

  /** Write `shown` into the canvas. Without a 2D context (jsdom) only the pixel buffer is kept. */
  private draw(playing: boolean): void {
    if (this.ctx === undefined) {
      const isJsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
      try {
        this.ctx = isJsdom ? null : this.canvas.getContext("2d");
      } catch {
        this.ctx = null;
      }
    }
    const ctx = this.ctx;
    if (ctx) {
      const image = ctx.createImageData(this.cols, this.rows);
      image.data.set(this.shown);
      ctx.putImageData(image, 0, 0);
    }
    this.onDraw(playing);
  }
}
