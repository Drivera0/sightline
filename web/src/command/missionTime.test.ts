import { describe, expect, it, onTestFinished } from "vitest";
import type { MapBase, MapUpdate, MissionEvent } from "../contract";
import type { MissionData } from "../lib/mission";
import fixture from "./__fixtures__/demo_mission.json";
import {
  BOARD_AT,
  CHECKPOINTS,
  FLIGHT,
  MARK_COUNT,
  STORY_PROPOSAL,
  TRAILHEAD,
  checkpointAtOrBefore,
  clockAt,
  demoAt,
  frameTime,
  tFromHash,
  type DemoFull,
} from "./missionTime";
import { useStory } from "./story";

// The demo cache's map is not in the repository: a flat prior on the real grid, and ten frame steps.
const GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 200, cols: 200 };
const base: MapBase = {
  contract_version: "1.2",
  grid: GRID,
  lkp: { lat: 49.37, lon: -122.945 },
  params: { recall: 0.864, recall_source: "x", pod_cap: 0.95, review_pod: 0.9, prior_source: "placeholder" },
  prior: { p: new Array(40000).fill(0.5 / 40000), outside: 0.5 },
  canopy: new Array(40000).fill(null),
} as unknown as MapBase;
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({
  seq: k + 1,
  kind: "step",
  source: "frame",
  ref: `f${String(k + 1).padStart(4, "0")}`,
  cells: [[k * 201, 0.5]],
  canopy: null,
  at: "2026-10-24T20:30:00Z",
}));
const fx = fixture as unknown as Partial<MissionData> & { now: string; ground_updates: MapUpdate[] };
const full: DemoFull = {
  data: { ...fx, mapBase: base, mapUpdates: [...frames, ...fx.ground_updates], verdicts: [] },
  now: fx.now,
};
const at = (t: 0 | 1 | 2 | 3 | 4 | 5) => demoAt(full, clockAt(t));

