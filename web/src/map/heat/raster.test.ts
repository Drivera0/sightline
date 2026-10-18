import { describe, expect, it } from "vitest";
import { buildOverlapIndex, firstPhotographedStep } from "./coverage";
import { pointAtStep, lerpAngle, stepDrone, trailAtStep } from "./droneMotion";
import { droneShapes } from "./droneImage";
import {
  blendPixels,
  buildEvenRamp,
  classLevel,
  buildRamp,
  FALLBACK_TOKENS,
  gridCorners,
  HEAT_ALPHA_MAX,
  HEAT_ALPHA_MIN,
  HEAT_CLASSES,
  heatColor,
  HeatRaster,
  heatPixels,
  HELD_ALPHA,
  oklabToRgb,
  paletteFromTokens,
  parseHex,
  RAMP_STEPS,
  rgbToOklab,
  sweepDelays,
  VEIL_ALPHA,
  YLORRD_STOPS,
} from "./raster";

const palette = paletteFromTokens({
  bg: FALLBACK_TOKENS.bg,
  text: FALLBACK_TOKENS.text,
  accent: FALLBACK_TOKENS.accent,
  accentSoft: FALLBACK_TOKENS.accentSoft,
});

describe("colour ramp", () => {
  it("parses hex tokens and falls back for anything else", () => {
    expect(parseHex("#ff7a1a", "#000")).toEqual([255, 122, 26]);
    expect(parseHex("#fff", "#000")).toEqual([255, 255, 255]);
    expect(parseHex("", "#0a0b0d")).toEqual([10, 11, 13]);
  });

  it("round-trips through OKLab", () => {
    for (const c of [[255, 122, 26], [10, 11, 13], [242, 242, 240]] as [number, number, number][]) {
      const back = oklabToRgb(rgbToOklab(c));
      back.forEach((v, i) => expect(Math.abs(v - c[i]!)).toBeLessThanOrEqual(1));
    }
  });

  it("falls monotonically in perceived lightness from low to high: lighter is less likely, darker more likely", () => {
    const ramp = palette.ramp;
    let last = 2;
    for (let i = 0; i < ramp.length / 3; i += 8) {
      const L = rgbToOklab([ramp[i * 3]!, ramp[i * 3 + 1]!, ramp[i * 3 + 2]!])[0];
      expect(L).toBeLessThan(last + 1e-3);
      last = L;
    }
    const lab = (i: number) => rgbToOklab([ramp[i * 3]!, ramp[i * 3 + 1]!, ramp[i * 3 + 2]!]);
    const first = lab(0)[0];
    const end = lab(RAMP_STEPS - 1)[0];
    expect(first - end).toBeGreaterThan(0.45);
    // The dark end stays a saturated red, well above the background's lightness (not a near-black).
    const [, a, b] = lab(RAMP_STEPS - 1);
    expect(Math.hypot(a, b)).toBeGreaterThan(0.1);
    expect(end).toBeGreaterThan(rgbToOklab(parseHex(FALLBACK_TOKENS.bg, "#000"))[0] + 0.15);
  });

  it("starts at pale yellow and ends at deep red (ColorBrewer YlOrRd), with the accent in the middle", () => {
    const r = palette.ramp;
    expect([r[0], r[1], r[2]]).toEqual(parseHex(YLORRD_STOPS[0], "#000"));
    expect([r.at(-3), r.at(-2), r.at(-1)]).toEqual(parseHex(YLORRD_STOPS.at(-1)!, "#000"));
    const accent = rgbToOklab(parseHex(FALLBACK_TOKENS.accent, "#000"));
    const nearest = Math.min(
      ...Array.from({ length: RAMP_STEPS }, (_, i) => {
        const c = rgbToOklab([r[i * 3]!, r[i * 3 + 1]!, r[i * 3 + 2]!]);
        return Math.hypot(c[0] - accent[0], c[1] - accent[1], c[2] - accent[2]);
      }),
    );
    expect(nearest).toBeLessThan(0.01);
  });

  it("spaces the stops by perceived distance: no big jump between neighbouring ramp steps", () => {
    const r = buildEvenRamp([
      [255, 237, 160],
      [254, 217, 118],
      [128, 0, 38],
    ]);
    const steps: number[] = [];
    for (let i = 1; i < RAMP_STEPS; i++) {
      const a = rgbToOklab([r[(i - 1) * 3]!, r[(i - 1) * 3 + 1]!, r[(i - 1) * 3 + 2]!]);
      const b = rgbToOklab([r[i * 3]!, r[i * 3 + 1]!, r[i * 3 + 2]!]);
      steps.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const mean = steps.reduce((x, y) => x + y, 0) / steps.length;
    // 8-bit rounding leaves some jitter; an evenly spaced ramp would put ~1/2 of the steps in the short first segment.
    expect(Math.max(...steps)).toBeLessThan(mean * 2.5);
  });

  it("rises in opacity from the low end to the high end", () => {
    expect(heatColor(palette, 0)[3]).toBe(Math.round(HEAT_ALPHA_MIN * 255));
    expect(heatColor(palette, 1)[3]).toBe(Math.round(HEAT_ALPHA_MAX * 255));
    expect(HEAT_ALPHA_MAX).toBeGreaterThan(HEAT_ALPHA_MIN);
  });

  it("hits the stops at the ends", () => {
    const r = buildRamp([
      [0, 0, 0],
      [255, 255, 255],
    ]);
    expect([r[0], r[1], r[2]]).toEqual([0, 0, 0]);
    expect([r.at(-3), r.at(-2), r.at(-1)]).toEqual([255, 255, 255]);
  });
});

describe("classLevel", () => {
  it("rounds a level down to one of n classes, shown at k / (n - 1), keeping both ends", () => {
    expect(classLevel(0, 7)).toBe(0);
    expect(classLevel(1, 7)).toBe(1);
    expect(classLevel(0.5, 7)).toBeCloseTo(3 / 6, 12);
    expect(classLevel(0.14, 7)).toBe(0);
    expect(classLevel(0.15, 7)).toBeCloseTo(1 / 6, 12);
    expect(classLevel(0.99, 7)).toBe(1);
    expect(new Set(Array.from({ length: 101 }, (_, i) => classLevel(i / 100, 7))).size).toBe(7);
    // One class means the continuous ramp.
    expect(classLevel(0.37, 1)).toBe(0.37);
    expect(HEAT_CLASSES).toBeGreaterThanOrEqual(3);
    expect(HEAT_CLASSES).toBeLessThanOrEqual(9);
  });
});

describe("heatPixels", () => {
  const state = { p: Float64Array.from([0.1, 0.2, 0.3, 0.4]), outside: 0 };

  it("veils unphotographed cells, marks held cells, and ramps the rest by their level", () => {
    const covered = Uint8Array.from([0, 1, 1, 1]);
    const held = Uint8Array.from([0, 1, 0, 0]);
    // Fixed scale: 0.4 is the top. Cell 2 (0.3) is class 5 of 7, cell 3 (0.4) the darkest class.
    const px = heatPixels(state, covered, held, palette, 0.4);
    expect(px[3]).toBe(Math.round(VEIL_ALPHA * 255));
    expect([px[0], px[1], px[2]]).toEqual(palette.veil);
    expect(px[7]).toBe(Math.round(HELD_ALPHA * 255));
    expect(px[15]).toBe(Math.round(HEAT_ALPHA_MAX * 255));
    expect(px[11]).toBe(Math.round((HEAT_ALPHA_MIN + (HEAT_ALPHA_MAX - HEAT_ALPHA_MIN) * (5 / 6)) * 255));
  });

  it("keeps a cell's colour when other cells get photographed (the scale does not stretch)", () => {
    const held = new Uint8Array(4);
    const few = heatPixels(state, Uint8Array.from([0, 0, 1, 1]), held, palette, 0.4);
    const all = heatPixels(state, Uint8Array.from([1, 1, 1, 1]), held, palette, 0.4);
    expect(Array.from(few.slice(8, 16))).toEqual(Array.from(all.slice(8, 16)));
    // A low cell on the fixed scale stays pale even when it is the only one photographed.
    const alone = heatPixels(state, Uint8Array.from([1, 0, 0, 0]), held, palette, 0.4);
    // 0.1 / 0.4 = 0.25: class 1 of 7, not stretched to the darkest class.
    expect(alone[3]).toBe(Math.round((HEAT_ALPHA_MIN + (HEAT_ALPHA_MAX - HEAT_ALPHA_MIN) / 6) * 255));
  });

  it("puts the canvas on the grid's corners (NW, NE, SE, SW)", () => {
    const g = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 5, rows: 200, cols: 200 };
    const [nw, ne, se, sw] = gridCorners(g);
    expect(nw).toEqual([-122.95, 49.37]);
    expect(ne[1]).toBe(49.37);
    expect(sw[0]).toBe(-122.95);
    expect(49.37 - se[1]).toBeCloseTo(1000 / 111_320, 12);
  });
});

