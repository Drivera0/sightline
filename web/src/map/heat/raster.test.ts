import { describe, expect, it } from "vitest";
import { CELL } from "./classes";
import { buildOverlapIndex, firstPhotographedStep } from "./coverage";
import { pointAtStep, lerpAngle, stepDrone, trailAtStep } from "./droneMotion";
import { droneShapes } from "./droneImage";
import { HEAT_PALETTES, HELD_ALPHA, VEIL_ALPHA } from "./palette";
import { blendPixels, FALLBACK_THEME, gridCorners, HeatRaster, kindColors, kindPixels, parseHex, surfaceTheme, sweepDelays } from "./raster";

describe("cell colours", () => {
  it("parses hex tokens and falls back for anything else", () => {
    expect(parseHex("#ff7a1a", "#000")).toEqual([255, 122, 26]);
    expect(parseHex("#abc", "#000")).toEqual([170, 187, 204]);
    expect(parseHex("oklch(70% 0.1 50)", "#0a0b0d")).toEqual([10, 11, 13]);
  });

  it("gives each kind the colour and alpha its fill layer has (the raster and the fills match)", () => {
    for (const palette of Object.values(HEAT_PALETTES)) {
      const colors = kindColors(palette, FALLBACK_THEME);
      const at = (kind: number) => Array.from(colors.slice(kind * 4, kind * 4 + 4));
      expect(at(CELL.top)).toEqual([...parseHex(palette.top.color, "#000"), Math.round(palette.top.alpha * 255)]);
      expect(at(CELL.mid)).toEqual([...parseHex(palette.mid.color, "#000"), Math.round(palette.mid.alpha * 255)]);
      expect(at(CELL.low)).toEqual([...parseHex(palette.low.color, "#000"), Math.round(palette.low.alpha * 255)]);
      expect(at(CELL.veil)).toEqual([...parseHex(FALLBACK_THEME.veil, "#000"), Math.round(VEIL_ALPHA * 255)]);
      expect(at(CELL.held)).toEqual([...parseHex(FALLBACK_THEME.held, "#000"), Math.round(HELD_ALPHA * 255)]);
      // Outside the 90 % region: fully transparent, the basemap shows.
      expect(at(CELL.none)).toEqual([0, 0, 0, 0]);
    }
  });

  it("falls back to the default theme for a token that is missing or not hex", () => {
    expect(surfaceTheme({ veil: "", held: "rgb(1 2 3)" })).toEqual(FALLBACK_THEME);
    expect(surfaceTheme({ veil: " #111111 ", held: "#eee" })).toEqual({ veil: "#111111", held: "#eee" });
  });

  it("writes one RGBA pixel per cell from its kind", () => {
    const colors = kindColors(HEAT_PALETTES.satellite, FALLBACK_THEME);
    const px = kindPixels(Uint8Array.from([CELL.top, CELL.none, CELL.veil]), colors);
    expect(px).toHaveLength(12);
    expect(Array.from(px.slice(0, 4))).toEqual(Array.from(colors.slice(CELL.top * 4, CELL.top * 4 + 4)));
    expect(px[7]).toBe(0);
    expect(px[11]).toBe(Math.round(VEIL_ALPHA * 255));
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
