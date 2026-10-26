// Without Sightline vs with Sightline on the guided search's end screen (sim.ts manualLine, compare.ts
// withWithout, GuideEnd.tsx): the manual line is the same engine and seed with a hand split, no detector
// and photos reviewed by eye; every number comes from the stated assumptions. Built by lane A.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MapUpdate, MissionEvent } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import child from "./__fixtures__/scenarios/missing-child.json";
import despondent from "./__fixtures__/scenarios/despondent.json";
import dementia from "./__fixtures__/scenarios/dementia.json";
import { BY_EYE_S, compare, DETECTOR_S, manualOf, manualStart, REVIEWERS, SURVEY_PHOTOS } from "./compare";
import { SECOND_LOOK_ID } from "./demoReview";
import { GuideEnd } from "./GuideEnd";
import { activeInject, agentOption, choiceFor, currentCard, hotWash, injects, lastLight, standingUser, type Choice, type GuideInput, type Inject } from "./guide";
import { CHECKPOINTS, demoAt, subjectOf, type DemoFull } from "./missionTime";
import { shiftTimes, withSunTimes } from "./scenarios";
import { handSplit, LAWNMOWER_MS, lawnmowerOrder, manualLine, pass, SWEEP_MS, WALK_MS } from "./sim";
import { STORY_NOT_A_PERSON, storyProposal } from "./storyCopy";
import { BANNED } from "./terms";

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
// the five scenarios: the four presets and a shuffled seed on the overdue hiker's ground
const SCENARIOS: [string, DemoFull][] = [
  ["overdue-hiker", overdue],
  ["missing-child", load(child)],
  ["despondent", load(despondent)],
  ["dementia", load(dementia)],
  ["s1", overdue],
];
const queue = [
  { id: "f0336-d01", conf: 0.82 },
  { id: SECOND_LOOK_ID, conf: 0.17 },
  { id: STORY_NOT_A_PERSON, conf: 0.47 },
];
const call = new Date(CHECKPOINTS[0]!.at).getTime();
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
let seq = 0;
const assignEv = (team: string, sector: string, at: number): MissionEvent => ({ id: `u${++seq}`, type: "task.updated", at: iso(at), summary: `sector ${sector}: assigned`, ref: sector, data: { sector_id: sector, state: "assigned", team_id: team, poa: 0, pod: null, note: null, updated_at: iso(at) } as never });

/** Play the run: the AI's option except where `pick` says otherwise; each decision takes 4 s. */
function play(full: DemoFull, seed: string, pick: (i: Inject) => string | null = () => null) {
  const choices: Choice[] = [];
  const mine: MissionEvent[] = [];
  for (let guard = 0; guard < 40; guard++) {
    const user = standingUser(full, seed, mine, choices);
    const input: GuideInput = { full, seed, user, choices, queue };
    const list = injects(input);
    const i = activeInject(list, choices);
    if (!i) return compare(input, hotWash(input, list), lastLight(full));
    const card = currentCard(i, choices);
    choices.push({ ...choiceFor(i, pick(i) ?? agentOption(i, card).id, i.at, card), shownAt: 0, decidedAt: 4000 });
    if (i.id === "assign") {
      const p = i.key === "assign" ? storyProposal(full) : null;
      const target = p ? p.target : (demoAt(full, iso(i.at + 1000), user, { seed }).proposals ?? []).find((x) => x.id === i.proposal)?.target;
      if (target?.team && target.sector) mine.push(assignEv(target.team, target.sector, i.at));
    }
    if (i.id === "find" && i.find) mine.push({ id: `u${++seq}`, type: "mission.note", at: iso(i.at), summary: "Found", ref: i.find.sector, data: { action: "found", mission: { ...full.data.mission, status: "found", found: { team: i.find.team, sector: i.find.sector, lat: 0, lon: 0, at: iso(i.at) } } } as never });
  }
  throw new Error("the run did not end");
}
const lawnmower = (i: Inject) => (i.id === "survey" ? "serpentine" : null);

