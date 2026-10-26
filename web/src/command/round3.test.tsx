// Round 3 of the cold usability test (BC SAR manager, 2026-10-25): the page never scrolls under the console,
// Send all keeps teams already on a fresh task, the sighting card never names a committed team, the button's
// numbers are the board's, every decision line says who, the find recalls the drones (a safety recall
// stands), the carry-out is not "searching", and no drone brand on screen. Built by lane A.
import { describe, expect, it, vi } from "vitest";
import type { MapUpdate, MissionEvent, Proposal, Team } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import { bringToTop } from "./ApprovalInbox";
import { scrollWithin, showControl } from "./CoachMark";
import { committed, nearestFree } from "./console";
import { activeInject, agentOption, choiceFor, currentCard, injects, sendAllLabel, standingUser, type Choice } from "./guide";
import { guidedOptsFor } from "./GuideRun";
import { storyProposal } from "./storyCopy";
import { SECOND_LOOK_ID } from "./demoReview";
import { STORY_NOT_A_PERSON } from "./storyCopy";
import { closedOnFind, demoAt, findRecalls, legApprover, type DemoFull } from "./missionTime";
import { resourceSummary } from "./Resources";
import { photoLabel } from "../review/LiveReview";
import { assignmentEvent, playStanding } from "./sim";
import { brandFree, localForecastTime, plainWords } from "./terms";
import { buildTimeline, inFilter } from "./timeline";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[] };
const fx = demo as unknown as Fixture;
const full: DemoFull = { now: fx.now, data: { ...fx, mapUpdates: [...fx.map_updates], verdicts: [] } };
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const team = (id: string, over: Partial<Team> = {}): Team => ({ id, callsign: `Team ${id}`, members: 3, status: "standby", position: null, position_at: null, note: null, ...over });

describe("Send all: the page never scrolls under the console (round 3: a blank band after the click)", () => {
  it("a control with no scrolling column of its own scrolls nothing, never the document", () => {
    document.body.innerHTML = '<main><div id="card"><button type="button">Send all</button></div></main>';
    const btn = document.querySelector("button")!;
    const into = vi.fn();
    btn.scrollIntoView = into;
    (document.getElementById("card") as HTMLElement).scrollIntoView = into;
    const winScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    showControl(btn);
    scrollWithin(btn);
    bringToTop(document.getElementById("card")!);
    expect(into).not.toHaveBeenCalled();
    expect(winScroll).not.toHaveBeenCalled();
    expect(document.documentElement.scrollTop).toBe(0);
    winScroll.mockRestore();
    document.body.innerHTML = "";
  });

  it("inside a scrolling column, only the column moves", () => {
    document.body.innerHTML = '<div id="col" style="overflow-y:auto;height:100px"><div style="height:400px"></div><button type="button">Send all</button></div>';
    const col = document.getElementById("col")!;
    Object.defineProperty(col, "clientHeight", { value: 100 });
    const btn = document.querySelector("button")!;
    col.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    btn.getBoundingClientRect = () => ({ top: 400, bottom: 430, height: 30, left: 0, right: 100, width: 100, x: 0, y: 400, toJSON: () => ({}) });
    scrollWithin(btn);
    expect(col.scrollTop).toBe(330);
    document.body.innerHTML = "";
  });
});