describe("animation", () => {
  it("blends all cells together, or each in turn with delays", () => {
    const from = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]);
    const to = new Uint8ClampedArray([200, 200, 200, 200, 200, 200, 200, 200]);
    const out = new Uint8ClampedArray(8);
    blendPixels(from, to, 0, out);
    expect(out[0]).toBe(0);
    blendPixels(from, to, 1, out);
    expect(out[7]).toBe(200);
    // Cell 0 starts at once, cell 1 at the end of the timeline.
    blendPixels(from, to, 0.5, out, Float32Array.from([0, 1]), 0.2);
    expect(out[0]).toBe(200);
    expect(out[4]).toBe(0);
  });

  it("orders the build-up by the frame that first photographed each cell", () => {
    const index = buildOverlapIndex(
      [
        [[0, 0.6]],
        [
          [1, 0.3],
          [0, 0.2],
        ],
        [[1, 0.3]],
      ],
      3,
    );
    const first = firstPhotographedStep(index);
    expect(Array.from(first)).toEqual([1, 3, 0]);
    expect(Array.from(sweepDelays(first, 3))).toEqual([0, 2 / 3, 0].map((v) => Math.fround(v)));
  });

  it("tweens on the clock and lands exactly on the target; finish() jumps to it", () => {
    let now = 0;
    const frames: ((t: number) => void)[] = [];
    const raster = new HeatRaster(
      { rows: 1, cols: 1 },
      document,
      { now: () => now, raf: (fn) => frames.push(fn), caf: () => {} },
    );
    const draws: boolean[] = [];
    raster.setOnDraw((playing) => draws.push(playing));
    raster.show(new Uint8ClampedArray([0, 0, 0, 0]));
    raster.animate(new Uint8ClampedArray([100, 100, 100, 100]), { durationMs: 100 });
    expect(raster.animating).toBe(true);
    now = 50;
    frames.shift()!(now);
    expect(raster.shown[0]).toBeGreaterThan(0);
    expect(raster.shown[0]).toBeLessThan(100);
    now = 100;
    frames.shift()!(now);
    expect(raster.shown[0]).toBe(100);
    expect(raster.animating).toBe(false);
    expect(draws.at(-1)).toBe(false);
    raster.animate(new Uint8ClampedArray([7, 7, 7, 7]), { durationMs: 100 });
    raster.finish();
    expect(raster.shown[3]).toBe(7);
  });
});

