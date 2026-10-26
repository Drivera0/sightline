// Usability test round 2, problems 4, 5 and 10: the AI's photo pick against each scenario's subject, the
// drones on the ground when the conditions at the call ground them, daylight in every scenario, and the
// leftover strings. Built by lane A.
import { describe, expect, it } from "vitest";
import type { Conditions, MapUpdate, MissionEvent } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import child from "./__fixtures__/scenarios/missing-child.json";
import despondent from "./__fixtures__/scenarios/despondent.json";
import dementia from "./__fixtures__/scenarios/dementia.json";
import { SECOND_LOOK_ID } from "./demoReview";
import { activeInject, agentOption, choiceFor, currentCard, dronesWait, hotWash, injects, photoTitle, standingUser, type Choice, type GuideInput, type Inject } from "./guide";
import { CHECKPOINTS, conditionsAt, demoAt, isFoundEvent, type DemoFull } from "./missionTime";
import { presetFor, shiftTimes, withSunTimes } from "./scenarios";
import { STORY_NOT_A_PERSON, storyProposal } from "./storyCopy";
import { aiPick, subjectLook } from "./subjectMatch";
import { buildTimeline } from "./timeline";
import { BANNED, plainWords } from "./terms";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[]; t0?: string };
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f${String(k + 1).padStart(4, "0")}`, cells: [], canopy: null, at: "2026-10-24T20:50:00Z" }));
function load(raw: unknown): DemoFull {
  const fx0 = raw as Fixture;
  const from = fx0.t0 ?? fx0.mission?.created_at;
  const to = (demo as unknown as Fixture).mission!.created_at;
  const fx = from && to ? shiftTimes(fx0, new Date(to).getTime() - new Date(from).getTime()) : fx0;
  return withSunTimes({ now: fx.now, data: { ...fx, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] } });
}
const overdue = load(demo);
const scenarios = { "overdue-hiker": overdue, "missing-child": load(child), despondent: load(despondent), dementia: load(dementia) } as const;
const queue = [
  { id: "f0336-d01", conf: 0.82 },
  { id: SECOND_LOOK_ID, conf: 0.17 },
  { id: STORY_NOT_A_PERSON, conf: 0.47 },
];
const call = new Date(CHECKPOINTS[0]!.at).getTime();
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

describe("the AI's photo pick matches the subject (problem 4)", () => {
  const subjectOf = (seed: keyof typeof scenarios) => scenarios[seed].data.mission!.subject;
  const SHUFFLES = ["s1", "s2", "s3", "s4", "s5", "s6"].map((s) => presetFor(s).subject);

  it("reads the subject's age and clothing from the description", () => {
    expect(subjectLook("child, 8, missing from a family picnic, yellow raincoat")).toMatchObject({ age: "child", years: 8, colours: ["yellow"], wear: "yellow raincoat" });
    expect(subjectLook("older adult with dementia, walked away, slippers")).toMatchObject({ age: "older", indoor: true });
    expect(subjectLook("despondent adult, left a note, grey jacket")).toMatchObject({ age: "adult", colours: ["grey"] });
  });

  it("only the overdue hiker's red-jacket adult is the subject; in every other scenario the same photo is another person", () => {
    expect(aiPick("f0336-d01", subjectOf("overdue-hiker"))).toEqual({ answer: "person", line: "AI: likely the subject — red jacket matches" });
    expect(aiPick("f0336-d01", subjectOf("missing-child"))).toEqual({ answer: "not_subject", line: "AI: another person — an adult in a red jacket; the subject is a child of 8 in a yellow raincoat" });
    expect(aiPick("f0336-d01", subjectOf("despondent"))?.answer).toBe("not_subject");
    expect(aiPick("f0336-d01", subjectOf("dementia"))?.answer).toBe("not_subject");
    for (const s of SHUFFLES) expect(aiPick("f0336-d01", s)?.answer, s).toBe("not_subject");
    // the bag is never a person; a photo with no description has no pick
    for (const s of [...Object.keys(scenarios).map((k) => subjectOf(k as keyof typeof scenarios)), ...SHUFFLES]) expect(aiPick(STORY_NOT_A_PERSON, s)?.answer).toBe("not_person");
    expect(aiPick("f0999-d01", subjectOf("overdue-hiker"))).toBeNull();
  });

  it("the review step's cards say the pick in one line, and Watch instead answers it, in all five scenarios", () => {
    const cases: [string, DemoFull, string[]][] = [
      ["overdue-hiker", scenarios["overdue-hiker"], ["person", "person", "not_person"]],
      ["missing-child", scenarios["missing-child"], ["not_subject", "not_subject", "not_person"]],
      ["despondent", scenarios.despondent, ["not_subject", "not_subject", "not_person"]],
      ["dementia", scenarios.dementia, ["not_subject", "not_subject", "not_person"]],
      ["shuffle", { ...overdue, data: { ...overdue.data, mission: { ...overdue.data.mission!, subject: presetFor("s1").subject } } }, ["not_subject", "not_subject", "not_person"]],
    ];
    for (const [seed, full, want] of cases) {
      const input: GuideInput = { full, seed, user: [], choices: [], queue };
      const triage = injects(input).find((i) => i.id === "triage")!;
      const byId = Object.fromEntries(triage.cards!.map((c) => [c.id, c]));
      expect([byId["f0336-d01"]!.line, byId[SECOND_LOOK_ID]!.line, byId[STORY_NOT_A_PERSON]!.line], seed).toEqual(want);
      for (const c of triage.cards!) {
        expect(c.says, seed).toMatch(/^AI: (likely the subject|another person|other people|not a person) — /);
        expect(c.says).not.toMatch(/Detector score/);
      }
    }
  });

  it("the end screen scores against the picks shown, names photos by number, and never says the subject for the child's red-jacket adult", () => {
    const full = scenarios["missing-child"];
    const list = injects({ full, seed: "missing-child", user: [], choices: [], queue });
    const triage = list.find((i) => i.id === "triage")!;
    const first = triage.cards![0]!;
    const choice = choiceFor(triage, "person", triage.at, first);
    expect(choice.agent).toBe(false);
    expect(choice.label).toBe(`${photoTitle(triage, first.id)}: The subject`);
    expect(choice.label).toMatch(/^Photo 1 \(survey photo 336\): The subject$/);
    expect(choice.agentLabel).toBe("Photo 1 (survey photo 336): Another person");
    const agreed = triage.cards!.map((c) => choiceFor(triage, c.line, triage.at, c));
    expect(agreed.every((c) => c.agent)).toBe(true);
    const wash = hotWash({ full, seed: "missing-child", user: [], choices: [choice], queue }, list);
    expect(wash.tryNext.join(" ")).toMatch(/Compare photo 1 \(survey photo 336\) with the subject's description/);
    expect(wash.tryNext.join(" ")).not.toMatch(/grey bag/);
  });
});

/** The overdue hiker with the wind over the drones' limit from the call. */
function groundedAtTheCall(): DemoFull {
  const g = (c: Conditions): Conditions => ({ ...c, gust_kmh: 52, flyable: false, flyable_until: null, flyability_reason: "gusts 52 km/h at or above the drones' limit of 43 km/h" });
  const d = overdue.data;
  return { ...overdue, data: { ...d, conditions: g(d.conditions!), events: (d.events ?? []).map((e) => (e.type === "conditions.updated" && e.data ? { ...e, data: g(e.data as unknown as Conditions) as never } : e)) } };
}

function play(full: DemoFull, seed: string, pick: (i: Inject) => string | null = () => null): { choices: Choice[]; user: MissionEvent[]; list: Inject[] } {
  const choices: Choice[] = [];
  const mine: MissionEvent[] = [];
  let seq = 0;
  for (let guard = 0; guard < 80; guard++) {
    const user = standingUser(full, seed, mine, choices);
    const list = injects({ full, seed, user, choices, queue });
    const i = activeInject(list, choices);
    if (!i) return { choices, user, list };
    const card = currentCard(i, choices);
    const own = card ? null : pick(i);
    choices.push(choiceFor(i, own ?? agentOption(i, card).id, i.at, card));
    const p = i.key === "assign" ? storyProposal(full) : null;
    if (p?.target.team && p.target.sector) mine.push({ id: `u${++seq}`, type: "task.updated", at: iso(i.at), summary: "assigned", ref: p.target.sector, data: { sector_id: p.target.sector, state: "assigned", team_id: p.target.team, poa: 0, pod: null, note: null, updated_at: iso(i.at) } as never });
    if (i.id === "find" && i.find) mine.push({ id: `u${++seq}`, type: "mission.note", at: iso(i.at), summary: "Found", ref: i.find.sector, data: { action: "found", mission: { ...full.data.mission, status: "found", found: { ...i.find, lat: 0, lon: 0, at: iso(i.at) } } } as never });
  }
  throw new Error("the run did not end");
}

describe("grounded drones (problem 5)", () => {
  it("the scenarios' gusts come when they came, not from the call: every scenario can fly at the call and has daylight", () => {
    for (const [seed, full] of Object.entries(scenarios)) {
      const atCall = conditionsAt(full.data, call)!;
      expect(atCall.flyable, seed).toBe(true);
      expect(atCall.civil_twilight_end, seed).toBe("2026-10-25T01:36:46Z"); // the day's, never moved with the fixture
      const atEnd = conditionsAt(full.data, Infinity)!;
      expect(atEnd.civil_twilight_end, seed).toBe("2026-10-25T01:36:46Z");
      expect(dronesWait(full, []), seed).toBeNull();
      const survey = injects({ full, seed, user: [], choices: [], queue }).find((i) => i.id === "survey")!;
      expect(survey.prompt).toMatch(/^Launch the survey/);
    }
    // the missing child's gusts at 52 km/h arrive late in the run, as its fixture has them
    const late = conditionsAt(scenarios["missing-child"].data, Infinity)!;
    expect(late.flyable).toBe(false);
    expect(late.gust_kmh).toBe(52);
  });

  it("grounded at the call, step 1 offers ground teams first or an explicit override, never 'Launch the survey'", () => {
    const full = groundedAtTheCall();
    const survey = injects({ full, seed: "g", user: [], choices: [], queue }).find((i) => i.id === "survey")!;
    expect(survey.prompt).not.toMatch(/Launch the survey/);
    expect(survey.options.map((o) => o.label)).toEqual(["Ground teams first; drones wait for the wind (re-check at 14:05)", "Fly anyway (override, logged)"]);
    expect(survey.options.find((o) => o.agent)!.id).toBe("wait");
  });

  it("while the drones wait nothing flies: no photo, no review step, no link or wind step, and the run still reaches the find", () => {
    const full = groundedAtTheCall();
    const { list, choices, user } = play(full, "g");
    expect(choices[0]).toMatchObject({ inject: "survey", option: "wait" });
    expect(list.map((i) => i.id)).not.toContain("triage");
    expect(list.map((i) => i.id)).not.toContain("link");
    expect(list.map((i) => i.id)).not.toContain("wind");
    expect(list.at(-1)!.id).toBe("find");
    expect(user.some(isFoundEvent)).toBe(true);
    for (const at of [CHECKPOINTS[1]!.at, CHECKPOINTS[4]!.at]) {
      const s = demoAt(full, at, [], { seed: "g", dronesWait: dronesWait(full, choices) });
      expect(s.fleet!.drones.every((d) => d.status === "idle"), at).toBe(true);
      expect(s.fleet!.legs).toEqual([]);
      expect((s.mapUpdates ?? []).filter((u) => u.source === "frame")).toEqual([]);
      expect(s.conditions!.flyable).toBe(false);
      expect((s.proposals ?? []).some((p) => p.kind === "retask_drone" || p.kind === "drone_leg" || p.kind === "promote_detection")).toBe(false);
    }
    const later = demoAt(full, CHECKPOINTS[2]!.at, [], { seed: "g", dronesWait: dronesWait(full, choices) });
    expect((later.timeline ?? []).find((e) => e.id === "wind-recheck")?.text).toMatch(/^Wind re-checked: gusts 52 km\/h, still over the drones' limit/);
  });

  it("Fly anyway is an override: the survey flies, the review step comes back, and the status names the approver", () => {
    const full = groundedAtTheCall();
    const { choices, list } = play(full, "g", (i) => (i.id === "survey" ? "override" : null));
    expect(choices[0]).toMatchObject({ inject: "survey", option: "override", label: "Fly anyway (override, logged)" });
    expect(dronesWait(full, choices)).toBeNull();
    expect(list.map((i) => i.id)).toContain("triage");
    const note: MissionEvent = { id: "u-o", type: "mission.note", at: iso(call), summary: "Drones fly anyway", ref: null, data: { action: "fly_override", by: "Dana" } as never };
    const s = demoAt(full, CHECKPOINTS[1]!.at, [note], { seed: "g", dronesWait: null });
    expect(s.conditions!.flyability_reason).toMatch(/flying on an override approved by Dana$/);
    expect(s.fleet!.drones.some((d) => d.status !== "idle")).toBe(true);
  });
});

describe("the leftover strings (problem 10)", () => {
  it("the scenario's prior is said plainly, its seed and model kept for the Trace", () => {
    expect(plainWords("Demo scenario: Missing child (seed 2202); placeholder × terrain affinity (Jacobs 2015 ISRID find locations) prior")).toBe("Search area drawn from how lost children usually travel (ISRID)");
    expect(plainWords("mission created: Missing child (demo)")).toBe("Mission opened: Missing child");
    expect(plainWords("Demo scenario: Dementia walk-away (seed 4404); Koester lost-person rings, dementia/temperate_mountainous (n=1207; Koester, LPB Updates, ICAR 2025, p. 15 (ISRID 2.0)), weight 0.8 + uniform × terrain affinity (Jacobs 2015 ISRID find locations) prior")).toBe("Search area drawn from how people with dementia usually travel (ISRID)");
  });

  it("a clue is one timeline row that updates: awaiting read-back, then confirmed", () => {
    const clue = { id: "c004", kind: "sound", text: "possible whistle", lat: 0, lon: 0, radius_m: 200, reported_by: "T2", source: "radio", reliability: "low", confirmed: false, at: "2026-10-24T21:30:00Z" };
    const events: MissionEvent[] = [
      { id: "e1", type: "clue.added", at: "2026-10-24T21:30:00Z", summary: "c004", ref: "c004", data: clue as never },
      { id: "u2", type: "clue.added", at: "2026-10-24T21:31:00Z", summary: "c004 confirmed", ref: "c004", data: { ...clue, confirmed: true } as never },
    ];
    const rows = buildTimeline(events, []).filter((e) => e.kind === "clue");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatch(/confirmed$/);
  });

  it("the banned list holds the round's leftovers", () => {
    const leftovers = ["Survey photo f0336", "Every draw", "Agent's line", "line 1 of 1", "no quote in the trace", "Missing child (seed 2202)", "placeholder × terrain affinity", "Base camp: Base camp", "AI suggests: Detector score 0.82"];
    for (const s of leftovers) expect(BANNED.some((re) => re.test(s)), s).toBe(true);
    for (const ok of ["Survey photo 336", "Drone 1 · flight line 1", "AI: likely the subject — red jacket matches", "Base camp: Trailhead lot"]) expect(BANNED.some((re) => re.test(ok)), ok).toBe(false);
  });
});
