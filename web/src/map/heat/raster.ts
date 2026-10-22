// The heat as a raster: one RGBA pixel per grid cell, drawn into a canvas that MapLibre shows as a
// canvas source with nearest-neighbour resampling (so every cell stays a crisp square; nothing is
// blurred or interpolated between cells). Used while the heat animates; at rest the same cell kinds
// are drawn as GeoJSON fills (surface.ts). Pure functions except HeatRaster, which owns the canvas.
import type { MapFile } from "../../contract";
import { edgeLat, edgeLon } from "./geometry";
import { type HeatPalette, kindFill } from "./palette";

type Grid = MapFile["grid"];
export type RGB = [number, number, number];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#rrggbb" or "#rgb" to [r, g, b]; the fallback for anything else. */
export function parseHex(css: string, fallback: string): RGB {
  const s = (css || "").trim();
  const hex = HEX.test(s) ? s : fallback;
  const h = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Theme values used when a CSS token is missing (tests, or before the stylesheet loads). */
export const FALLBACK_THEME = { veil: "#0a0b0d", held: "#f2f2f0" } as const;

/** The two theme colours of the surface, each a hex colour (the fallback when a token is missing or not hex). */
export function surfaceTheme(theme: { veil: string; held: string }): { veil: string; held: string } {
  const pick = (css: string, fallback: string) => (HEX.test((css || "").trim()) ? css.trim() : fallback);
  return { veil: pick(theme.veil, FALLBACK_THEME.veil), held: pick(theme.held, FALLBACK_THEME.held) };
}

/** Kinds a cell can have (classes.ts CELL): room for all of them in the colour table. */
const KIND_SLOTS = 8;

/** RGBA (0–255) of each cell kind, indexed by kind: the fill colours and alphas of surface.ts. */
export function kindColors(palette: HeatPalette, theme: { veil: string; held: string }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(KIND_SLOTS * 4);
  const safe = surfaceTheme(theme);
  for (let kind = 0; kind < KIND_SLOTS; kind++) {
    const fill = kindFill(palette, kind, safe);
    if (fill) out.set([...parseHex(fill.color, "#000000"), Math.round(fill.alpha * 255)], kind * 4);
  }
  return out;
}

/** RGBA per cell (row-major, row 0 = north: the canvas's own pixel order) from the cell kinds. */
export function kindPixels(kinds: Uint8Array, colors: Uint8ClampedArray, out = new Uint8ClampedArray(kinds.length * 4)): Uint8ClampedArray {
  for (let i = 0; i < kinds.length; i++) {
    const k = (kinds[i] as number) * 4;
    const o = i * 4;
    out[o] = colors[k] as number;
    out[o + 1] = colors[k + 1] as number;
    out[o + 2] = colors[k + 2] as number;
    out[o + 3] = colors[k + 3] as number;
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
