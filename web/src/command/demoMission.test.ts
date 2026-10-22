// E-04: the demo mission's fixtures and how they become the map log (no API).
import { describe, expect, it } from "vitest";
import type { MapFile } from "../contract";
import fixture from "./__fixtures__/demo_mission.json";
import { cacheBase, loadDemoMission } from "./demoMission";

const map = {
  contract_version: "1.2",
  grid: { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 5, rows: 2, cols: 2 },
  lkp: { lat: 49.369, lon: -122.949 },
  params: { recall: 0.8, recall_source: "x", pod_cap: 0.95, review_pod: 0.9 },
  prior: { p: [0.25, 0.25, 0.25, 0.25], outside: 0 },
  canopy: [null, 0.2, null, null],
  steps: [{ frame_id: "f0001", cells: [[1, 0.5]] }, { frame_id: "f0002", cells: [[2, 0.4]] }],
  final: { p: [0.25, 0.25, 0.25, 0.25], outside: 0 },
  top_cells: [],
} as unknown as MapFile;

describe("demo mission", () => {
  it("has every task state, radio and form clues, and two proposals waiting with real crops", () => {
    const states = new Set(fixture.tasks.map((t) => t.state));
    expect(states).toEqual(new Set(["proposed", "assigned", "in_progress", "searched"]));
    expect(fixture.tasks).toHaveLength(8);
    expect(fixture.clues.filter((c) => c.source === "radio")).toHaveLength(2);
    expect(fixture.clues).toHaveLength(5);
    const pending = fixture.proposals.filter((p) => p.status === "pending");
    expect(pending).toHaveLength(2);
    expect(pending.flatMap((p) => p.evidence).some((e) => e.kind === "crop" && e.ref.startsWith("crops/f"))).toBe(true);
    expect(fixture.sectors).toHaveLength(16);
    expect(JSON.stringify(fixture)).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });

  it("turns the cache's steps into the map log, then the ground searches", async () => {
    const fetchFn = (async () => new Response(JSON.stringify(map))) as unknown as typeof fetch;
    const { data, now } = await loadDemoMission(fetchFn);
    expect(now).toBe(fixture.now);
    expect(data.mapBase).toEqual(cacheBase(map));
    const ups = data.mapUpdates ?? [];
    expect(ups.slice(0, 2).map((u) => [u.seq, u.kind, u.source, u.ref])).toEqual([
      [1, "step", "frame", "f0001"],
      [2, "step", "frame", "f0002"],
    ]);
    expect(ups.slice(2).every((u) => u.source === "ground")).toBe(true);
    expect(data.mission?.mode).toBe("demo");
  });

  it("says so when the demo map is missing", async () => {
    const fetchFn = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(loadDemoMission(fetchFn)).rejects.toThrow("the demo map is missing (404)");
  });
});

describe("the demo's pre-seeded note", () => {
  it("says what is pre-seeded and when, in one sentence", async () => {
    const { demoSeedWords } = await import("../ingest/LiveMission");
    expect(demoSeedWords(fixture as never)).toBe(
      "Pre-seeded demo, scripted timeline: 5 clues, 6 proposals, 4 teams. What you change stays while you're on this mission.",
    );
  });
});
