// Numbers that should match do (the cold test, 2026-10-26): the daylight a briefing quotes and the
// header's, a card's share of the probability and the sector table's, the survey's "first" sectors and
// the table at the call, the end screen's find time and the timeline's. One source per number. Built by lane A.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Conditions, MapBase, MapUpdate, MissionEvent, Proposal } from "../contract";
import { EMPTY, useMission, type MissionData } from "../lib/mission";
import fixture from "./__fixtures__/demo_mission.json";
import { BriefingNow } from "./ApprovalInbox";
import { fmtMin } from "./compare";
import { daylightMin, duration } from "./console";
import { foundAfter } from "./GuideEnd";
import { hotWash, injects, type Choice } from "./guide";
import { CHECKPOINTS, rankPending, restatePoa, sectorsAt, type DemoFull } from "./missionTime";

// the demo cache's grid (the map is not in the repository): a prior that leans to the north-east, so the sectors differ
const GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 200, cols: 200 };
const p = Array.from({ length: 40000 }, (_, i) => 1 + (i % 200) / 200 + (200 - Math.floor(i / 200)) / 400);
const total = p.reduce((n, x) => n + x, 0);
const base = {
  contract_version: "1.2",
  grid: GRID,
  lkp: { lat: 49.37, lon: -122.945 },
  params: { recall: 0.864, recall_source: "x", pod_cap: 0.95, review_pod: 0.9, prior_source: "placeholder" },
  prior: { p: p.map((x) => (x / total) * 0.25), outside: 0.75 },
  canopy: new Array(40000).fill(null),
} as unknown as MapBase;
const fx = fixture as unknown as Partial<MissionData> & { now: string; map_updates: MapUpdate[] };
const full: DemoFull = { data: { ...fx, mapBase: base, mapUpdates: [...fx.map_updates], verdicts: [] }, now: fx.now };
const ms = (iso: string) => new Date(iso).getTime();

afterEach(() => useMission.setState({ ...EMPTY }));

describe("the survey's first sectors are the table's at the call", () => {
  it("names the likeliest sectors on the map at the call with the table's figures, and their sum", () => {
    const survey = injects({ full, seed: "demo", user: [], choices: [], queue: [] }).find((i) => i.id === "survey")!;
    const table = sectorsAt(base, full.data.sectors ?? [], []).sort((a, b) => b.poa - a.poa || a.sector_id.localeCompare(b.sector_id));
    const top = table.slice(0, 3);
    const shown = top.map((s) => (s.poa * 100).toFixed(1));
    expect(survey.agentSays).toContain(`${top.map((s) => s.sector_id).join(", ")} first`);
    for (const x of shown) expect(survey.agentSays).toContain(`${x} %`);
    // the sum is a share of the whole probability, the table's three figures added up
    expect(survey.agentSays).toContain(`${shown.reduce((n, x) => n + Number(x), 0).toFixed(1)} % of the probability between them`);
    // never the fixtures' end-of-mission map ("C2, B2, C3 first: 33 % of the probability")
    expect(survey.agentSays).not.toMatch(/33 %/);
  });
});

describe("a card's share of the probability is the sector table's", () => {
  it("restates the figure a card opens with from the map now", () => {
    expect(restatePoa("B2 · 3.1 % of remaining probability, up from 1.9 %: c005 raised it", "B2", 0.015)).toBe("B2 · 1.5 % of remaining probability: c005 raised it");
    expect(restatePoa("B2 · 3.1 % of remaining probability, up from 1.9 %: c005 raised it", "B2", 0.024)).toBe("B2 · 2.4 % of remaining probability, up from 1.9 %: c005 raised it");
    expect(restatePoa("No new evidence", "B2", 0.015)).toBe("No new evidence");
  });

  it("every pending assignment's card, the scenario's own too, says what the table says", () => {
    const s = { ...EMPTY, ...(fx as Partial<MissionData>), tasks: [] } as MissionData;
    const sectors = (fx.sectors ?? []).map((x) => ({ ...x, poa: x.sector_id === "B2" ? 0.015 : x.poa }));
    const props: Proposal[] = (fx.proposals ?? []).map((x) => ({ ...x, status: "pending" as const, decided_at: null, decided_by: null }));
    const b2 = props.find((x) => x.target.sector === "B2")!;
    expect(b2.reason).toMatch(/^B2 · 3\.1 % of remaining probability/);
    const out = rankPending({ ...s, proposals: props }, sectors);
    expect(out.proposals.find((x) => x.id === b2.id)!.reason).toMatch(/^B2 · 1\.5 % of remaining probability/);
  });
});

describe("daylight: the header, the goals and a briefing's", () => {
  const conditions = { civil_twilight_end: "2026-10-25T01:36:46Z" } as Conditions;

  it("whole minutes rounded down, as the agent gives them to its briefings", () => {
    // 3 h 54 min 46 s at 14:42: the briefing written then says "3 h 54 min daylight"
    expect(duration(daylightMin(conditions, new Date("2026-10-24T21:42:00Z"))!)).toBe("3 h 54 min");
  });

  it("a model's briefing says beside it the sector's share and the daylight now", () => {
    useMission.setState({ ...EMPTY, conditions, sectors: [{ sector_id: "C2", poa: 0.017, polygon: null } as never] });
    const p = { id: "p002", kind: "assign_sector", target: { team: "T1", sector: "C2" }, created_at: "2026-10-24T21:42:00Z" } as unknown as Proposal;
    render(<BriefingNow p={p} now={new Date("2026-10-24T21:55:00Z")} />);
    expect(screen.getByLabelText("The briefing's figures now")).toHaveTextContent("The briefing's figures are the agent's when it drafted it. Now: C2 holds 1.7 % on the map, 3 h 41 min of daylight left.");
  });

  it("minutes are rounded once (119.6 min is 2 h 00 min, never 1 h 60 min)", () => {
    expect(fmtMin(119.6)).toBe("2 h 00 min");
    expect(fmtMin(59.6)).toBe("1 h 00 min");
  });
});

describe("the find: the end screen's time is the timeline's", () => {
  it("found at the time its event shows; a confirmation's minute is not added on top", () => {
    const at = "2026-10-24T22:57:00Z";
    const found: MissionEvent = { id: "u1", type: "mission.note", at, summary: "Found", ref: "C2", data: { action: "found", mission: { ...fx.mission, status: "found", found: { team: "T4", sector: "C2", lat: 0, lon: 0, at } } } as never };
    const confirm: Choice = { key: "find", inject: "find", option: "confirm", label: "Ask for a confirmation first", agentLabel: "Mark Found", agent: false, f: ms(at), costMs: 60_000 };
    const wash = hotWash({ full, seed: "demo", user: [found], choices: [confirm], queue: [] }, []);
    expect(wash.outcome.foundAt).toBe(ms(at));
  });

  it("says how long from the call, and from the mission's opening, the header's Elapsed", () => {
    const t = (x: number) => new Date(x).toISOString().slice(11, 16);
    const foundAt = ms(CHECKPOINTS[0]!.at) + 143 * 60_000;
    expect(foundAfter(foundAt, "2026-10-24T20:30:00Z", t)).toBe("2 h 23 min after the call at 20:35 (2 h 28 min after the mission was opened at 20:30, the Elapsed in the header)");
    expect(foundAfter(foundAt, null, t)).toBe("2 h 23 min after the call at 20:35");
  });
});
