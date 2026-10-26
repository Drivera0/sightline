import { describe, expect, it } from "vitest";
import type { MapUpdate, MissionEvent } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import child from "./__fixtures__/scenarios/missing-child.json";
import despondent from "./__fixtures__/scenarios/despondent.json";
import dementia from "./__fixtures__/scenarios/dementia.json";
import hiker from "./__fixtures__/scenarios/overdue-hiker.json";
import { SECOND_LOOK_ID } from "./demoReview";
import { activeInject, agentOption, choiceFor, choiceFromConsole, costsOf, currentCard, hotWash, injects, lastLight, PIPS, searchEnd, sendAllLabel, STANDING_NOTE, standingUser, type Choice, type GuideInput, type Inject } from "./guide";
import { demoAt, onMissionClock, poaOf, subjectOf, type DemoFull } from "./missionTime";
import { guidedOptsFor } from "./GuideRun";
import { buildTimeline } from "./timeline";
import { sectorAt } from "./console";
import { shiftTimes } from "./scenarios";
import { agentLine, fixtureOf, passesFrom, realOf, TEAM_POD } from "./sim";
import { dwellAt, dwellFor, LAPSE, lapseBeats, lapseRate, lapseSeconds, lapseStep, rowShape } from "./story";
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
function playAgentLine(full: DemoFull, seed: string, pick?: (i: Inject) => string | null): { choices: Choice[]; user: MissionEvent[]; list: Inject[] } {
  const choices: Choice[] = [];
  const mine: MissionEvent[] = [];
  for (let guard = 0; guard < 80; guard++) {
    const user = standingUser(full, seed, mine, choices);
    const input: GuideInput = { full, seed, user, choices, queue };
    const list = injects(input);
    const i = activeInject(list, choices);
    if (!i) return { choices, user, list };
    const card = currentCard(i, choices);
    const ag = agentOption(i, card);
    const own = card ? null : (pick?.(i) ?? null);
    choices.push(choiceFor(i, own && i.options.some((o) => o.id === own) ? own : ag.id, i.at, card, !own));
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

  it("writes every prompt verb first, with no key letters inside the sentence, without first person or the banned words", () => {
    for (const [full, seed] of [[overdue, "overdue-hiker"], [missingChild, "missing-child"], [load(despondent), "despondent"], [load(dementia), "dementia"], [load(hiker), "x"]] as const) {
      const { list } = playAgentLine(full, seed);
      for (const i of list) {
        expect(i.prompt).toMatch(/^[A-Z][a-z]+\b/);
        // the keys are on the option buttons, never inside the sentence (usability test 2026-10-25)
        expect(i.prompt).not.toMatch(/ (?:[A-Z]|[1-4])(?=[,.;)]|$)/);
        // a sentence, with no key letters inside it (the keys are badges on the buttons, desktop only)
        expect(i.prompt).toMatch(/[.?]$/);
        for (const s of [i.prompt, i.lead, i.agentSays ?? "", ...i.options.map((o) => `${o.label} ${o.effect}`)]) {
          expect(s).not.toMatch(STORY_BANNED);
          expect(s).not.toMatch(/\b(I|me|my|I'm)\b/);
          expect(s).not.toMatch(/\bclear(ed|s|ing)?\b|rule out/i);
        }
      }
    }
  });
});

describe("every choice path reaches the find within the run (the cold test's endless loop)", () => {
  const scenarios = [[overdue, "overdue-hiker"], [missingChild, "missing-child"], [load(despondent), "despondent"], [load(dementia), "dementia"], [load(hiker), "x"]] as const;
  const policies: [string, (i: Inject) => string | null][] = [
    ["send all at the first step", () => null],
    ["send only that team, every time", (i) => (i.id === "assign" ? "approve" : null)],
    ["send only at first, then send all", (i) => (i.key === "assign" ? "approve" : null)],
    ["the serpentine, a bearing, only that team each time", (i) => (i.id === "survey" ? "serpentine" : i.id === "clue" ? "bearing" : i.id === "assign" ? "approve" : null)],
    ["log the clue unmapped, then only that team", (i) => (i.id === "clue" ? "log" : i.id === "assign" ? "approve" : null)],
  ];
  for (const [full, seed] of scenarios)
    for (const [name, pick] of policies)
      it(`${seed}: ${name}`, () => {
        const { list, user, choices } = playAgentLine(full, seed, pick);
        expect(list.at(-1)!.id).toBe("find");
        expect(choices.at(-1)!.inject).toBe("find");
        const found = user.find((e) => e.type === "mission.note" && (e.data as { action?: string }).action === "found")!;
        expect(new Date(found.at).getTime()).toBeLessThan(searchEnd(full));
        // one team at a time can run past last light; from there every free team goes (the fallback)
        if (name.startsWith("send all")) expect(new Date(found.at).getTime()).toBeLessThan(lastLight(full));
      });

  it("approving the sighting first is its own decision: the Assign step still waits with its proposal, and the run reaches the find", () => {
    for (const [full, seed] of scenarios) {
      const choices: Choice[] = [];
      const mine: MissionEvent[] = [];
      let sent = false;
      for (let guard = 0; guard < 80 && !(choices.at(-1)?.inject === "find"); guard++) {
        const user = standingUser(full, seed, mine, choices);
        const input: GuideInput = { full, seed, user, choices, queue };
        const i = activeInject(injects(input), choices)!;
        expect(i).toBeTruthy();
        if (i.key === "assign" && !sent) {
          // a reviewer's Person on a photo in the subject's area, then the AI's "send the nearest team" approved
          const subject = subjectOf(full)!;
          const at = i.at - 60_000;
          mine.push({ id: `u${++seq}`, type: "clue.added", at: iso(at), summary: "sighting", ref: "s-x", data: { id: "s-x", kind: "sighting", text: "person confirmed", lat: subject.lat, lon: subject.lon, radius_m: 10, at: iso(at), at_team_position: false, reliability: "high", reported_by: "command", source: "form", confirmed: true, confirmed_by_turn: null } as never });
          // one proposal per sighting's sector: the scenario's own witness sighting there, if any, is the same one
          const where = sectorAt(full.data.sectors ?? [], subject);
          const p = (demoAt(full, iso(i.at), mine, { seed }).proposals ?? []).find((x) => x.id.startsWith("sight-") && x.target.sector === where)!;
          expect(p.status).toBe("pending");
          mine.push({ id: `u${++seq}`, type: "proposal.decided", at: iso(i.at), summary: "", ref: p.id, data: { ...p, status: "approved", decided_by: "Search manager", decided_at: iso(i.at) } as never });
          mine.push(assignEv(p.target.team!, p.target.sector!, i.at));
          sent = true;
          // not this step's decision: the step and its proposal are still there
          const after = standingUser(full, seed, mine, choices);
          expect(choiceFromConsole(i, { full, seed, user: after, choices, queue }, {}, i.at)).toBeNull();
          expect(activeInject(injects({ full, seed, user: after, choices, queue }), choices)!.key).toBe("assign");
          expect((demoAt(full, iso(i.at), after, { seed }).proposals ?? []).find((x) => x.id === i.proposal)?.status).toBe("pending");
          continue;
        }
        const card = currentCard(i, choices);
        choices.push(choiceFor(i, agentOption(i, card).id, i.at, card, true));
        if (i.id === "assign") {
          const target = i.key === "assign" ? storyProposal(full)!.target : (demoAt(full, iso(i.at + 1000), user, { seed }).proposals ?? []).find((x) => x.id === i.proposal)?.target;
          if (target?.team && target.sector) mine.push(assignEv(target.team, target.sector, i.at));
        }
        if (i.id === "find" && i.find) mine.push(foundEv(i.find.team, i.find.sector, i.at));
      }
      expect(sent).toBe(true);
      expect(choices.at(-1)!.inject).toBe("find");
    }
  });

  it("offers one primary at the assign step, the same words as the card, and 'send only' second", () => {
    const list = injects({ full: overdue, seed: "overdue-hiker", user: [], choices: [], queue });
    const a = list.find((i) => i.key === "assign")!;
    const p = storyProposal(overdue)!;
    const team = overdue.data.teams!.find((t) => t.id === p.target.team)!.callsign;
    // only the free teams are "free": Teams One and Two are walking back from the hasty search (the cold test: 4 for 2)
    // Send all says up front that it is a standing approval for the picks after it (the cold test)
    expect(a.options[0]).toMatchObject({ id: "all", agent: true, label: `${sendAllLabel(2, team, p.target.sector!, { returning: 2 })}${STANDING_NOTE}` });
    expect(a.options[0]!.label).toBe("Send the 2 free teams and the 2 returning ones to the AI's picks now, and keep sending free teams to the AI's picks until you change it");
    expect(sendAllLabel(4, team, "C2")).toBe("Send all 4 free teams to the AI's picks");
    expect(a.options[1]).toMatchObject({ id: "approve", label: `Send only ${team} to ${p.target.sector}` });
    expect(a.options.filter((o) => o.agent)).toHaveLength(1);
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
    // a second of real time on, toward the hold (no rows on the way here)
    let run: { from: number; hold: number } | null = null;
    const guideStep = (c: number, h: number | null, dt: number) => {
      if (h === null) return c;
      if (!run || run.hold !== h) run = { from: c, hold: h };
      return lapseStep(c, { ...run, beats: [] }, dt).clock;
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

  it("plays the time between two decisions slowly, one beat at a time (15 to 25 s at 1x, a mission minute never under 0.25 s)", () => {
    const min = 60_000;
    const run = (l: { from: number; hold: number; beats: number[] }) => lapseSeconds(l);
    // 13:35 to 14:31 with eight beats: 14 s of travel (0.25 s a minute) and 9.6 s of beats
    const first = { from: 0, hold: 56 * min, beats: Array.from({ length: 8 }, (_, i) => (i + 1) * 6 * min) };
    expect(run(first)).toBeCloseTo(56 * LAPSE.secPerMin + 8 * LAPSE.beatMs / 1000);
    expect(run(first)).toBeGreaterThanOrEqual(LAPSE.minS);
    expect(run(first)).toBeLessThanOrEqual(LAPSE.maxS);
    // a 14-minute stretch with three beats still takes 15 s; a 2-minute one travels at 1 s a minute
    expect(run({ from: 0, hold: 14 * min, beats: [2 * min, 5 * min, 9 * min] })).toBeCloseTo(LAPSE.minS);
    expect(run({ from: 0, hold: 2 * min, beats: [] })).toBeCloseTo(2 * LAPSE.maxSecPerMin);
    // never faster than 4 mission minutes a second, however long the stretch
    for (const span of [9, 31, 56, 3 * 60]) expect(lapseRate({ from: 0, hold: span * min, beats: [] }) * 1000).toBeLessThanOrEqual(min / LAPSE.secPerMin + 1e-6);
    const l = { from: 0, hold: 20 * min, beats: [5 * min, 12 * min] };
    let c = 0;
    const stops: number[] = [];
    for (let k = 0; k < 400 && c < l.hold; k++) {
      const r = lapseStep(c, l, 100);
      if (r.beat) stops.push(r.clock);
      expect(r.clock).toBeLessThanOrEqual(l.hold);
      c = r.clock;
    }
    expect(stops).toEqual(l.beats);
    expect(c).toBe(l.hold);
    // faster at 4x (the beats shorter by the square root); reduced motion: beat to beat, no travel between
    expect(lapseStep(0, l, 100, 4).clock).toBeCloseTo(4 * lapseStep(0, l, 100).clock);
    expect(dwellAt(l, 4)).toBeCloseTo(dwellFor(l) / 2);
    expect(lapseStep(0, l, 100, 1, true)).toEqual({ clock: 5 * min, beat: true });
    expect(lapseStep(5 * min, l, 100, 1, true)).toEqual({ clock: 12 * min, beat: true });
    expect(lapseStep(12 * min, l, 100, 1, true)).toEqual({ clock: l.hold, beat: false });
    // each beat 1 to 1.5 s: 1.2 s, down to 1 s when there are many
    expect(dwellFor({ beats: [1, 2] })).toBe(LAPSE.beatMs);
    expect(dwellFor({ beats: Array.from({ length: 30 }, (_, i) => i) })).toBe(LAPSE.beatMinMs);
  });

  it("groups rows alike landing together into one beat, and gives rows at the same time a beat each", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 9, 24, h, m);
    const beats = lapseBeats([
      { at: at(21, 50), text: "Drone 3: flight line approved", team: null, sector: "B1" },
      { at: at(21, 50), text: "Drone 2: flight line approved", team: null, sector: "B3" },
      { at: at(21, 50), text: "Drone 1: flight line approved", team: null, sector: "B2" },
      { at: at(21, 50), text: "Drone 1 · flight line over B2 started", sector: "B2" },
      { at: at(21, 58), text: "Sightline, Team Four. Bravo Three searched, no sign of the subject, over.", team: "T4" },
      { at: at(21, 58), text: "Sightline, Team Three. Bravo Two searched, no sign of the subject, over.", team: "T3" },
      { at: at(22, 5), text: "Sightline, Team Two. Charlie Three searched, no sign of the subject, over.", team: "T2" },
    ]);
    expect(beats.map((b) => b.text)).toEqual([
      "Drone 3: flight line approved · 3 drones",
      "Drone 1 · flight line over B2 started",
      "Sightline, Team Four. Bravo Three searched, no sign of the subject, over. · 2 teams",
      "Sightline, Team Two. Charlie Three searched, no sign of the subject, over.",
    ]);
    expect(beats[0]!.sectors).toEqual(["B1", "B3", "B2"]);
    expect(beats[2]!.teams).toEqual(["T4", "T3"]);
    // strictly increasing, so the clock stops on each: the second beat at 21:50 lands a millisecond on
    expect(beats[1]!.at).toBe(at(21, 50) + 1);
    expect(beats[1]!.shown).toBe(at(21, 50));
    expect(rowShape("Team One: position report")).toBe(rowShape("Team Two: position report"));
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

describe("no drone or team moves before a person approves it (the cold test, 2026-10-26)", () => {
  const call = Date.parse("2026-10-24T20:35:00Z");
  const survey = (option: string, f = call): Choice => ({ key: "survey", inject: "survey", option, label: option, agentLabel: "", agent: option === "planner", f, costMs: option === "serpentine" ? 12 * 60_000 : 0 });
  const at = (choices: Choice[], t: string, free = false) => {
    const costs = costsOf(choices);
    return onMissionClock(demoAt(overdue, iso(fixtureOf(Date.parse(t), costs)), [], guidedOptsFor(overdue, "overdue-hiker", choices, [], free)), costs) as MissionData;
  };
  const lineRows = (s: MissionData) => [...s.events.filter((e) => e.type === "fleet.updated").map((e) => e.summary), ...s.timeline.filter((e) => e.kind === "drone").map((e) => e.text)].filter((x) => /^L\d+ approved|flight line approved/.test(x));

  it("the lawnmower pattern flies its own lines only: no later flight line credited to it (15:04 'you chose the lawnmower pattern')", () => {
    const s = at([survey("serpentine")], "2026-10-24T22:20:00Z");
    expect(lineRows(s)).toEqual([]);
    expect(s.fleet?.legs ?? []).toEqual([]);
    expect(s.timeline.some((e) => /auto-approved: guided survey/.test(e.text))).toBe(false);
    // and no lost link on a line it never flew
    expect(injects({ full: overdue, seed: "overdue-hiker", user: [], choices: [survey("serpentine")], queue }).some((i) => i.id === "link")).toBe(false);
    // the AI's flight lines say they include the lines after the survey, and those fly, credited to that choice
    const planner = injects({ full: overdue, seed: "overdue-hiker", user: [], choices: [], queue }).find((i) => i.id === "survey")!.options.find((o) => o.id === "planner")!;
    expect(planner.effect).toMatch(/once the photos are in, flight lines over B2, B3, B1 and C3|once the photos are in, flight lines over/);
    const p = at([survey("planner")], "2026-10-24T22:00:00Z");
    expect(lineRows(p).length).toBeGreaterThan(0);
    for (const x of p.events.filter((e) => e.type === "fleet.updated" && /^L\d+ approved/.test(e.summary))) expect(x.summary).toMatch(/approved with the survey you chose: the AI's flight lines/);
  });

  it("free play: before the survey is approved the drones wait at base camp and the AI's survey waits in Needs you; approved late, it flies from then", () => {
    const s = at([], "2026-10-24T21:30:00Z", true);
    expect(s.fleet!.drones.length).toBeGreaterThan(0);
    expect(s.fleet!.drones.every((d) => d.status !== "flying")).toBe(true);
    expect(s.mapUpdates.filter((u) => u.source === "frame")).toEqual([]);
    expect(s.proposals.find((p) => p.id === "fly-survey")).toMatchObject({ status: "pending", summary: "Fly the survey: the AI's flight lines, or the lawnmower pattern?" });
    // approved at 14:00 (25 min after the call): nothing in the air at the scenario's own 13:50, flying at 14:15
    const late = [survey("planner", call + 25 * 60_000)];
    expect(at(late, "2026-10-24T21:00:00Z", true).fleet!.drones.every((d) => d.status !== "flying")).toBe(true);
    expect(at(late, "2026-10-24T21:15:00Z", true).fleet!.drones.some((d) => d.status === "flying")).toBe(true);
    expect(at(late, "2026-10-24T21:15:00Z", true).proposals.some((p) => p.id === "fly-survey")).toBe(false);
  });

  it("the guided run: every clue the scenario brings waits for the visitor's confirmation, and the map with it", () => {
    const s = at([survey("planner")], "2026-10-24T21:41:00Z");
    expect(s.clues.map((c) => [c.id, c.confirmed])).toEqual([["c001", false], ["c002", false], ["c003", false], ["c004", false]]);
    expect(s.mapUpdates.filter((u) => u.source === "clue")).toEqual([]);
    const lines = buildTimeline(s.events, s.teams, s.timeline).filter((e) => e.kind === "clue");
    expect(lines.length).toBe(4);
    for (const e of lines) expect(e.detail).toMatch(/awaiting read-back/);
    // the AI's reason no longer says the unconfirmed clues raised C2
    const p = s.proposals.find((x) => x.id === "p002");
    expect(p?.reason ?? "").not.toMatch(/raised it/);
  });

  it("Send all is a standing approval said up front; after Stop sending the AI asks again for the next team", () => {
    const user: MissionEvent[] = [];
    const p = storyProposal(overdue)!;
    const all = choiceFor(injects({ full: overdue, seed: "overdue-hiker", user, choices: [], queue }).find((i) => i.key === "assign")!, "all", Date.parse(p.created_at));
    expect(all.label).toMatch(/, and keep sending free teams to the AI's picks until you change it$/);
    const sent = standingUser(overdue, "overdue-hiker", user, [all]);
    const asked = (u: MissionEvent[]) => injects({ full: overdue, seed: "overdue-hiker", user: standingUser(overdue, "overdue-hiker", u, [all]), choices: [all], queue }).filter((i) => i.key.startsWith("assign-"));
    // while it stands nothing is asked; stopped, the next team's pass that ends asks again
    expect(asked(user)).toEqual([]);
    const stop: MissionEvent = { id: "stop", type: "mission.note", at: iso(Date.parse(p.created_at) + 60_000), summary: "Standing approval stopped", ref: null, data: { action: "standing_stop" } as never };
    expect(asked([stop]).length).toBeGreaterThan(0);
    // no team goes on the AI's pick by itself between the stop and last light (the night search is the guided search's own rule)
    const autos = (u: MissionEvent[]) => u.filter((e) => e.id.startsWith("auto-") && Date.parse(e.at) > Date.parse(stop.at) && Date.parse(e.at) < lastLight(overdue));
    expect(autos(sent).length).toBeGreaterThan(0);
    expect(autos(standingUser(overdue, "overdue-hiker", [stop], [all]))).toEqual([]);
  });
});
