import { describe, expect, it } from "vitest";
import type { MapUpdate } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import child from "./__fixtures__/scenarios/missing-child.json";
import { CHECKPOINTS, clockAt, demoAt, LAST, type DemoFull } from "./missionTime";
import { shiftTimes } from "./scenarios";
import { STORY_BANNED, storyClue, storyProposal } from "./storyCopy";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[]; t0?: string };

// ten survey photos on the flight (the cache's map is not in the repository)
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f${String(k + 1).padStart(4, "0")}`, cells: [], canopy: null, at: "2026-10-24T20:30:00Z" }));

/** A fixture as the console loads it: on the demo mission's afternoon (scenarios.ts), its map log in. */
function load(raw: unknown): DemoFull {
  const fx0 = raw as Fixture;
  const from = fx0.t0 ?? fx0.mission?.created_at;
  const to = (demo as unknown as Fixture).mission!.created_at;
  const fx = from && to ? shiftTimes(fx0, new Date(to).getTime() - new Date(from).getTime()) : fx0;
  return { now: fx.now, data: { ...fx, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] } };
}

const overdue = load(demo);
const missingChild = load(child);

describe("the roles the guided search anchors to, on the overdue hiker", () => {
  it("the first assignment, and the clue its reason names (by radio, last)", () => {
    expect(storyProposal(overdue)?.id).toBe("p002");
    expect(storyClue(overdue)?.id).toBe("c004"); // c001 and c004 raised C2; c004 came by radio, last
  });

  it("the checkpoint model outside the guided search: nothing found at t4, found at t5, the report's mission at t6", () => {
    expect(demoAt(overdue, clockAt(4)).mission!.found).toBeNull();
    expect(demoAt(overdue, clockAt(5)).mission!.status).toBe("found");
    expect(demoAt(overdue, clockAt(LAST)).mission!.found!.sector).toBe("C2");
  });
});

describe("the roles on another scenario: the missing child", () => {
  it("keeps the rhythm: shifted onto the same afternoon, the find between t4 and t5", () => {
    const found = missingChild.data.mission!.found!;
    expect(new Date(found.at).getTime()).toBeGreaterThan(new Date(clockAt(4)).getTime());
    expect(new Date(found.at).getTime()).toBeLessThan(new Date(clockAt(5)).getTime());
    expect(demoAt(missingChild, clockAt(4)).mission!.found).toBeNull();
    expect(demoAt(missingChild, clockAt(5)).mission!).toMatchObject({ status: "found", found: { sector: "B2" } });
    const s3 = demoAt(missingChild, clockAt(3));
    expect(s3.proposals!.find((p) => p.id === storyProposal(missingChild)!.id)!.status).toBe("pending");
    expect(storyClue(missingChild)?.text).toBe("a juice box, half full");
  });
});

describe("the words", () => {
  it("the banned list catches the disclosure's words and nothing a mark says", () => {
    expect(STORY_BANNED.test("Simulation on real aerial photographs")).toBe(true);
    expect(STORY_BANNED.test("Drone two loses its link")).toBe(false);
  });

  it("names every checkpoint on the scrubber", () => {
    expect(CHECKPOINTS.map((c) => c.label)).toEqual(["The call", "Photos land", "Confirm", "Where next", "Run", "The find", "Debrief"]);
  });
});
