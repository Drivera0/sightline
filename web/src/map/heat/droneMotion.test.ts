import { describe, expect, it } from "vitest";
import {
  buildTrack,
  distanceAtStep,
  footprintAtStep,
  headingAtDistance,
  segmentM,
  stepAtDistance,
  turnTowards,
} from "./droneMotion";

type LonLat = [number, number];

// A lawnmower leg east, a short hop south, and a leg back west (about 72 m, 16 m and 72 m at 49° N).
const path: LonLat[] = [
  [0, 49],
  [0.001, 49],
  [0.002, 49],
  [0.002, 48.99985],
  [0.001, 48.99985],
];

describe("the replay track", () => {
  const track = buildTrack(path);

  it("measures the path in metres", () => {
    expect(track.cum[0]).toBe(0);
    expect(track.cum[1]).toBeCloseTo(segmentM(path[0]!, path[1]!), 9);
    expect(track.total).toBeCloseTo(track.cum[4]!, 9);
    expect(segmentM([0, 49], [0, 49.001])).toBeCloseTo(110.54, 2);
  });

  it("maps distance to fractional steps and back (steady ground speed)", () => {
    expect(stepAtDistance(track, 0)).toBe(1);
    expect(stepAtDistance(track, track.total)).toBe(5);
    expect(stepAtDistance(track, track.cum[1]! / 2)).toBeCloseTo(1.5, 9);
    // The short hop south takes less time than a full leg at the same speed.
    const hop = track.cum[3]! - track.cum[2]!;
    expect(hop).toBeLessThan(track.cum[1]!);
    for (const s of [1, 1.25, 2, 3.5, 4.9, 5]) expect(stepAtDistance(track, distanceAtStep(track, s))).toBeCloseTo(s, 9);
    // Out of range clamps to the ends.
    expect(stepAtDistance(track, -10)).toBe(1);
    expect(stepAtDistance(track, track.total + 10)).toBe(5);
  });

  it("handles empty and single-photo paths", () => {
    expect(stepAtDistance(buildTrack([]), 3)).toBe(0);
    expect(stepAtDistance(buildTrack([[0, 0]]), 3)).toBe(1);
    expect(distanceAtStep(buildTrack([[0, 0]]), 1)).toBe(0);
  });

  it("rounds the turns: the heading passes through south between the east and west legs", () => {
    const east = headingAtDistance(track, track.cum[1]!);
    expect(east).toBeCloseTo(90, 6);
    // At the middle of the hop the chord runs from the end of the east leg to the start of the west one.
    const mid = headingAtDistance(track, (track.cum[2]! + track.cum[3]!) / 2);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(260);
    expect(headingAtDistance(track, track.total)).toBeCloseTo(270, 6);
  });

  it("eases the heading the short way round, more over a longer frame", () => {
    const a = turnTowards(350, 10, 16);
    const b = turnTowards(350, 10, 64);
    expect(a === 350 || a > 350 || a < 10).toBe(true);
    const gap = (x: number) => Math.abs(((((10 - x) % 360) + 540) % 360) - 180);
    expect(gap(b)).toBeLessThan(gap(a));
  });
});

describe("footprintAtStep", () => {
  const box = (lon: number, rotate: number): LonLat[] => {
    const corners: LonLat[] = [
      [lon + 0.0001, 49.0001],
      [lon + 0.0001, 48.9999],
      [lon - 0.0001, 48.9999],
      [lon - 0.0001, 49.0001],
    ];
    return [...corners.slice(rotate), ...corners.slice(0, rotate)];
  };

  it("is the photo's own footprint on a whole step, and nothing before the first", () => {
    const fps = [box(0, 0), box(0.001, 0)];
    expect(footprintAtStep(fps, 0)).toBeNull();
    expect(footprintAtStep(fps, 1)).toEqual(box(0, 0));
    expect(footprintAtStep(fps, 2)).toEqual(box(0.001, 0));
  });

  it("glides between photos, matching corners when the next photo lists them rotated", () => {
    // Flown the other way, the next footprint starts at the opposite corner.
    const fps = [box(0, 0), box(0.001, 2)];
    const mid = footprintAtStep(fps, 1.5)!;
    const lons = mid.map((c) => c[0]).sort((x, y) => x - y);
    // Still a box of the same size, half way along (no corner crossing the middle).
    expect(lons[0]).toBeCloseTo(0.0004, 9);
    expect(lons[3]).toBeCloseTo(0.0006, 9);
  });
});
