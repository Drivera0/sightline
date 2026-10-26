// The mission goals and the score (goals.ts): each goal from the run's own state, the score's parts adding
// up to 100 and saying how each is worked out, and the best score kept per scenario.
import { afterEach, describe, expect, it } from "vitest";
import { keepBest, missionGoals, missionScore, readBest, WEIGHTS, type GoalInput } from "./goals";

const min = 60_000;
const base: GoalInput = {
  found: null,
  lastLight: 300 * min,
  now: 60 * min,
  photos: { flagged: 3, answered: 1 },
  clues: { total: 2, confirmed: 1 },
  teams: { total: 4, overdueNow: 0, everOverdue: 0 },
};
const byId = (g: ReturnType<typeof missionGoals>) => Object.fromEntries(g.map((x) => [x.id, x]));

describe("the mission goals", () => {
  it("reads each goal from the run's state, in words and as a chip figure", () => {
    const g = byId(missionGoals(base));
    expect(g.find).toMatchObject({ state: "open", progress: "4 h 00 min of light left", brief: "", share: 0 });
    expect(g.photos).toMatchObject({ state: "open", progress: "1 of 3 answered", brief: "1/3" });
    expect(g.photos!.share).toBeCloseTo(1 / 3);
    expect(g.clues).toMatchObject({ state: "open", progress: "1 of 2 confirmed", brief: "1/2", share: 0.5 });
    expect(g.checkins).toMatchObject({ state: "done", progress: "all 4 heard in time", brief: "4/4", share: 1 });
  });

  it("ticks a goal once it is met, and marks one missed once it can no longer be", () => {
    const g = byId(missionGoals({ ...base, found: 200 * min, now: 200 * min, photos: { flagged: 3, answered: 3 }, clues: { total: 2, confirmed: 2 }, teams: { total: 4, overdueNow: 1, everOverdue: 2 } }));
    expect(g.find!.state).toBe("done");
    expect(g.photos!.state).toBe("done");
    expect(g.clues!.state).toBe("done");
    expect(g.checkins).toMatchObject({ state: "missed", progress: "1 not heard in time", share: 0.5 });
    // last light gone with no find: missed; a find after it is late
    expect(byId(missionGoals({ ...base, now: 301 * min })).find).toMatchObject({ state: "missed", progress: "last light has gone" });
    expect(byId(missionGoals({ ...base, found: 320 * min, now: 320 * min })).find).toMatchObject({ state: "missed", progress: "found after last light", share: 0 });
  });

  it("says nothing flagged or radioed yet, rather than a count nobody has seen", () => {
    const g = byId(missionGoals({ ...base, photos: { flagged: 0, answered: 0 }, clues: { total: 0, confirmed: 0 } }));
    expect(g.photos).toMatchObject({ state: "open", progress: "none flagged yet", brief: "–", share: 1 });
    expect(g.clues).toMatchObject({ state: "open", progress: "none by radio yet", brief: "–", share: 1 });
  });
});

describe("the score out of 100", () => {
  const goalsAll = missionGoals({ ...base, found: 112 * min, now: 112 * min, photos: { flagged: 3, answered: 3 }, clues: { total: 2, confirmed: 2 } });

  it("adds up the parts, 100 for every goal met at the AI's time, each part saying how it is worked out", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const s = missionScore(goalsAll, { you: 112, manual: 172, agent: 112, lastLight: 300 });
    expect(s.total).toBe(100);
    expect(s.parts.map((p) => p.id)).toEqual(["find", "speed", "photos", "clues", "checkins"]);
    expect(s.parts.reduce((n, p) => n + p.max, 0)).toBe(100);
    for (const p of s.parts) expect(p.how.length).toBeGreaterThan(10);
    expect(s.parts.find((p) => p.id === "speed")!.how).toContain("the manual search takes 2 h 52 min");
  });

  it("scores the time to find between the manual line (none) and the faster of you and the AI (all 20)", () => {
    const at = (you: number) => missionScore(goalsAll, { you, manual: 172, agent: 112, lastLight: 300 }).parts.find((p) => p.id === "speed")!.points;
    expect(at(112)).toBe(20);
    expect(at(100)).toBe(20); // faster than the AI: the best is yours
    expect(at(142)).toBe(10);
    expect(at(172)).toBe(0);
    expect(at(200)).toBe(0);
    // a manual line with no find by last light: last light is its time
    expect(missionScore(goalsAll, { you: 206, manual: null, agent: 112, lastLight: 300 }).parts.find((p) => p.id === "speed")!.points).toBe(10);
  });

  it("gives no find and no time points when the subject is not found by last light, and scores the rest in proportion", () => {
    const g = missionGoals({ ...base, now: 301 * min });
    const s = missionScore(g, { you: null, manual: 172, agent: 112, lastLight: 300 });
    expect(s.parts.find((p) => p.id === "find")!.points).toBe(0);
    expect(s.parts.find((p) => p.id === "speed")!.points).toBe(0);
    // photos 1 of 3 (5), clues 1 of 2 (7.5), check-ins all (10)
    expect(s.total).toBe(Math.round(5 + 7.5 + 10));
  });

  it("never claims more than it measured: only the run's own numbers in the parts", () => {
    const s = missionScore(goalsAll, { you: 112, manual: 172, agent: null, lastLight: 300 });
    expect(s.parts.find((p) => p.id === "speed")!.how).not.toMatch(/AI's every pick/);
    for (const p of s.parts) expect(p.how).not.toMatch(/\bclear(ed|s)?\b/i);
  });
});

describe("the best score per scenario", () => {
  afterEach(() => localStorage.clear());

  it("keeps the best in this browser, per scenario", () => {
    expect(readBest("overdue-hiker")).toBeNull();
    expect(keepBest("overdue-hiker", 70)).toEqual({ best: null, beat: true });
    expect(keepBest("overdue-hiker", 60)).toEqual({ best: 70, beat: false });
    expect(keepBest("overdue-hiker", 85)).toEqual({ best: 70, beat: true });
    expect(readBest("overdue-hiker")).toBe(85);
    expect(readBest("missing-child")).toBeNull();
  });

  it("goes on without storage (private mode)", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(readBest("x")).toBeNull();
      expect(keepBest("x", 50)).toEqual({ best: null, beat: true });
    } finally {
      Object.defineProperty(globalThis, "localStorage", real);
    }
  });
});