describe("the manual line (sim.ts)", () => {
  it("orders the grid row by row, turning at each row's end, and cuts it in one block per team", () => {
    const ids = ["A1", "B1", "C1", "A2", "B2", "C2"];
    expect(lawnmowerOrder(ids)).toEqual(["A1", "B1", "C1", "C2", "B2", "A2"]);
    expect([...handSplit(ids, ["T1", "T2", "T3"]).values()]).toEqual([["A1", "B1"], ["C1", "C2"], ["B2", "A2"]]);
  });

  it("is the same engine: each team's passes back to back through its block, the same rolls, until the find", () => {
    const subject = { sector: "B2", lat: 0, lon: 0 };
    const sectors = ["A1", "B1", "A2", "B2"];
    const line = manualLine("x", subject, sectors, ["T1", "T2"], 0, 10 * 3600_000);
    const t2 = line.passes.filter((p) => p.team === "T2");
    expect(t2.map((p) => p.sector).slice(0, 4)).toEqual(["B2", "A2", "B2", "A2"].slice(0, t2.length));
    for (const p of line.passes) expect(p).toEqual({ ...pass("x", subject, p.team, p.sector, p.n, p.start), end: p.end });
    expect(t2[1] ? t2[1].start : t2[0]!.end).toBe(t2[0]!.end);
    expect(line.found).toBe(line.passes.find((p) => p.detected)!.end);
  });

  it("says not found by last light when light runs out first", () => {
    const line = manualLine("x", { sector: "B2", lat: 0, lon: 0 }, ["A1", "B1", "A2", "B2"], ["T1"], 0, WALK_MS + SWEEP_MS);
    expect(line.found).toBeNull();
  });
});