describe("Send all keeps the teams already on a fresh task; the sighting card names a free team", () => {
  it("the standing approval's first sends skip a team walking to or sweeping its sector", () => {
    const t0 = Date.UTC(2026, 9, 24, 21, 0);
    // Team Four sent to C2 two minutes before Send all (the edited first assignment)
    const user = [assignmentEvent("u-t4", "T4", "C2", t0 - 2 * 60_000)];
    const poa = new Map([["C2", 0.3], ["B2", 0.2], ["C3", 0.1], ["D2", 0.05]]);
    const out = playStanding("overdue-hiker", { sector: "A1", lat: 0, lon: 0 }, poa, user, ["T1", "T3", "T4"], t0, t0 + 3 * 3600_000, () => false, true);
    const at = out.filter((e) => e.id.startsWith(`auto-`) && e.at === iso(t0));
    expect(at.map((e) => (e.data as unknown as { team_id: string }).team_id).sort()).toEqual(["T1", "T3"]);
    expect(at.some((e) => (e.data as unknown as { team_id: string }).team_id === "T4")).toBe(false);
  });

  it("a team on a sector task or the carry-out is committed; the hasty search and base camp are not", () => {
    expect(committed(team("T4", { status: "assigned" }))).toBe(true);
    expect(committed(team("T4", { status: "searching" }))).toBe(true);
    expect(committed(team("T1", { status: "searching", note: "carry-out" }))).toBe(true);
    expect(committed(team("T2", { status: "searching", note: "hasty search" }))).toBe(false);
    expect(committed(team("T3"))).toBe(false);
    expect(committed(team("T3", { status: "returning" }))).toBe(false);
  });

  it("the nearest free team goes to a sighting, never the committed one beside it", () => {
    const at = { lat: 49.37, lon: -122.95 };
    const near = { lat: 49.3701, lon: -122.9501, accuracy_m: 5 } as Team["position"];
    const teams = [team("T4", { status: "searching", position: near }), team("T1"), team("T3", { status: "returning", position: { lat: 49.372, lon: -122.95, accuracy_m: 5 } as Team["position"] })];
    expect(nearestFree(teams, at, { lat: 49.38, lon: -122.95 })?.team.id).toBe("T3");
    // nobody else can go: the committed team is still named rather than none
    expect(nearestFree([teams[0]!], at, null)?.team.id).toBe("T4");
  });

  it("the button's numbers are the board's: free, returning, on the hasty search, never one team twice", () => {
    expect(sendAllLabel(2, "Team Two", "D2", { returning: 1 })).toBe("Send the 2 free teams and the 1 returning one to the AI's picks now");
    expect(sendAllLabel(0, "Team Two", "D2", { returning: 2 })).toBe("Send the 2 returning ones to the AI's picks now");
    expect(sendAllLabel(0, "Team Two", "D2", { returning: 1 })).toBe("Send Team Two to D2");
    expect(sendAllLabel(1, "Team Two", "D2", { hasty: 2 })).toBe("Send the 1 free team and the 2 on the hasty search to the AI's picks now");
  });
});

describe("every decision line says who", () => {
  const ev = (id: string, type: MissionEvent["type"], data: unknown, summary = ""): MissionEvent => ({ id, type, at: "2026-10-24T21:00:00Z", summary, ref: null, data: data as never });

  it("the lawnmower pattern's flight lines are the visitor's choice, never pre-planned", () => {
    expect(legApprover({ option: "serpentine", watched: false })).toMatch(/you chose: the lawnmower pattern/);
    expect(legApprover({ option: "serpentine", watched: false })).not.toMatch(/pre-planned/);
  });

  it("the survey choice, a photo's answer and a clue's confirm are Decisions rows, each with who", () => {
    const rows = buildTimeline(
      [
        ev("u1", "mission.note", { action: "survey", by: "Search manager", option: "serpentine" }, "Survey: a lawnmower pattern over the whole grid (+12 min) (you chose it)"),
        ev("u2", "mission.note", { action: "photo_answer", by: "Search manager", answer: "person" }, "Photo 1 (survey photo 336): The subject (answered by you)"),
        ev("u3", "mission.note", { action: "photo_answer", by: "Watch instead", answer: "not_person" }, "Photo 2 (survey photo 452): Not a person (Watch instead chose it)"),
        ev("u4", "clue.added", { id: "c003", kind: "track", text: "small shoe prints", lat: 0, lon: 0, radius_m: 10, at: "2026-10-24T21:00:00Z", at_team_position: false, reliability: "medium", reported_by: "command", source: "form", confirmed: true, confirmed_by_turn: null, decided_by: "Search manager" }),
      ],
      [],
    );
    const decisions = rows.filter((e) => inFilter(e, "Decisions"));
    expect(decisions).toHaveLength(4);
    expect(rows.find((e) => e.kind === "clue")!.detail).toMatch(/confirmed by you/);
    for (const e of decisions.filter((x) => x.kind !== "clue")) expect(e.text).toMatch(/you chose it|answered by you|Watch instead chose it/);
  });
});

