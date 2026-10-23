import { describe, expect, it } from "vitest";
import type { MapUpdate, MissionEvent } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import child from "./__fixtures__/scenarios/missing-child.json";
import despondent from "./__fixtures__/scenarios/despondent.json";
import dementia from "./__fixtures__/scenarios/dementia.json";
import hiker from "./__fixtures__/scenarios/overdue-hiker.json";
import { SECOND_LOOK_ID } from "./demoReview";
import { activeInject, agentOption, choiceFor, costsOf, currentCard, hotWash, injects, PIPS, standingUser, type Choice, type GuideInput, type Inject } from "./guide";
import { demoAt, onMissionClock, poaOf, subjectOf, type DemoFull } from "./missionTime";
import { shiftTimes } from "./scenarios";
import { agentLine, fixtureOf, passesFrom, realOf, TEAM_POD } from "./sim";
import { guideStep } from "./story";
import { STORY_BANNED, STORY_NOT_A_PERSON, storyProposal } from "./storyCopy";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[]; t0?: string };
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f${String(k + 1).padStart(4, "0")}`, cells: [], canopy: null, at: "2026-10-24T20:30:00Z" }));
function load(raw: unknown): DemoFull {
  const fx0 = raw as Fixture;
  const from = fx0.t0 ?? fx0.mission?.created_at;
  const to = (demo as unknown as Fixture).mission!.created_at;
  const fx = from && to ? shiftTimes(fx0, new Date(to).getTime() - new Date(from).getTime()) : fx0;
  return { now: fx.now, data: { ...fx, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] } };
}
const overdue = load(demo);
const missingChild = load(child);
const queue = [
  { id: "f0336-d01", conf: 0.82 },
  { id: "f0127-d01", conf: 0.8 },
  { id: SECOND_LOOK_ID, conf: 0.17 },
  { id: STORY_NOT_A_PERSON, conf: 0.47 },
];
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
let seq = 0;
const assignEv = (team: string, sector: string, at: number): MissionEvent => ({ id: `u${++seq}`, type: "task.updated", at: iso(at), summary: `sector ${sector}: assigned`, ref: sector, data: { sector_id: sector, state: "assigned", team_id: team, poa: 0, pod: null, note: null, updated_at: iso(at) } as never });
const foundEv = (team: string, sector: string, at: number): MissionEvent => ({ id: `u${++seq}`, type: "mission.note", at: iso(at), summary: "Found", ref: sector, data: { action: "found", mission: { ...overdue.data.mission, status: "found", found: { team, sector, lat: 0, lon: 0, at: iso(at) } } } as never });

/** Play the agent's line through the engine: every decision its own option, the console's events as the console makes them. */
function playAgentLine(full: DemoFull, seed: string): { choices: Choice[]; user: MissionEvent[]; list: Inject[] } {
  const choices: Choice[] = [];
  const mine: MissionEvent[] = [];
  for (let guard = 0; guard < 40; guard++) {
    const user = standingUser(full, seed, mine, choices);
    const input: GuideInput = { full, seed, user, choices, queue };
    const list = injects(input);
    const i = activeInject(list, choices);
    if (!i) return { choices, user, list };
    const card = currentCard(i, choices);
    const ag = agentOption(i, card);
    choices.push(choiceFor(i, ag.id, i.at, card, true));
    if (i.id === "assign") {
      const p = i.key === "assign" ? storyProposal(full) : null;
      const target = p ? p.target : (demoAt(full, iso(i.at + 1000), user, { seed }).proposals ?? []).find((x) => x.id === i.proposal)?.target;
      if (target?.team && target.sector) mine.push(assignEv(target.team, target.sector, i.at));
    }
    if (i.id === "find" && i.find) mine.push(foundEv(i.find.team, i.find.sector, i.at));
  }
  throw new Error("the agent's line did not end");
}

describe("the guided search's injects", () => {
  it("runs survey, triage, clue, assign and link on the overdue hiker (no gusts in its conditions)", () => {
    const list = injects({ full: overdue, seed: "overdue-hiker", user: [], choices: [], queue });
    expect(list.map((i) => i.id)).toEqual(["survey", "triage", "clue", "assign", "link"]);
    const triage = list.find((i) => i.id === "triage")!;
    expect(triage.cards!.map((c) => c.id)).toEqual(["f0336-d01", STORY_NOT_A_PERSON, SECOND_LOOK_ID]);
  });

  it("runs the fleet's decisions and the gust recall on the missing child (every scenario flies the fleet)", () => {
    const list = injects({ full: missingChild, seed: "missing-child", user: [], choices: [], queue });
    // its radio clue comes in before the photos are reviewed: the injects keep the mission's order
    expect(list.map((i) => i.id)).toEqual(["survey", "clue", "triage", "assign", "link", "wind"]);
  });

  it("writes every prompt verb first, the key last, without first person or the banned words", () => {
    for (const [full, seed] of [[overdue, "overdue-hiker"], [missingChild, "missing-child"], [load(despondent), "despondent"], [load(dementia), "dementia"], [load(hiker), "x"]] as const) {
      const { list } = playAgentLine(full, seed);
      for (const i of list) {
        expect(i.prompt).toMatch(/^[A-Z][a-z]+\b/);
        expect(i.prompt).toMatch(/(\b[A-Z1-4]|M)\.$/);
        for (const s of [i.prompt, i.lead, i.agentSays ?? "", ...i.options.map((o) => `${o.label} ${o.effect}`)]) {
          expect(s).not.toMatch(STORY_BANNED);
          expect(s).not.toMatch(/\b(I|me|my|I'm)\b/);
          expect(s).not.toMatch(/\bclear(ed|s|ing)?\b|rule out/i);
        }
      }
    }
  });
});

describe("the step gate: the clock does not pass a decision until it is made", () => {
  it("holds at the survey, then runs to triage once the survey is approved", () => {
    const choices: Choice[] = [];
    const input = (): GuideInput => ({ full: overdue, seed: "overdue-hiker", user: [], choices, queue });
    let clock = new Date("2026-10-24T20:30:00Z").getTime();
    const hold = () => {
      const a = activeInject(injects(input()), choices);
      return a ? realOf(a.at, costsOf(choices)) : null;
    };
    for (let k = 0; k < 100; k++) clock = guideStep(clock, hold(), 1000);
    const survey = injects(input())[0]!;
    expect(clock).toBe(survey.at);
    // a pending decision: a minute of steps changes nothing
    for (let k = 0; k < 60; k++) clock = guideStep(clock, hold(), 1000);
    expect(clock).toBe(survey.at);
    choices.push(choiceFor(survey, "serpentine", survey.at));
    for (let k = 0; k < 400; k++) clock = guideStep(clock, hold(), 1000);
    const triage = injects(input()).find((i) => i.id === "triage")!;
    // the serpentine costs 12 minutes: triage comes 12 minutes later on the mission clock
    expect(clock).toBe(triage.at + 12 * 60_000);
    expect(fixtureOf(clock, costsOf(choices))).toBe(triage.at);
  });

  it("maps the mission clock and the fixtures' clock both ways through a cost", () => {
    const costs = [{ f: 1000, ms: 500 }];
    expect(fixtureOf(900, costs)).toBe(900);
    expect(fixtureOf(1200, costs)).toBe(1000);
    expect(fixtureOf(1600, costs)).toBe(1100);
    expect(realOf(1100, costs)).toBe(1600);
  });
});

describe("the consequence model", () => {
  const subject = subjectOf(overdue)!;
  const p = storyProposal(overdue)!;
  const t0 = new Date(p.created_at).getTime();

  it("finds the subject only in the subject's sector, with a seeded draw against POD", () => {
    const wrong = passesFrom("overdue-hiker", subject, [assignEv("T1", "B3", t0)]);
    expect(wrong[0]!.detected).toBe(false);
    const right = passesFrom("overdue-hiker", subject, [assignEv("T1", subject.sector, t0)]);
    expect(right[0]!.detected).toBe(right[0]!.draw < TEAM_POD);
    // the same choices always give the same draws
    expect(passesFrom("overdue-hiker", subject, [assignEv("T1", subject.sector, t0)])[0]!.draw).toBe(right[0]!.draw);
  });

  it("marks a wrong sector searched at its POD, and the agent proposes its next pick for that team", () => {
    const user = [assignEv("T2", "B3", t0)];
    const pass = passesFrom("seed", subject, user)[0]!;
    const before = demoAt(overdue, iso(pass.end - 1000), user, { seed: "seed" });
    expect(before.tasks!.find((t) => t.sector_id === "B3")!.state).toBe("in_progress");
    const after = demoAt(overdue, iso(pass.end + 1000), user, { seed: "seed" });
    expect(after.tasks!.find((t) => t.sector_id === "B3")).toMatchObject({ state: "searched", pod: TEAM_POD });
    const next = after.proposals!.find((x) => x.id.startsWith("g"))!;
    expect(next).toMatchObject({ status: "pending", target: { team: "T2" } });
    expect(next.target.sector).not.toBe("B3");
    expect(after.timeline!.some((e) => /B|Bravo Three searched, no sign/.test(e.text))).toBe(true);
    expect(after.mission!.status).not.toBe("found");
    // another assignment waits for the manager at the pass's end
    const list = injects({ full: overdue, seed: "seed", user, choices: [], queue });
    expect(list.some((i) => i.key === "assign-2" && i.at === pass.end)).toBe(true);
  });

  it("never shows the fixture's find: Found only when the manager marks it", () => {
    const end = new Date(overdue.now).getTime() + 3600_000;
    expect(demoAt(overdue, iso(end), [], { seed: "s" }).mission!.found).toBeNull();
    const user = [assignEv("T1", subject.sector, t0)];
    const pass = passesFrom("overdue-hiker", subject, user)[0]!;
    if (pass.detected) {
      const s = demoAt(overdue, iso(pass.end + 1000), user, { seed: "overdue-hiker" });
      expect(s.mission!.found).toBeNull();
      expect(s.timeline!.some((e) => /Subject located/.test(e.text))).toBe(true);
    }
  });

  it("holds the read-back clue's map update until it is confirmed, and never when it is only logged", () => {
    const clueUpdate = (overdue.data.mapUpdates ?? []).find((u) => u.source === "clue" && u.ref === "c004")!;
    const at = iso(t0);
    expect(demoAt(overdue, at, [], { seed: "s", readback: "c004", mapClue: false }).mapUpdates).not.toContain(clueUpdate);
    expect(demoAt(overdue, at, [], { seed: "s", readback: "c004", mapClue: true }).mapUpdates).toContain(clueUpdate);
    expect(demoAt(overdue, at, [], { seed: "s", readback: "c004" }).clues!.find((c) => c.id === "c004")!.confirmed).toBe(false);
  });

  it("prints the fixtures' times on the mission clock after a cost", () => {
    const s = demoAt(overdue, iso(t0), [], { seed: "s" });
    const shifted = onMissionClock(s, [{ f: new Date("2026-10-24T20:35:00Z").getTime(), ms: 12 * 60_000 }]);
    const c = s.clues!.find((x) => x.id === "c004")!;
    expect(new Date(shifted.clues!.find((x) => x.id === "c004")!.at).getTime() - new Date(c.at).getTime()).toBe(12 * 60_000);
  });
});

describe("watch instead: the agent's line through the same engine", () => {
  for (const [name, full, seed] of [["the overdue hiker", overdue, "overdue-hiker"], ["the missing child", missingChild, "missing-child"]] as const) {
    it(`plays every decision on ${name} and ends with the find, matching the agent's baseline`, () => {
      const { choices, user, list } = playAgentLine(full, seed);
      expect(choices.every((c) => c.agent)).toBe(true);
      expect(list.at(-1)!.id).toBe("find");
      const wash = hotWash({ full, seed, user, choices, queue }, list);
      expect(wash.outcome.foundAt).not.toBeNull();
      expect(wash.outcome.foundAt).toBe(wash.agent.foundAt);
      expect(wash.rows.every((r) => r.same)).toBe(true);
      expect(wash.draws.length).toBeGreaterThan(0);
      // five to seven decisions, each one of the strip's names
      const ids = [...new Set(list.map((i) => i.id))];
      expect(ids.every((x) => PIPS.some((p) => p.id === x))).toBe(true);
      expect(ids.length).toBeGreaterThanOrEqual(4);
      expect(ids.length).toBeLessThanOrEqual(7);
      // no score, no claims
      for (const l of [...wash.lines, ...wash.strengths, ...wash.tryNext]) expect(l).not.toMatch(/score|saved a life|AI found|clear/i);
    });
  }

  it("says where a different first assignment diverged, and how the two lines compare", () => {
    const seed = "overdue-hiker";
    const subject = subjectOf(overdue)!;
    const p = storyProposal(overdue)!;
    const choices: Choice[] = [];
    const user: MissionEvent[] = [];
    let list = injects({ full: overdue, seed, user, choices, queue });
    for (const i of list.filter((x) => x.id !== "assign" && x.id !== "link")) {
      if (i.id === "triage") for (const card of i.cards!) choices.push(choiceFor(i, card.line, i.at, card));
      else choices.push(choiceFor(i, agentOption(i).id, i.at));
    }
    const a = list.find((i) => i.id === "assign")!;
    const other = [...poaOf(overdue).keys()].find((s) => s !== subject.sector && s !== p.target.sector)!;
    user.push(assignEv("T2", other, a.at));
    choices.push({ ...choiceFor(a, "map", a.at), label: `Team Two to ${other}` });
    list = injects({ full: overdue, seed, user, choices, queue });
    const wash = hotWash({ full: overdue, seed, user, choices, queue }, list);
    expect(wash.lines[0]).toContain(`you sent Team Two to ${other}; the subject was in ${subject.sector}`);
    expect(agentLine(seed, subject, { team: p.target.team!, sector: p.target.sector!, at: a.at }, poaOf(overdue), Infinity).found).not.toBeNull();
  });
});
