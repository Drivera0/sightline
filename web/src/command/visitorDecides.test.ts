// The visitor decides (judges 2026-10-23 items 2 and 3): the visitor's decisions are theirs alone, the
// scenario's own approvals wait for them once they play the clock, and what they assign plays through the
// guided search's engine (sim.ts), the one engine for both modes.
import { describe, expect, it } from "vitest";
import type { MapUpdate, MissionEvent, SectorTask } from "../contract";
import type { MissionData } from "../lib/mission";
import fixture from "./__fixtures__/demo_mission.json";
import { demoAt, NOW_AT } from "./missionTime";
import { buildTimeline } from "./timeline";

const fx = fixture as unknown as Partial<MissionData> & { now: string };
const frames: MapUpdate[] = Array.from({ length: 4 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f000${k + 1}`, cells: [[k, 0.5]], canopy: null, at: fx.mission!.created_at }));
const full = { data: { ...fx, mapUpdates: frames }, now: fx.now };
const userDecides = (pid: string, at: string): MissionEvent => ({ id: "u0001", type: "proposal.decided", at, summary: `${pid} approved by Search manager`, ref: pid, data: { ...fx.proposals!.find((p) => p.id === pid)!, status: "approved", decided_by: "Search manager", decided_at: at } as never });
const userAssigns = (team: string, sector: string, at: string): MissionEvent => ({ id: "u0002", type: "task.updated", at, summary: `sector ${sector}: assigned`, ref: sector, data: { sector_id: sector, state: "assigned", team_id: team, poa: 0, pod: null, note: null, updated_at: at } as SectorTask as never });

describe("the visitor decides", () => {
  it("(2) a proposal the visitor approved is logged once: the scenario's own approval of it goes", () => {
    const s = demoAt(full, NOW_AT, [userDecides("p002", "2026-10-24T21:42:30Z")]);
    const lines = buildTimeline(s.events ?? [], s.teams ?? [], s.timeline ?? []).filter((e) => e.kind === "decision" && e.refs.includes("p002") && /approved/.test(e.text));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toMatch(/^Search manager approved agent p002/);
  });

  it("(3) free mode: the scenario's approvals are the scenario's search manager's, never the visitor's", () => {
    const s = demoAt(full, NOW_AT);
    const p3 = buildTimeline(s.events ?? [], s.teams ?? [], s.timeline ?? []).find((e) => e.kind === "decision" && e.refs.includes("p003"))!;
    expect(p3.text).toMatch(/^The scenario's search manager approved agent p003/);
  });

  it("(3) holding: nothing is approved without the visitor, nothing follows from it, no find", () => {
    const s = demoAt(full, NOW_AT, [], null, { hold: true, seed: "overdue-hiker" });
    expect(s.proposals!.filter((p) => p.kind === "assign_sector").every((p) => p.status === "pending")).toBe(true);
    expect(s.tasks!.some((t) => t.team_id === "T1" && t.sector_id === "C2")).toBe(false);
    expect(s.mission!.found).toBeNull();
    const tl = buildTimeline(s.events ?? [], s.teams ?? [], s.timeline ?? []);
    expect(tl.some((e) => /approved agent p00[234]/.test(e.text))).toBe(false);
    expect(tl.filter((e) => /Subject located|Subject found/.test(e.text))).toEqual([]);
  });

  it("holding: the visitor's assignment plays through the guided search's engine (sim.ts), deterministically", () => {
    const user = [userDecides("p002", "2026-10-24T21:42:30Z"), userAssigns("T1", "C2", "2026-10-24T21:42:30Z")];
    const s = demoAt(full, NOW_AT, user, null, { hold: true, seed: "overdue-hiker" });
    expect(s.teams!.find((t) => t.id === "T1")!.last_heard_at).not.toBeNull(); // out and heard from
    const said = (s.timeline ?? []).filter((e) => e.team === "T1" && e.kind === "radio").map((e) => e.text);
    expect(said.some((x) => /Subject located in Charlie Two|Charlie Two searched, no sign/.test(x))).toBe(true);
    expect(demoAt(full, NOW_AT, user, null, { hold: true, seed: "overdue-hiker" }).timeline).toEqual(s.timeline);
  });
});