describe("the Decisions filter never goes down over a run", () => {
  it("counts the survey, the photo answers, the clue and the assignments as they are made", () => {
    const SEED = "overdue-hiker";
    const queue = [{ id: "f0336-d01", conf: 0.82 }, { id: SECOND_LOOK_ID, conf: 0.17 }, { id: STORY_NOT_A_PERSON, conf: 0.47 }];
    const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f${String(k + 1).padStart(4, "0")}`, cells: [], canopy: null, at: "2026-10-24T20:30:00Z" }));
    const f2: DemoFull = { now: fx.now, data: { ...fx, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] } };
    const by = "Search manager";
    const choices: Choice[] = [];
    const mine: MissionEvent[] = [];
    let n = 0;
    let last = 0;
    const note = (at: number, action: string, summary: string) => mine.push({ id: `u${++n}`, type: "mission.note", at: iso(at), summary, ref: null, data: { action, by } as never });
    for (let guard = 0; guard < 80; guard++) {
      const user = standingUser(f2, SEED, mine, choices);
      const i = activeInject(injects({ full: f2, seed: SEED, user, choices, queue }), choices);
      if (!i) break;
      const card = currentCard(i, choices);
      const opt = agentOption(i, card).id;
      choices.push(choiceFor(i, opt, i.at, card));
      if (i.id === "survey") note(i.at, "survey", "Survey: the AI's flight lines (you chose it)");
      if (i.id === "triage") note(i.at, "photo_answer", `Photo: ${opt} (answered by you)`);
      if (i.id === "assign") {
        const p = i.key === "assign" ? storyProposal(f2)! : (demoAt(f2, iso(i.at + 1000), user, { seed: SEED }).proposals ?? []).find((x) => x.id === i.proposal);
        if (p?.target.team && p.target.sector) {
          mine.push({ id: `u${++n}`, type: "proposal.decided", at: iso(i.at), summary: "", ref: p.id, data: { ...p, status: "approved", decided_by: by, decided_at: iso(i.at) } as never });
          mine.push(assignmentEvent(`u${++n}`, p.target.team, p.target.sector, i.at));
        }
      }
      if (i.id === "find" && i.find) mine.push({ id: `u${++n}`, type: "mission.note", at: iso(i.at), summary: "Found", ref: i.find.sector, data: { action: "found", by } as never });
      const u2 = standingUser(f2, SEED, mine, choices);
      const s = demoAt(f2, iso(i.at + 1000), u2, guidedOptsFor(f2, SEED, choices, u2)) as MissionData;
      const count = buildTimeline(s.events, s.teams, s.timeline).filter((e) => inFilter(e, "Decisions")).length;
      expect(count, `${i.key} at ${iso(i.at)}`).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(choices.at(-1)!.inject).toBe("find");
  });
});

describe("the find: drones come home, a safety recall stands, the carry-out is said apart", () => {
  it("a pending recall is approved at the find, never closed", () => {
    const s = demoAt(full, fx.now, [], { seed: "overdue-hiker" }) as MissionData;
    const recall: Proposal = { id: "r9", kind: "retask_drone", summary: "Recall Drone 2: fly home now", reason: "Gusts over the limit", briefing: null, target: { drone: "D2", home: "base camp" }, evidence: [], status: "pending", created_by: "agent", created_at: fx.now, decided_at: null, decided_by: null, decision_reason: null, edits: null };
    const found = { id: "u9", type: "mission.note" as const, at: fx.now, summary: "Found", ref: "C2", data: { action: "found", by: "Search manager" } as never };
    const c = closedOnFind({ ...s, proposals: [...s.proposals, recall] }, [found]);
    expect(c.proposals.find((p) => p.id === "r9")).toMatchObject({ status: "approved", decision_reason: "the safety recall stands at the find" });
  });

  it("every drone still in the air at the find is recalled to base camp", () => {
    const fl = full.data.fleet;
    if (!fl?.drones.length) return;
    const legs = fl.legs ?? [];
    const mid = legs.length ? new Date(Date.parse(full.data.events?.find((e) => e.type === "fleet.updated")?.at ?? fx.now) + 10 * 60_000).toISOString().replace(/\.\d+Z$/, "Z") : fx.now;
    const found = { id: "u9", type: "mission.note" as const, at: mid, summary: "Found", ref: "C2", data: { action: "found", by: "Search manager" } as never };
    const back = findRecalls(full.data, [found], "the search manager");
    for (const e of back) expect(e.summary).toMatch(/recalled to base camp by the find$/);
    const s = demoAt(full, mid, [found], { seed: "overdue-hiker" }) as MissionData;
    expect((s.fleet?.drones ?? []).filter((d) => d.status === "flying")).toHaveLength(0);
  });

  it("the header counts the carry-out team as the carry-out, never searching", () => {
    const h = { at: null, min: 0, overdue: false, due: false };
    const s = resourceSummary([{ team: team("T1", { status: "searching", note: "carry-out" }), heard: h }, { team: team("T2", { status: "returning" }), heard: h }], []);
    expect(s.teams).toBe("2 teams: 1 carry-out · 1 returning");
  });
});

describe("no drone brand on screen, the forecast in local time, photos by their number", () => {
  it("rewrites the forecast line", () => {
    const line = 'Gusts 52 km/h ("Wind gusting to 52 km/h", as of 20:25 UTC) > DJI Mavic 3E limit 43 km/h. Recall Drone 1 to its launch point.';
    const said = plainWords(line);
    expect(said).not.toMatch(/DJI|Mavic|UTC/);
    expect(said).toMatch(/> drone gust limit 43 km\/h/);
    expect(localForecastTime("as of 20:25 UTC", "America/Vancouver")).toMatch(/^as of 1[23]:25 P[DS]T$/);
    expect(brandFree("under Mavic 3E's gust limit of 43 km/h")).toBe("under drone gust limit of 43 km/h");
  });

  it("a screen reader hears the survey photo's number, never the detection id", () => {
    expect(photoLabel("f0336-d01")).toBe("survey photo 336");
  });
});
