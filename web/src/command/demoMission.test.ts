// E-04: the demo mission's fixtures and how they become the map log (no API).
import { describe, expect, it } from "vitest";
import type { MapFile } from "../contract";
import fixture from "./__fixtures__/demo_mission.json";
import { cacheBase, demoImageUrl, loadDemoMission, loadDemoTrace } from "./demoMission";
import { chains } from "./trace";

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
  it("has every task state, radio and form clues, and a promotion waiting with the second look's images", () => {
    const states = new Set(fixture.tasks.map((t) => t.state));
    expect(states).toEqual(new Set(["proposed", "assigned", "in_progress", "searched"]));
    expect(fixture.tasks).toHaveLength(16);
    expect(fixture.clues.filter((c) => c.source === "radio")).toHaveLength(2);
    expect(fixture.clues).toHaveLength(4);
    const pending = fixture.proposals.filter((p) => p.status === "pending");
    expect(pending.map((p) => p.kind)).toEqual(["promote_detection"]);
    const images = pending.flatMap((p) => p.evidence).filter((e) => e.kind === "crop" || e.kind === "relook");
    expect(images.length).toBeGreaterThan(0);
    for (const e of images) expect(demoImageUrl(e.ref)).not.toMatch(/^\/cache\//); // shipped with the fixtures
    expect(fixture.sectors).toHaveLength(16);
    expect(JSON.stringify(fixture)).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });

  it("every proposal has its chain in the demo's own trace: the calls that led to it, the proposal, the decision", async () => {
    const { runs } = await loadDemoTrace();
    const own = runs[0]!;
    // the view names roles and models; the data still says the models are fakes and the people scripted
    expect(own.entries.filter((e) => e.model !== null).every((e) => /^(fake|recorded)\//.test(e.model!))).toBe(true);
    const by = own.entries.filter((e) => e.kind === "decision").map((e) => (e.output as { by: string }).by);
    expect(by.length).toBeGreaterThan(0);
    expect(by.every((b) => /\(scripted for the demo fixture\)$/.test(b))).toBe(true);
    const groups = chains(own.entries);
    for (const p of fixture.proposals) {
      const c = groups.find((g) => g.entries.some((e) => e.kind === "proposal" && e.refs.includes(p.id)));
      expect(c, p.id).toBeDefined();
      const kinds = c!.entries.map((e) => e.kind);
      expect(kinds).toContain("model_call");
      if (p.kind === "promote_detection") expect(kinds).toContain("tool_call"); // the OpenCV re-look
      if (p.status !== "pending") expect(kinds).toContain("decision");
      // fakes, and the one live answer replayed word for word (second_look/verdict.json)
      for (const e of c!.entries.filter((x) => x.kind === "model_call")) expect(e.model).toMatch(/^(fake|recorded)\//);
    }
  });

  it("turns the cache's steps into the map log, then the clues and the ground searches", async () => {
    const fetchFn = (async () => new Response(JSON.stringify(map))) as unknown as typeof fetch;
    const { data, now } = await loadDemoMission(fetchFn);
    expect(now).toBe(fixture.now);
    expect(data.mapBase).toEqual(cacheBase(map));
    const ups = data.mapUpdates ?? [];
    expect(ups.slice(0, 2).map((u) => [u.seq, u.kind, u.source, u.ref])).toEqual([
      [1, "step", "frame", "f0001"],
      [2, "step", "frame", "f0002"],
    ]);
    const after = ups.slice(2).filter((u) => u.seq > 500); // after the cache's 500 frames
    expect(after.filter((u) => u.source !== "frame").map((u) => [u.seq, u.source])).toEqual([[501, "clue"], [502, "clue"], [503, "clue"], [504, "clue"], [505, "ground"], [506, "ground"]]);
    // then the drone legs' photos, at their own capture times
    expect(after.filter((u) => u.source === "frame")).toHaveLength(680);
    expect(after.filter((u) => u.source === "frame").every((u) => u.seq > 506 && u.at >= "2026-10-24T21:50:00Z")).toBe(true);
    expect(data.mission?.mode).toBe("demo");
  });

  it("says so when the demo map is missing", async () => {
    const fetchFn = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(loadDemoMission(fetchFn)).rejects.toThrow("the demo map is missing (404)");
  });
});
