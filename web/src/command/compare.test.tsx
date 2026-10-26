// "You vs the agent" on the guided search's end screen (compare.ts, GuideEnd.tsx): the maths, and what it shows.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MapUpdate, MissionEvent } from "../contract";
import { GuideEnd } from "./GuideEnd";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import { compare, fmtDuration, median, sideStats } from "./compare";
import { SECOND_LOOK_ID } from "./demoReview";
import { activeInject, agentOption, choiceFor, currentCard, hotWash, injects, lastLight, standingUser, type Choice, type GuideInput, type Inject } from "./guide";
import { demoAt, type DemoFull } from "./missionTime";
import { pass, type Pass } from "./sim";
import { useGuide } from "./story";
import { STORY_NOT_A_PERSON, storyProposal } from "./storyCopy";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[] };
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({
  seq: k + 1,
  kind: "step",
  source: "frame",
  ref: `f${String(k + 1).padStart(4, "0")}`,
  cells: [],
  canopy: null,
  at: "2026-10-24T20:30:00Z",
}));
const fx = demo as unknown as Fixture;
const full: DemoFull = {
  now: fx.now,
  data: { ...fx, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] },
};
const seed = "overdue-hiker";
const queue = [
  { id: "f0336-d01", conf: 0.82 },
  { id: "f0127-d01", conf: 0.8 },
  { id: SECOND_LOOK_ID, conf: 0.17 },
  { id: STORY_NOT_A_PERSON, conf: 0.47 },
];
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
let seq = 0;
const assignEv = (team: string, sector: string, at: number): MissionEvent => ({
  id: `u${++seq}`,
  type: "task.updated",
  at: iso(at),
  summary: `sector ${sector}: assigned`,
  ref: sector,
  data: {
    sector_id: sector,
    state: "assigned",
    team_id: team,
    poa: 0,
    pod: null,
    note: null,
    updated_at: iso(at),
  } as never,
});
const foundEv = (team: string, sector: string, at: number): MissionEvent => ({
  id: `u${++seq}`,
  type: "mission.note",
  at: iso(at),
  summary: "Found",
  ref: sector,
  data: {
    action: "found",
    mission: {
      ...full.data.mission,
      status: "found",
      found: { team, sector, lat: 0, lon: 0, at: iso(at) },
    },
  } as never,
});

/** Play the run: the agent's option everywhere except where `pick` says otherwise; each decision takes `thinkMs`. */
function play(pick: (i: Inject) => string | null = () => null, thinkMs = 0, watched = false): { input: GuideInput; list: Inject[] } {
  const choices: Choice[] = [];
  const mine: MissionEvent[] = [];
  let wall = 1_000_000;
  for (let guard = 0; guard < 40; guard++) {
    const user = standingUser(full, seed, mine, choices);
    const input: GuideInput = { full, seed, user, choices, queue };
    const list = injects(input);
    const i = activeInject(list, choices);
    if (!i) return { input, list };
    const card = currentCard(i, choices);
    const id = pick(i) ?? agentOption(i, card).id;
    choices.push({
      ...choiceFor(i, id, i.at, card, watched),
      shownAt: wall,
      decidedAt: wall + thinkMs,
    });
    wall += thinkMs + 5000;
    if (i.id === "assign") {
      const p = i.key === "assign" ? storyProposal(full) : null;
      const target = p ? p.target : (demoAt(full, iso(i.at + 1000), user, { seed }).proposals ?? []).find((x) => x.id === i.proposal)?.target;
      if (target?.team && target.sector) mine.push(assignEv(target.team, target.sector, i.at));
    }
    if (i.id === "find" && i.find) mine.push(foundEv(i.find.team, i.find.sector, i.at));
  }
  throw new Error("the run did not end");
}

const run = (r: { input: GuideInput; list: Inject[] }) => compare(r.input, hotWash(r.input, r.list), lastLight(full));

