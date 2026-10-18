import { act, renderHook } from "@testing-library/react";
import type { Map } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPLAY_MS } from "./droneMotion";
import { HEAT_DRONE_FOOTPRINT_SOURCE_ID, HEAT_DRONE_SOURCE_ID, HEAT_LAYER_IDS } from "./layers";
import { COMMIT_MS, moveSliderThumb, useFlightReplay } from "./useFlightReplay";

type LonLat = [number, number];

// Ten photos 0.0002° apart along one leg east.
const path: LonLat[] = Array.from({ length: 10 }, (_, i) => [i * 0.0002, 49] as LonLat);
const footprints = path.map(([lon, lat]) => [
  [lon + 0.00005, lat + 0.00005],
  [lon + 0.00005, lat - 0.00005],
  [lon - 0.00005, lat - 0.00005],
  [lon - 0.00005, lat + 0.00005],
] as const);

function mockMap() {
  const drawn: Record<string, unknown> = {};
  const paint: { id: string; prop: string; value: unknown }[] = [];
  const map = {
    getSource: (id: string) => ({ setData: (d: unknown) => (drawn[id] = d) }),
    getLayer: () => ({}),
    setPaintProperty: (id: string, prop: string, value: unknown) => paint.push({ id, prop, value }),
  };
  return { map: map as unknown as Map, drawn, paint };
}

describe("useFlightReplay", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  });
  afterEach(() => vi.useRealTimers());

  function setup(reduced: boolean, start = 10) {
    const m = mockMap();
    const commits: number[] = [];
    let step = start;
    const hook = renderHook(
      ({ stepIndex }) =>
        useFlightReplay({
          map: m.map,
          enabled: true,
          path,
          footprints,
          stepIndex,
          stepCount: path.length,
          setStepIndex: (v) => {
            commits.push(v);
            step = v;
          },
          reduced,
        }),
      { initialProps: { stepIndex: start } },
    );
    const sync = () => hook.rerender({ stepIndex: step });
    return { ...m, hook, commits, sync };
  }

  it("reduced motion: Play jumps straight to the end of the flight, no clock", () => {
    const t = setup(true, 3);
    act(() => t.hook.result.current.toggle());
    expect(t.commits).toEqual([10]);
    expect(t.hook.result.current.playing).toBe(false);
  });

  it("plays from the first photo at a steady speed, committing a few times a second, and stops at the end", () => {
    const t = setup(false, 10);
    act(() => t.hook.result.current.toggle());
    expect(t.hook.result.current.playing).toBe(true);
    // At the end already: the replay restarts at the first photo.
    expect(t.commits[0]).toBe(1);
    const xs: number[] = [];
    for (let i = 0; i < 30; i++) {
      act(() => vi.advanceTimersByTime(16));
      xs.push(((t.drawn[HEAT_DRONE_SOURCE_ID] as { geometry: { coordinates: LonLat } }).geometry.coordinates)[0]);
    }
    // The drone moves every frame by about the same amount (steady speed, no easing per photo).
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    expect(mean).toBeGreaterThan(0);
    for (const d of steps.slice(2)) expect(Math.abs(d - mean)).toBeLessThan(mean * 0.35);
    // Commits are whole steps, at most one per COMMIT_MS (30 frames of 16 ms ≈ 480 ms).
    expect(t.commits.every((c) => Number.isInteger(c))).toBe(true);
    expect(t.commits.length).toBeLessThanOrEqual(1 + Math.ceil((30 * 16) / COMMIT_MS));
    // The photo highlight is a footprint between two photos.
    expect(t.drawn[HEAT_DRONE_FOOTPRINT_SOURCE_ID]).toMatchObject({ geometry: { type: "Polygon" } });
    act(() => vi.advanceTimersByTime(REPLAY_MS + 500));
    expect(t.commits.at(-1)).toBe(10);
    expect(t.hook.result.current.playing).toBe(false);
  });

  it("pause settles on the photo ahead; skip goes to the end; scrub goes where it was sent", () => {
    const t = setup(false, 2);
    act(() => t.hook.result.current.toggle());
    t.sync();
    act(() => vi.advanceTimersByTime(REPLAY_MS / 4));
    act(() => t.hook.result.current.toggle());
    const paused = t.commits.at(-1)!;
    expect(paused).toBeGreaterThan(2);
    expect(paused).toBeLessThan(10);
    act(() => t.hook.result.current.toggle());
    act(() => vi.advanceTimersByTime(100));
    act(() => t.hook.result.current.skip());
    expect(t.commits.at(-1)).toBe(10);
    expect(t.hook.result.current.playing).toBe(false);
    act(() => t.hook.result.current.scrub(4));
    expect(t.commits.at(-1)).toBe(4);
  });

  it("fades the photo highlight and brightens the trail with paint transitions, not per frame", () => {
    const t = setup(false, 10);
    const last = (id: string, prop: string) => t.paint.filter((p) => p.id === id && p.prop === prop).at(-1)?.value;
    // At the end of the flight: no highlight, dim trail.
    expect(last(HEAT_LAYER_IDS.droneFootprint, "fill-opacity")).toBe(0);
    const restTrail = last(HEAT_LAYER_IDS.trail, "line-opacity") as number;
    act(() => t.hook.result.current.toggle());
    expect(last(HEAT_LAYER_IDS.droneFootprint, "fill-opacity")).toBeGreaterThan(0);
    expect(last(HEAT_LAYER_IDS.trail, "line-opacity") as number).toBeGreaterThan(restTrail);
    expect(last(HEAT_LAYER_IDS.trail, "line-opacity-transition")).toMatchObject({ duration: expect.any(Number) });
    const before = t.paint.length;
    act(() => vi.advanceTimersByTime(200));
    expect(t.paint.length).toBe(before);
  });

  it("moves the slider thumb directly", () => {
    const el = document.createElement("input");
    el.type = "range";
    el.max = "10";
    el.step = "any";
    moveSliderThumb(el, 2.5, 10);
    expect(el.value).toBe("2.5");
    expect(el.style.getPropertyValue("--sl-range-fill")).toBe("25%");
  });
});
