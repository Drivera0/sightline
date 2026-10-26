// Open play (`#play`): the checklist's logic, the setup remembered, and a setup applied to the mission
// (the last known point and its prior moved, base camp, the roster, the drones), each still reaching the
// find on the guided search's engine.
import { describe, expect, it } from "vitest";
import type { MapUpdate, MissionEvent } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import child from "./__fixtures__/scenarios/missing-child.json";
import dementia from "./__fixtures__/scenarios/dementia.json";
import despondent from "./__fixtures__/scenarios/despondent.json";
import { SECOND_LOOK_ID } from "./demoReview";
import { activeInject, agentOption, choiceFor, currentCard, injects, searchEnd, standingUser, type Choice, type GuideInput, type Inject } from "./guide";
import { demoAt, poaOf, subjectOf, type DemoFull } from "./missionTime";
import { shiftTimes } from "./scenarios";
import { STORY_NOT_A_PERSON, storyProposal } from "./storyCopy";
import {
  activeSetup,
  AREA_BOUNDS,
  asSetup,
  dronesProblem,
  EMPTY_SETUP,
  inArea,
  lastSeenProblem,
  loadSetup,
  nextCallsign,
  PROFILES,
  READY_DEFAULT,
  ready,
  saveSetup,
  sectorOf,
  snapToArea,
  STAGING,
  steps,
  teamsProblem,
  type PlaySetup,
} from "./openPlay";
import { applySetup, lastSeenAt, teamPlaces } from "./openPlayMission";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[]; t0?: string; mapBase?: MissionData["mapBase"] };
const GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 200, cols: 200 };
const N = GRID.rows * GRID.cols;
/** A prior that peaks at the demo's last known point (row 90, column 82 of the grid), like the real one. */
const raw = Array.from({ length: N }, (_, i) => Math.exp(-(((Math.floor(i / 200) - 90) ** 2 + ((i % 200) - 82) ** 2) / (2 * 40 * 40))) + 1e-6);
const prior = raw.map((v) => (v * 0.5) / raw.reduce((a, b) => a + b, 0));
const mapBase = { contract_version: "1.3", grid: GRID, lkp: { lat: 49.37, lon: -122.945 }, params: {}, prior: { p: prior, outside: 0.5 }, canopy: new Array(N).fill(null) } as unknown as MissionData["mapBase"];
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f${String(k + 1).padStart(4, "0")}`, cells: [], canopy: null, at: "2026-10-24T20:30:00Z" }));
function load(raw: unknown): DemoFull {
  const fx0 = raw as Fixture;
  const from = fx0.t0 ?? fx0.mission?.created_at;
  const to = (demo as unknown as Fixture).mission!.created_at;
  const fx = from && to ? shiftTimes(fx0, new Date(to).getTime() - new Date(from).getTime()) : fx0;
  return { now: fx.now, data: { ...fx, mapBase, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] } };
}
const PROFILE_DATA: Record<string, DemoFull> = { "overdue-hiker": load(demo), "missing-child": load(child), despondent: load(despondent), dementia: load(dementia) };

const queue = [
  { id: "f0336-d01", conf: 0.82 },
  { id: "f0127-d01", conf: 0.8 },
  { id: SECOND_LOOK_ID, conf: 0.17 },
  { id: STORY_NOT_A_PERSON, conf: 0.47 },
];
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
let seq = 0;
const assignEv = (team: string, sector: string, at: number): MissionEvent => ({ id: `u${++seq}`, type: "task.updated", at: iso(at), summary: `sector ${sector}: assigned`, ref: sector, data: { sector_id: sector, state: "assigned", team_id: team, poa: 0, pod: null, note: null, updated_at: iso(at) } as never });
const foundEv = (full: DemoFull, team: string, sector: string, at: number): MissionEvent => ({ id: `u${++seq}`, type: "mission.note", at: iso(at), summary: "Found", ref: sector, data: { action: "found", mission: { ...full.data.mission, status: "found", found: { team, sector, lat: 0, lon: 0, at: iso(at) } } } as never });

/** The agent's line through the engine (guide.test.ts's), with "send only that team" when `only`. */
function play(full: DemoFull, seed: string, only = false): { choices: Choice[]; user: MissionEvent[] } {
  const choices: Choice[] = [];
  const mine: MissionEvent[] = [];
  for (let guard = 0; guard < 120; guard++) {
    const user = standingUser(full, seed, mine, choices);
    const input: GuideInput = { full, seed, user, choices, queue };
    const i: Inject | null = activeInject(injects(input), choices);
    if (!i) return { choices, user };
    const card = currentCard(i, choices);
    const own = !card && only && i.id === "assign" && i.options.some((o) => o.id === "approve") ? "approve" : null;
    choices.push(choiceFor(i, own ?? agentOption(i, card).id, i.at, card, !own));
    if (i.id === "assign") {
      const p = i.key === "assign" ? storyProposal(full) : null;
      const target = p ? p.target : (demoAt(full, iso(i.at + 1000), user, { seed }).proposals ?? []).find((x) => x.id === i.proposal)?.target;
      if (target?.team && target.sector) mine.push(assignEv(target.team, target.sector, i.at));
    }
    if (i.id === "find" && i.find) mine.push(foundEv(full, i.find.team, i.find.sector, i.at));
  }
  throw new Error("the run did not end");
}

const setup = (over: Partial<PlaySetup> = {}): PlaySetup => ({ ...READY_DEFAULT, ...over });

describe("open play's checklist", () => {
  it("starts with nothing done, and Start stays off until every required step is", () => {
    const s = steps(EMPTY_SETUP);
    expect(s.map((x) => x.id)).toEqual(["who", "where", "camp", "teams", "drones", "review"]);
    expect(s.filter((x) => x.done)).toEqual([]);
    expect(ready(EMPTY_SETUP)).toBe(false);
    expect(ready(READY_DEFAULT)).toBe(true);
  });

  it("ticks each step on its own condition", () => {
    let s: PlaySetup = { ...EMPTY_SETUP, profile: "missing-child" };
    expect(steps(s)[0]!.done).toBe(false); // a profile and no description yet
    s = { ...s, subject: "child, 8, yellow raincoat" };
    expect(steps(s)[0]).toMatchObject({ done: true, status: "Missing child · child, 8, yellow raincoat" });
    s = { ...s, lkp: { lat: 49.3705, lon: -122.9445 } };
    expect(steps(s)[1]).toMatchObject({ done: true, status: "Sector C2 · last seen 10:30" });
    expect(steps({ ...s, lastSeen: "14:00" })[1]!.done).toBe(false);
    expect(steps({ ...s, lkp: { lat: 49.36, lon: -122.9445 } })[1]!.done).toBe(false); // outside the area
    s = { ...s, camp: "Viewpoint lot" };
    expect(steps(s)[2]!.done).toBe(true);
    // the roster and the drones start filled in: each counts once confirmed
    expect(steps(s)[3]!.done).toBe(false);
    s = { ...s, confirmed: { teams: true, drones: false } };
    expect(steps(s)[3]).toMatchObject({ done: true, status: "4 teams · 12 people · check-in every 30 min" });
    expect(ready(s)).toBe(false);
    s = { ...s, confirmed: { teams: true, drones: true } };
    expect(ready(s)).toBe(true);
    expect(steps({ ...s, teams: s.teams.slice(0, 1) })[3]!.done).toBe(false);
  });

  it("says what is wrong with a roster, the drones and the time", () => {
    expect(teamsProblem([{ callsign: "Alpha", members: 3 }])).toMatch(/at least 2/);
    expect(teamsProblem([{ callsign: "Alpha", members: 3 }, { callsign: "alpha ", members: 3 }])).toMatch(/same callsign/);
    expect(teamsProblem([{ callsign: "Alpha", members: 3 }, { callsign: " ", members: 3 }])).toMatch(/callsign/);
    expect(teamsProblem([{ callsign: "Alpha", members: 1 }, { callsign: "Bravo", members: 3 }])).toMatch(/people/);
    expect(teamsProblem(Array.from({ length: 7 }, (_, i) => ({ callsign: `T${i}`, members: 3 })))).toMatch(/At most 6/);
    expect(dronesProblem(["upload"])).toMatch(/flies the survey/);
    expect(dronesProblem(["survey", "folder"])).toMatch(/field kit/);
    expect(dronesProblem(["survey", "upload"])).toBeNull();
    expect(lastSeenProblem("13:40")).toMatch(/before/);
    expect(lastSeenProblem("9:30")).toMatch(/HH:MM/);
    expect(nextCallsign([{ callsign: "Team One", members: 3 }, { callsign: "Team Three", members: 3 }])).toBe("Team Two");
  });

  it("keeps the last known point inside the surveyed area and names its sector", () => {
    const out = snapToArea({ lat: 49.36, lon: -122.96 });
    expect(inArea(out)).toBe(true);
    expect(sectorOf(out)).toBe("A4");
    expect(sectorOf({ lat: AREA_BOUNDS.north - 0.0001, lon: AREA_BOUNDS.east - 0.0001 })).toBe("D1");
    // the area's edges are the demo's sectors' (A1's north-west corner, D4's south-east)
    const sectors = (demo as unknown as { sectors: { sector_id: string; polygon: [number, number][] }[] }).sectors;
    const a1 = sectors.find((x) => x.sector_id === "A1")!.polygon;
    const d4 = sectors.find((x) => x.sector_id === "D4")!.polygon;
    expect(Math.min(...a1.map((p) => p[0]))).toBeCloseTo(AREA_BOUNDS.west, 5);
    expect(Math.max(...a1.map((p) => p[1]))).toBeCloseTo(AREA_BOUNDS.north, 5);
    expect(Math.max(...d4.map((p) => p[0]))).toBeCloseTo(AREA_BOUNDS.east, 4);
    expect(Math.min(...d4.map((p) => p[1]))).toBeCloseTo(AREA_BOUNDS.south, 4);
  });

  it("remembers the setup in this browser, and survives storage that throws or holds junk", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = setup({ profile: "dementia", subject: "older adult, slippers", camp: "Creek bridge pull-out" });
    saveSetup(s, store);
    expect(loadSetup(store)).toEqual(s);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => saveSetup(s, broken)).not.toThrow();
    expect(loadSetup(broken)).toBeNull();
    expect(loadSetup({ getItem: () => "{not json" })).toBeNull();
    expect(asSetup({ teams: "x" })).toBeNull();
    expect(asSetup({ ...s, camp: "Somewhere else", profile: "nobody" })).toMatchObject({ camp: null, profile: null });
    // a shared link with nothing stored still opens a complete search
    expect(ready(activeSetup())).toBe(true);
  });

  it("offers the scenarios' four profiles and the generator's four staging points", () => {
    expect(PROFILES.map((p) => p.name)).toEqual(["Overdue hiker", "Missing child", "Despondent", "Dementia walk-away"]);
    expect(STAGING.map((x) => x.name)).toEqual(["Trailhead lot", "Viewpoint lot", "Creek bridge pull-out", "Power-line access"]);
  });
});

describe("a setup applied to the mission", { timeout: 30_000 }, () => {
  const hiker = PROFILE_DATA["overdue-hiker"]!;

  it("moves the last known point and the prior's peak there, and re-ranks the agent's first assignment", () => {
    const lkp = { lat: 49.3732, lon: -122.9505 }; // sector A1
    const out = applySetup(hiker, setup({ lkp }));
    expect(out.data.mission!.area.lkp).toEqual(snapToArea(lkp));
    expect(out.data.mapBase!.lkp).toEqual(snapToArea(lkp));
    const p = out.data.mapBase!.prior.p;
    const peak = p.indexOf(Math.max(...p));
    const [r, c] = [Math.floor(peak / 200), peak % 200];
    // the peak sits in A1 now (rows and columns 0–49), and the probability inside the grid is unchanged
    expect(r).toBeLessThan(50);
    expect(c).toBeLessThan(50);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(prior.reduce((a, b) => a + b, 0), 6);
    const ranked = [...poaOf(out)].sort((a, b) => b[1] - a[1])[0]![0];
    expect(storyProposal(out)!.target.sector).toBe(ranked);
    expect(ranked).toBe("A1");
    // where the person really is does not move
    expect(subjectOf(out)).toEqual(subjectOf(hiker));
  });

  it("sets the subject, the last-seen time, the check-in interval and base camp", () => {
    const out = applySetup(hiker, setup({ subject: "adult, 34, orange shell jacket", lastSeen: "11:15", checkInMin: 15, camp: "Power-line access" }));
    const m = out.data.mission!;
    expect(m.subject).toBe("adult, 34, orange shell jacket");
    expect(m.last_seen_at).toBe(lastSeenAt("11:15"));
    expect(m.last_seen_at).toBe("2026-10-24T18:15:00Z"); // 11:15 PDT
    expect(m.check_in_min).toBe(15);
    expect(m.base_camp).toEqual({ lat: 49.3608, lon: -122.95297, name: "Power-line access" });
    expect(out.data.fleet!.drones.every((d) => d.home?.lat === 49.3608)).toBe(true);
    // the console's teams wait at base camp at the call
    const at = demoAt(out, "2026-10-24T20:35:00Z", [], { seed: "play" });
    expect(at.teams!.filter((t) => t.status === "standby").every((t) => t.position?.lat === 49.3608)).toBe(true);
  });

  it("renames the teams everywhere the log says them, and adds teams at base camp", () => {
    const teams = [
      { callsign: "Rescue 1", members: 4 },
      { callsign: "Team One", members: 2 }, // a name another place had: names trade places cleanly
      { callsign: "K9", members: 2 },
      { callsign: "Bravo", members: 3 },
      { callsign: "Charlie", members: 3 },
      { callsign: "Delta", members: 5 },
    ];
    const out = applySetup(hiker, setup({ teams }));
    expect(out.data.teams!.map((t) => [t.callsign, t.members])).toEqual(teams.map((t) => [t.callsign, t.members]));
    expect(out.data.teams!.map((t) => t.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    const said = JSON.stringify([out.data.events, out.data.timeline, out.data.proposals]);
    expect(said).not.toMatch(/Team Two|Team Three|Team Four/);
    // T1's lines (the clue it radioed, its first assignment) carry its new name
    expect(storyProposal(out)!.summary).toMatch(/Rescue 1/);
    const at = demoAt(out, "2026-10-24T21:45:00Z", [], { seed: "play" });
    expect(at.teams!.map((t) => t.callsign)).toEqual(teams.map((t) => t.callsign));
  });

  it("drops the places left empty with their proposals and lines, keeping the teams that radio clues", () => {
    for (const [seed, full] of Object.entries(PROFILE_DATA)) {
      const places = teamPlaces(full);
      const reporters = new Set((full.data.clues ?? []).map((c) => c.reported_by).filter((x) => x !== "command"));
      expect(places.slice(0, reporters.size).sort()).toEqual([...reporters].sort());
      const out = applySetup(full, setup({ teams: [{ callsign: "Alpha", members: 3 }, { callsign: "Bravo", members: 3 }] }));
      const ids = out.data.teams!.map((t) => t.id);
      expect(ids, seed).toEqual(places.slice(0, 2));
      expect(out.data.proposals!.every((p) => !p.target.team || ids.includes(p.target.team)), seed).toBe(true);
      expect(out.data.clues!.every((c) => c.reported_by === "command" || ids.includes(c.reported_by!)), seed).toBe(true);
      expect(storyProposal(out), seed).not.toBeNull();
      const gone = (full.data.teams ?? []).filter((t) => !ids.includes(t.id)).map((t) => t.callsign);
      for (const t of ["2026-10-24T21:00:00Z", "2026-10-24T21:45:00Z", "2026-10-24T22:00:00Z"]) {
        const at = demoAt(out, t, [], { seed: "play" });
        const text = JSON.stringify([at.timeline, at.events?.map((e) => e.summary), at.proposals?.map((p) => p.summary)]);
        for (const g of gone) expect(text, `${seed} ${t}`).not.toContain(g);
      }
    }
  });

  it("flies only the drones asked for, with their flight lines and log lines", () => {
    const one = applySetup(hiker, setup({ drones: ["survey"] }));
    expect(one.data.fleet!.drones.map((d) => d.id)).toEqual(["D1"]);
    expect(one.data.fleet!.legs.every((l) => l.drone_id === "D1")).toBe(true);
    expect(JSON.stringify(one.data.events!.map((e) => e.summary))).not.toMatch(/Drone 2|Drone 3|\bD2 link|via D3/);
    // sector D2 and D3 are still there (a drone's id is also a sector's)
    expect(one.data.sectors!.map((s) => s.sector_id)).toContain("D2");
    // no lost-link decision without a second drone to lose
    const list = injects({ full: one, seed: "play", user: [], choices: [], queue });
    expect(list.map((i) => i.id)).not.toContain("link");
    const two = applySetup(hiker, setup({ drones: ["survey", "upload"] }));
    expect(two.data.fleet!.drones.map((d) => d.id)).toEqual(["D1", "D2"]);
  });

  describe("every setup still reaches the find", () => {
    const cases: [string, Partial<PlaySetup>][] = [
      ["the scenario's own point", {}],
      ["a far corner, two teams, one drone", { lkp: { lat: 49.3735, lon: -122.9395 }, teams: [{ callsign: "Alpha", members: 3 }, { callsign: "Bravo", members: 3 }], drones: ["survey"], camp: "Power-line access" }],
      ["six teams, two drones", { lkp: { lat: 49.3665, lon: -122.951 }, teams: Array.from({ length: 6 }, (_, i) => ({ callsign: `Unit ${i + 1}`, members: 3 })), drones: ["survey", "upload"], camp: "Viewpoint lot" }],
    ];
    for (const [seed, full] of Object.entries(PROFILE_DATA))
      for (const [name, over] of cases)
        for (const only of [false, true])
          it(`${seed}: ${name}${only ? ", sending one team at a time" : ""}`, () => {
            const out = applySetup(full, setup({ profile: seed, ...over }));
            const { choices, user } = play(out, "play", only);
            expect(choices.at(-1)!.inject).toBe("find");
            const found = user.find((e) => e.type === "mission.note" && (e.data as { action?: string }).action === "found")!;
            expect(new Date(found.at).getTime()).toBeLessThan(searchEnd(out));
            // the find is made by a team on the visitor's roster
            expect(out.data.teams!.map((t) => t.id)).toContain(((found.data as { mission: { found: { team: string } } }).mission.found.team));
          });
  });
});