describe("drone motion", () => {
  const path: [number, number][] = [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
    [0.002, -0.001],
    [0.001, -0.001],
  ];

  it("interpolates between frames and heads along the leg", () => {
    const p = pointAtStep(path, 1.5)!;
    expect(p.at[0]).toBeCloseTo(0.0005, 9);
    expect(p.bearing).toBeCloseTo(90, 6);
    expect(pointAtStep(path, 0)).toBeNull();
    expect(pointAtStep(path, 4.5)!.bearing).toBeCloseTo(270, 6);
  });

  it("turns the short way round", () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpAngle(90, 270, 1)).toBeCloseTo(270, 9);
  });

  it("glides towards the target, snaps with reduced motion or a big scrub", () => {
    const glide = stepDrone({ s: 2, bearing: 90 }, path, 3, 16, false);
    expect(glide.s).toBeGreaterThan(2);
    expect(glide.s).toBeLessThan(3);
    expect(stepDrone({ s: 2, bearing: 90 }, path, 3, 16, true).s).toBe(3);
    // Many frames of 16 ms settle on the target.
    let s = { s: 2, bearing: 90 };
    for (let i = 0; i < 120; i++) s = stepDrone(s, path, 4, 16, false);
    expect(s.s).toBe(4);
  });

  it("draws the trail up to the drone", () => {
    expect(trailAtStep(path, 2)).toEqual([path[0], path[1]]);
    expect(trailAtStep(path, 2.5)).toHaveLength(3);
  });

  it("reads the body and the arms and guards from drone.svg", () => {
    const { body, paths } = droneShapes();
    expect(body).toMatchObject({ w: 15.6, h: 32 });
    expect(paths).toHaveLength(5);
  });
});