describe("without Sightline vs with Sightline, in all five scenarios", () => {
  for (const [seed, full] of SCENARIOS) {
    it(`${seed}: deterministic, from the stated assumptions, the third column only when it differs`, () => {
      const a = play(full, seed);
      const b = play(full, seed);
      expect(a.sightline.columns).toEqual(b.sightline.columns);
      expect(a.sightline.headline).toBe(b.sightline.headline);
      const [man, you, agent] = a.sightline.columns;
      // following the AI: two columns and the note
      expect(a.followedAll).toBe(true);
      expect(agent).toBeUndefined();
      expect(a.sightline.followedNote).toBe("You followed the AI's pick every time, so your search is the AI's: one column for both.");
      // the manual column's numbers are the assumptions'
      expect(man!.title).toBe("Without Sightline (manual)");
      expect(man!.photos).toBe(SURVEY_PHOTOS);
      expect(man!.personMs).toBe((SURVEY_PHOTOS * BY_EYE_S * 1000) / REVIEWERS);
      expect(man!.machineMs).toBeNull();
      expect(you!.machineMs).toBe(SURVEY_PHOTOS * DETECTOR_S * 1000);
      expect(you!.personMs).toBe(4000 * 3);
      expect(you!.photos).toBe(queue.length);
      // the review by eye ends after the manual search, so its photo sightings all reach nobody in time
      expect(man!.missed).toBe(2);
      expect(you!.missed).toBe(0);
      const input = { full, seed, user: [], choices: [], queue };
      const line = manualOf(input, lastLight(full));
      expect(manualStart(input).start).toBe(new Date(storyProposal(full)!.created_at).getTime() + LAWNMOWER_MS);
      expect(man!.findMin).toBe(line.found === null ? null : (line.found - call) / 60_000);
      expect(line.passes.every((p) => p.start >= manualStart(input).start && p.start < lastLight(full))).toBe(true);
      // deviating: the third column appears, and the line without Sightline does not move
      const c = play(full, seed, lawnmower);
      expect(c.sightline.columns.map((x) => x.key)).toEqual(["manual", "you", "agent"]);
      expect(c.sightline.columns[0]).toEqual(man);
      expect(c.sightline.columns[2]!.findMin).toBe(you!.findMin);
      expect(c.sightline.followedNote).toBeNull();
      for (const s of [a.sightline.headline, c.sightline.headline, ...a.sightline.assumptions.map((x) => x.text)]) {
        expect(s).not.toMatch(/\bclear(s|ed)?\b|\b(demo|scripted|recorded|simulated)\b/i);
        for (const re of BANNED) expect(s).not.toMatch(re);
      }
      expect(subjectOf(full)).not.toBeNull();
    });
  }

  it("the overdue hiker: the headline in plain words, following the AI and deviating", () => {
    expect(play(overdue, "overdue-hiker").sightline.headline).toBe("With Sightline the subject was found 1 h 00 min sooner, and a person had 3 photos to look at instead of 500.");
    expect(play(overdue, "overdue-hiker", lawnmower).sightline.headline).toBe("With Sightline the subject was found 48 min sooner, and a person had 3 photos to look at instead of 500.");
  });

  it("says why the minutes matter, from the published study, and this run's hours since last seen", () => {
    const t = play(overdue, "overdue-hiker").sightline.timeMatters!;
    expect(t.text).toMatch(/^Every hour counts\. In 2,302 Oregon searches for 3,287 people, search time was the only thing that predicted whether a person was found alive, and about 99 % of those found alive were found within 51 hours of searching\. Here the subject was found \d+ h \d\d min after they were last seen with Sightline, against \d+ h \d\d min without it\.$/);
    expect(t.href).toBe("https://pubmed.ncbi.nlm.nih.gov/17590071/");
    // no invented per-minute survival rate, no banned words
    expect(t.text).not.toMatch(/% (more|higher|better) (chance|survival)/i);
    expect(t.text).not.toMatch(/\b(demo|scripted|recorded|simulated)\b/i);
    // the search without Sightline found first: the study, but no "against" line
    expect(play(load(dementia), "dementia").sightline.timeMatters!.text).not.toMatch(/against/);
  });

  it("says so when the search without Sightline found the subject first", () => {
    const h = play(load(dementia), "dementia").sightline.headline;
    expect(h).toMatch(/^Without Sightline the subject was found 1 h 08 min sooner this time: the hand split reached A1 early, a sector the map ranked \d+ of 16\./);
  });

  it("states each assumption with a source link", () => {
    const w = play(overdue, "overdue-hiker").sightline;
    const text = w.assumptions.map((a) => a.text).join(" ");
    expect(text).toContain("33 s a photo, 1 reviewer, so 500 photos take 4 h 35 min");
    expect(text).toContain("about 68 % of people are found");
    expect(text).toContain("hand split");
    expect(text).toContain("4.7 s a photo on the deployed server (AWS c7i.2xlarge");
    for (const a of w.assumptions) expect(a.href).toMatch(/^https:\/\/github\.com\/Drivera0\/sightline\/blob\/main\//);
  });
});

describe("the end screen leads with it", () => {
  const noop = () => {};
  const show = (pick?: (i: Inject) => string | null) => {
    const versus = play(overdue, "overdue-hiker", pick);
    const input: GuideInput = { full: overdue, seed: "overdue-hiker", user: [], choices: [], queue };
    const wash = hotWash(input, injects(input));
    return render(<GuideEnd wash={wash} versus={versus} sectors={overdue.data.sectors ?? []} subject={null} scenario="Overdue hiker" seed="overdue-hiker" callsign={(id) => id ?? ""} onReplay={noop} onWatchAgent={noop} onReport={noop} onTrace={noop} onClose={noop} />).container;
  };

  it("hides the third column when you followed the AI, and shows it when you did not", () => {
    const one = show();
    expect([...one.querySelectorAll("[data-column]")].map((x) => x.textContent)).toEqual(["Without Sightline (manual)", "You, with Sightline"]);
    expect(one.querySelector("[data-followed]")!.textContent).toMatch(/^You followed the AI's pick every time/);
    const two = show(lawnmower);
    expect([...two.querySelectorAll("[data-column]")].map((x) => x.textContent)).toEqual(["Without Sightline (manual)", "You, with Sightline", "Following the AI every time"]);
    expect(two.querySelector("[data-followed]")).toBeNull();
    expect(two.querySelector('[data-measure="review"]')!.textContent).toContain("4 h 35 min");
    expect(two.querySelector('[data-measure="photos"]')!.textContent).toContain("500");
    expect(two.querySelector("[data-headline]")!.textContent).toMatch(/^With Sightline the subject was found/);
    // the details render only when opened
    expect(two.querySelector("[data-details]")!.textContent).not.toContain("How each pass went");
    expect(two.textContent).not.toMatch(/\b(demo|scripted|recorded|simulated)\b/i);
  });
});
