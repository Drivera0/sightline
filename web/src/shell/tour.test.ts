import { beforeAll, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { STEPS } from "./flow";
import { TOUR_IDLE, clockRuns, isTouring, tourLengthMs, tourReducer, tourStops, type TourEvent, type TourState } from "./tour";

const N = 5;
const run = (events: TourEvent[], from: TourState = TOUR_IDLE) => events.reduce((s, e) => tourReducer(s, e, N), from);

describe("tourReducer", () => {
  it("starts playing at the first stop, or captions-only when motion is reduced", () => {
    expect(run([{ type: "start", reducedMotion: false }])).toEqual({ status: "playing", index: 0 });
    expect(run([{ type: "start", reducedMotion: true }])).toEqual({ status: "manual", index: 0 });
  });

  it("advances on its own only while playing", () => {
    expect(run([{ type: "start", reducedMotion: false }, { type: "elapsed" }])).toEqual({ status: "playing", index: 1 });
    expect(run([{ type: "start", reducedMotion: true }, { type: "elapsed" }])).toEqual({ status: "manual", index: 0 });
    expect(run([{ type: "start", reducedMotion: false }, { type: "pause" }, { type: "elapsed" }])).toEqual({
      status: "paused",
      index: 0,
    });
  });

  it("pauses and resumes; manual mode ignores both", () => {
    const paused = run([{ type: "start", reducedMotion: false }, { type: "pause" }]);
    expect(paused.status).toBe("paused");
    expect(clockRuns(paused)).toBe(false);
    expect(run([{ type: "resume" }], paused)).toEqual({ status: "playing", index: 0 });
    expect(run([{ type: "start", reducedMotion: true }, { type: "pause" }, { type: "resume" }]).status).toBe("manual");
  });

  it("steps by hand with Next and Back, keeping the mode, and clamps at the first stop", () => {
    const manual = run([{ type: "start", reducedMotion: true }, { type: "next" }, { type: "next" }]);
    expect(manual).toEqual({ status: "manual", index: 2 });
    expect(run([{ type: "back" }, { type: "back" }, { type: "back" }], manual)).toEqual({ status: "manual", index: 0 });
    const paused = run([{ type: "start", reducedMotion: false }, { type: "pause" }, { type: "next" }]);
    expect(paused).toEqual({ status: "paused", index: 1 });
  });

  it("holds the last caption when its time runs out, and Next there finishes the tour", () => {
    const atLast = run([{ type: "start", reducedMotion: false }, ...Array<TourEvent>(N - 1).fill({ type: "elapsed" })]);
    expect(atLast).toEqual({ status: "playing", index: N - 1 });
    const done = run([{ type: "elapsed" }], atLast);
    expect(done).toEqual({ status: "done", index: N - 1 });
    expect(run([{ type: "elapsed" }], done)).toEqual(done);
    expect(run([{ type: "next" }], done)).toEqual(TOUR_IDLE);
    expect(run([{ type: "back" }], done)).toEqual({ status: "paused", index: N - 2 });
    expect(run([{ type: "start", reducedMotion: false }], done)).toEqual({ status: "playing", index: 0 });
  });

  it("stops from any state (Esc, or any input), and ignores events when idle", () => {
    for (const from of [
      { status: "playing", index: 2 },
      { status: "paused", index: 1 },
      { status: "manual", index: 4 },
      { status: "done", index: 4 },
    ] as TourState[]) {
      expect(isTouring(run([{ type: "stop" }], from))).toBe(false);
    }
    for (const e of [{ type: "next" }, { type: "back" }, { type: "pause" }, { type: "resume" }, { type: "elapsed" }] as TourEvent[]) {
      expect(run([e])).toEqual(TOUR_IDLE);
    }
  });

  it("has nothing to tour without stops", () => {
    expect(tourReducer(TOUR_IDLE, { type: "start", reducedMotion: false }, 0)).toEqual(TOUR_IDLE);
  });
});

describe("tourStops", () => {
  let cache: CacheBundle;
  beforeAll(async () => {
    cache = await loadCache("sample", diskFetch());
  });

  it("visits the six steps in story order, in about a minute", () => {
    const stops = tourStops(cache);
    expect(stops.map((s) => s.step)).toEqual(STEPS.map((s) => s.id));
    expect(tourLengthMs(stops)).toBeGreaterThan(40_000);
    expect(tourLengthMs(stops)).toBeLessThanOrEqual(60_000);
  });

  it("demos an answer on Review and plays the flight on Search next, inside each stop's time", () => {
    const stops = tourStops(cache);
    expect(stops.find((s) => s.action === "demoAnswer")?.step).toBe("review");
    expect(stops.find((s) => s.action === "playFlight")?.step).toBe("search");
    for (const s of stops) if (s.action) expect(s.actionAtMs!).toBeLessThan(s.ms);
  });

  it("takes its numbers from the cache and labels simulated things", () => {
    const stops = tourStops(cache);
    const text = stops.map((s) => `${s.title} ${s.body}`).join(" ");
    expect(stops[0]!.title).toContain(String(cache.manifest.n_frames));
    expect(text).toContain(String(cache.metrics.detector.threshold));
    expect(text).toMatch(/10 m position radius \(simulated\)/);
    expect(text).toMatch(/flight \(simulated\)/);
    expect(text).toMatch(/not saved/);
    // sample: 2 photos with a person in the first 2 of 20
    expect(stops.at(-1)!.body).toContain(
      `All ${cache.metrics.ranking.n_positive} photos with a person were in the first ${cache.metrics.ranking.ranked.frames_to_all_hits}`,
    );
    // No per-photo human time: survey photos are sections of full photos (see Results).
    expect(text).not.toMatch(/33 s/);
  });

  it("says every photo has a person when that is so", () => {
    const c = structuredClone(cache);
    c.metrics.ranking.n_positive = c.metrics.ranking.n_frames;
    const stops = tourStops(c);
    expect(stops[0]!.title).toMatch(/a person in each/);
    expect(stops.at(-1)!.body).not.toMatch(/random order/);
  });
});