describe("the comparison's maths", () => {
  it("takes the median of an odd and an even count", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("prints a duration in seconds, or minutes and seconds", () => {
    expect(fmtDuration(1600)).toBe("1.6 s");
    expect(fmtDuration(48_000)).toBe("48 s");
    expect(fmtDuration(134_000)).toBe("2 min 14 s");
  });

  it("counts sectors, team-hours and the probability searched up to the find", () => {
    const subject = { sector: "B", lat: 0, lon: 0 };
    const poa = new Map([
      ["A", 0.5],
      ["B", 0.3],
      ["C", 0.2],
    ]);
    // the draws are the seed's: pick a seed where B's first pass detects
    const s = [...Array(200).keys()].map(String).find((k) => pass(k, subject, "T1", "B", 1, 0).detected)!;
    const a: Pass = pass(s, subject, "T1", "A", 1, 0);
    const b: Pass = pass(s, subject, "T2", "B", 1, 0);
    const c: Pass = pass(s, subject, "T3", "C", 1, b.end + 60_000); // after the find: not counted
    const st = sideStats([a, b, c], b.end, poa);
    expect(st.sectors).toBe(b.end >= a.end ? 2 : 1);
    expect(st.teamHours).toBeCloseTo((Math.min(a.end, b.end) - a.start + (b.end - b.start)) / 3600_000);
    expect(st.covered).toBeCloseTo(b.end >= a.end ? 0.5 * 0.6 : 0);
  });

  it("stretches team time by a cost on the mission clock", () => {
    const a = pass("x", null, "T1", "A", 1, 0);
    const real = (f: number) => (f > 60_000 ? f + 120_000 : f);
    expect(sideStats([a], Infinity, new Map([["A", 1]]), real).teamHours).toBeCloseTo((a.end - a.start + 120_000) / 3600_000);
  });
});

describe("you vs the agent on the overdue hiker", () => {
  it("is one search when every decision is the agent's pick", () => {
    const c = run(play(() => null, 3000));
    expect(c.followedAll).toBe(true);
    expect(c.you.findMin).not.toBeNull();
    expect(c.you.findMin).toBe(c.agent.findMin);
    expect(c.you.sectors).toBe(c.agent.sectors);
    expect(c.you.teamHours).toBeCloseTo(c.agent.teamHours);
    expect(c.you.covered).toBeCloseTo(c.agent.covered);
    expect(c.deltaMin).toBe(0);
    expect(c.verdict).toMatch(/same search/);
    expect(c.times.length).toBe(c.rows.length);
    expect(c.totalMs).toBe(3000 * c.times.length);
    expect(c.medianMs).toBe(3000);
  });

  it("puts the serpentine's 12 minutes between the two finds", () => {
    const c = run(play((i) => (i.id === "survey" ? "serpentine" : null), 10_000));
    expect(c.followedAll).toBe(false);
    expect(c.you.differed).toBe(1);
    expect(c.deltaMin).toBe(12);
    expect(c.verdict).toBe(`The agent's line found the subject 12 min sooner; 1 of your ${c.rows.length} decisions went another way.`);
    expect(c.rows.find((r) => r.key === "survey")).toMatchObject({
      same: false,
      costMin: 12,
      thinkMs: 10_000,
    });
  });

  it("leaves the decisions Watch instead made out of your decision time", () => {
    const c = run(play(() => null, 4200, true));
    expect(c.times).toEqual([]);
    expect(c.medianMs).toBeNull();
    expect(c.watched).toBe(c.rows.length);
  });

  it("never claims an area is clear, or a score", () => {
    for (const c of [run(play()), run(play((i) => (i.id === "survey" ? "serpentine" : null)))]) expect(c.verdict).not.toMatch(/clear|score/i);
  });
});

describe("the guide store's decision timing", () => {
  it("stamps when a decision was shown and when it was made", () => {
    useGuide.getState().start();
    useGuide.getState().show("survey");
    const shown = useGuide.getState().guide!.shown!.at;
    const { list } = play();
    useGuide.getState().choose(
      choiceFor(
        list.find((i) => i.id === "survey")!,
        "planner",
        0,
      ),
    );
    const c = useGuide.getState().guide!.choices[0]!;
    expect(c.shownAt).toBe(shown);
    expect(c.decidedAt).toBeGreaterThanOrEqual(shown);
    useGuide.getState().stop();
  });
});

describe("the end screen", () => {
  it("puts you vs the agent on top, the details collapsed below, in plain words", () => {
    const r = play((i) => (i.id === "survey" ? "serpentine" : null), 20_000);
    const wash = hotWash(r.input, r.list);
    const versus = compare(r.input, wash, lastLight(full));
    const noop = () => {};
    const { container } = render(
      <GuideEnd
        wash={wash}
        versus={versus}
        sectors={full.data.sectors ?? []}
        subject={null}
        scenario="Overdue hiker"
        seed={seed}
        callsign={(id) => id ?? ""}
        onReplay={noop}
        onWatchAgent={noop}
        onReport={noop}
        onTrace={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText("You vs the agent")).toBeTruthy();
    expect(container.querySelector("[data-verdict]")!.textContent).toBe(versus.verdict);
    expect(container.querySelector("[data-decision-time]")!.textContent).toMatch(/^You took \d+ min \d\d s to make \d+ decisions \(median 20 s\); the agent proposed each as the data landed\.$/);
    expect((container.querySelector("[data-details]") as HTMLDetailsElement).open).toBe(false);
    expect(container.querySelector('[data-row="survey"]')!.textContent).toContain("+12 min");
    for (const name of ["Try again", "Follow the agent this time", "Another scenario"]) expect(screen.getByText(name)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\b(demo|scripted|recorded|simulated)\b/i);
  });
});