describe("mission time: the demo mission's checkpoints", () => {
  it("has six checkpoints in clock order and five coach marks, one sentence each", () => {
    expect(CHECKPOINTS.map((c) => c.id)).toEqual(["call", "photos", "confirm", "next", "run", "results"]);
    const times = CHECKPOINTS.map((c) => new Date(c.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(MARK_COUNT).toBe(5);
    for (const c of CHECKPOINTS) if (c.mark) expect(c.mark.text.split(/[.!?](\s|$)/).filter((x) => x.trim()).length).toBe(1);
    expect(CHECKPOINTS.at(-1)!.at).toBe(fx.now); // the story ends at the fixtures' "now"
  });

  it("t0, the call: the first clue, everyone at the trailhead, an empty board, no photo on the map", () => {
    const s = at(0);
    expect(s.clues!.map((c) => c.id)).toEqual(["c001"]);
    expect(s.tasks).toEqual([]);
    expect(s.proposals).toEqual([]);
    expect(s.mapUpdates).toEqual([]);
    expect(s.teams!.every((t) => t.status === "standby" && t.position?.lat === TRAILHEAD.lat)).toBe(true);
    // nothing has flown yet: no drone on the map (no SIM marker, no battery label) until the survey flight
    expect(s.fleet!.drones).toEqual([]);
    expect(s.fleet!.legs).toEqual([]);
  });

  it("t1, photos land: the drones are back on the ground at the trailhead, idle, no leg", () => {
    const s = at(1);
    expect(s.fleet!.drones.length).toBeGreaterThan(0);
    expect(s.fleet!.drones.every((d) => d.status === "idle" && d.leg_id === null && d.position?.lat === TRAILHEAD.lat)).toBe(true);
    expect(demoAt(full, FLIGHT.start).fleet!.drones.length).toBeGreaterThan(0);
  });

  it("t1, photos land: every frame step on the map, in flight order; the frames stream in on the way", () => {
    expect(at(1).mapUpdates!.filter((u) => u.source === "frame")).toHaveLength(10);
    const half = demoAt(full, clockAt(1, 0.5)).mapUpdates!;
    expect(half.length).toBeGreaterThan(0);
    expect(half.length).toBeLessThan(10);
    expect(half[0]).toBe(frames[0]); // the same objects: the map's incremental replay keeps its place
    expect(frameTime(0, 500)).toBe(new Date(FLIGHT.start).getTime());
    expect(frameTime(499, 500)).toBe(new Date(FLIGHT.end).getTime());
  });

  it("t1 to t3: sector POA follows the map as it stood (flat prior: 1/32 each before any search)", () => {
    const s = at(0);
    for (const x of s.sectors!) expect(x.poa).toBeCloseTo(0.5 / 16, 4);
  });

  it("t2, confirm: the promotion is decided, the assignment not proposed yet", () => {
    const s = at(2);
    expect(s.proposals!.find((p) => p.id === "p006")?.status).toBe("approved");
    expect(s.proposals!.some((p) => p.id === STORY_PROPOSAL)).toBe(false);
    expect(s.tasks).toEqual([]);
  });

  it("t3, where next: the board is seeded from the map and the story's proposal waits for a person", () => {
    const s = at(3);
    expect(clockAt(3)).toBe(BOARD_AT);
    const p = s.proposals!.find((x) => x.id === STORY_PROPOSAL)!;
    expect(p.status).toBe("pending");
    expect(p.decided_by).toBeNull();
    expect(s.tasks!.every((t) => t.state === "proposed")).toBe(true);
    expect(s.teams!.every((t) => t.status === "standby")).toBe(true);
  });

  it("t4, run: the fixtures' end; B4 searched at POD 60 %, teams out, drones on their legs", () => {
    const s = at(4);
    const b4 = s.tasks!.find((t) => t.sector_id === "B4")!;
    expect(b4.state).toBe("searched");
    expect(b4.pod).toBe(0.6);
    expect(s.teams!.filter((t) => t.status === "searching")).toHaveLength(2);
    expect(s.fleet!.drones.some((d) => d.status === "flying")).toBe(true);
    expect(s.mapUpdates).toHaveLength(12);
  });

  it("on the way into t4, B4's search lands late in the run (story pacing), C4's earlier", () => {
    const mid = demoAt(full, clockAt(4, 0.5)); // 21:51
    expect(mid.tasks!.find((t) => t.sector_id === "C4")!.state).toBe("searched");
    expect(mid.tasks!.find((t) => t.sector_id === "B4")!.state).toBe("proposed");
    expect(mid.events!.every((e, i, all) => i === 0 || all[i - 1]!.at <= e.at)).toBe(true);
  });

  it("replays the visitor's own actions where they had happened by then", () => {
    const decided: MissionEvent = {
      id: "e00099",
      type: "proposal.decided",
      at: BOARD_AT,
      summary: "p001 rejected",
      ref: STORY_PROPOSAL,
      data: { ...fx.proposals!.find((p) => p.id === STORY_PROPOSAL)!, status: "rejected", decided_by: "You" } as never,
    };
    expect(demoAt(full, clockAt(3), [decided]).proposals!.find((p) => p.id === STORY_PROPOSAL)!.status).toBe("rejected");
    expect(demoAt(full, clockAt(2), [decided]).proposals!.some((p) => p.id === STORY_PROPOSAL)).toBe(false);
  });

  it("reads ?t= from the hash and finds the checkpoint at a clock reading", () => {
    expect(tFromHash("#m/demo?t=3")).toBe(3);
    expect(tFromHash("#m/demo/map?t=0")).toBe(0);
    expect(tFromHash("#m/demo?t=9")).toBeNull();
    expect(tFromHash("#m/demo")).toBeNull();
    expect(checkpointAtOrBefore(clockAt(2, 0.5))).toBe(1);
    expect(checkpointAtOrBefore(clockAt(5))).toBe(4);
  });
});

describe("the story's clock", () => {
  it("begins at t1 with the marks on, steps with next and previous, and leaves the clock where it is on exit", () => {
    useStory.getState().reset();
    useStory.getState().begin();
    expect(useStory.getState()).toMatchObject({ t: 1, tour: true, pitch: false });
    useStory.getState().setProgress(1);
    useStory.getState().next();
    expect(useStory.getState().t).toBe(2);
    useStory.getState().previous();
    expect(useStory.getState()).toMatchObject({ t: 1, progress: 1 });
    useStory.getState().exit();
    expect(useStory.getState()).toMatchObject({ t: 1, tour: false });
    useStory.getState().skipToNow();
    expect(useStory.getState()).toMatchObject({ t: 4, progress: 1, tour: false });
  });

  it("with reduced motion the scrubber's play jumps to the end", () => {
    useStory.getState().reset();
    useStory.getState().seek(1, { tour: false });
    useStory.getState().play(); // the tests have no matchMedia: reduced motion
    expect(useStory.getState()).toMatchObject({ t: 4, progress: 1, playing: false, through: null });
  });

  it("the scrubber's play runs the clock from the checkpoint it is at through to the end, and pauses", () => {
    const had = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
    onTestFinished(() => {
      window.matchMedia = had;
    });
    useStory.getState().reset();
    useStory.getState().seek(1, { tour: false });
    useStory.getState().play();
    expect(useStory.getState()).toMatchObject({ t: 2, progress: 0, playing: true, through: clockAt(1) });
    useStory.getState().play(); // pause
    expect(useStory.getState().playing).toBe(false);
    useStory.getState().play(); // resume
    for (const t of [3, 4]) {
      useStory.getState().setProgress(1);
      expect(useStory.getState()).toMatchObject({ t, progress: 0, playing: true });
    }
    useStory.getState().setProgress(1);
    expect(useStory.getState()).toMatchObject({ t: 4, progress: 1, playing: false, through: null });
    // at the end, play starts again from the call
    useStory.getState().play();
    expect(useStory.getState()).toMatchObject({ t: 1, playing: true, through: clockAt(0) });
    // a click on a tick ends the play-through
    useStory.getState().seek(3);
    expect(useStory.getState().through).toBeNull();
  });
});

describe("the run: drones fly their legs and teams walk out as the clock moves", () => {
  const mid = new Date((new Date("2026-10-24T21:44:00Z").getTime() + new Date(fx.now).getTime()) / 2).toISOString();
  const near = (a: { lat: number; lon: number } | null | undefined, b: { lat: number; lon: number }) => !!a && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;

  it("half way through the run every drone is between the trailhead and where it ends up, and moving", () => {
    const end = demoAt(full, fx.now).fleet!.drones;
    const a = demoAt(full, mid).fleet!.drones;
    const b = demoAt(full, new Date(new Date(mid).getTime() + 60_000).toISOString()).fleet!.drones;
    for (const [i, d] of a.entries()) {
      expect(d.status).toBe("flying");
      expect(near(d.position, TRAILHEAD)).toBe(false);
      expect(near(d.position, end[i]!.position!)).toBe(false);
      expect(near(d.position, b[i]!.position!)).toBe(false); // a minute later it is somewhere else
    }
    expect(demoAt(full, clockAt(4)).fleet!.drones.map((d) => d.position)).toEqual(end.map((d) => d.position));
  });

  it("a team out on a task walks from the trailhead to its last reported position", () => {
    const t1 = (clock: string) => demoAt(full, clock).teams!.find((t) => t.id === "T1")!;
    expect(near(t1("2026-10-24T21:44:00Z").position, TRAILHEAD)).toBe(true);
    const walking = t1("2026-10-24T21:48:00Z");
    expect(near(walking.position, TRAILHEAD)).toBe(false);
    expect(near(walking.position, fx.teams!.find((t) => t.id === "T1")!.position!)).toBe(false);
    expect(t1(fx.now).position).toEqual(fx.teams!.find((t) => t.id === "T1")!.position);
  });
});
