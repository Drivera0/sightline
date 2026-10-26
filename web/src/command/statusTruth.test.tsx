// Team status must be right every time (the cold test, 2026-10-25: "Clever, but I can't trust what it
// tells me about my teams"). The row, Needs you, the toasts and the bell read one last-heard clock and
// agree at every step; a team heard inside its check-in window is never called overdue; a returning team
// counts down; drones drain by the minute and come home; every approval names who approved it; a
// reviewer's "Person" puts "send the nearest team" at the top of Needs you. Built by lane A.
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clue, FleetState, Mission, MissionEvent, SectorTask, Team, TimelineEvent } from "../contract";
import { NO_LINKS, type MissionData } from "../lib/mission";
import { useNotify } from "../shell/notify";
import fixture from "./__fixtures__/demo_mission.json";
import { CommandView, type CommandProps } from "./CommandView";
import { heard, needs, overdueTeams, teamOrder } from "./console";
import { useConsole } from "./consoleStore";
import { DRAIN_PCT_PER_MIN, flights, fleetNow, legSortie } from "./fleetSim";
import { demoAt, placeOf } from "./missionTime";
import { buildTimeline } from "./timeline";
import { NeedsYou } from "./NeedsYou";
import { passesFrom } from "./sim";

const MIN = 60_000;
const at = (base: string, min: number) => new Date(new Date(base).getTime() + min * MIN).toISOString().replace(/\.\d+Z$/, "Z");
const T0 = "2026-10-24T21:00:00Z";
const team = (id: string, callsign: string, status: Team["status"], heardAt: string | null): Team => ({ id, callsign, members: 3, status, position: null, position_at: null, note: null, last_heard_at: heardAt });
const mission = { mission_id: "m1", name: "Seymour", created_at: "2026-10-24T20:30:00Z", check_in_min: 30, base_camp: { lat: 49.373, lon: -122.949, name: "Trailhead lot" }, area: { name: "Seymour", lkp: { lat: 49.37, lon: -122.945 } } } as Mission;
const radioIn = (id: string, callsign: string, when: string): MissionEvent => ({
  id, type: "radio.turn", at: when, summary: "", ref: id,
  data: { id, direction: "in", callsign, transcript: `Sightline, ${callsign}. Radio check, all fine, over.`, reply: null, audio: null, state: "answered", actions: [], asr_ms: null, llm_ms: null, tts_ms: null, at: when } as never,
});

beforeEach(() => {
  useConsole.getState().reset();
  useNotify.getState().reset();
});

describe("one truth for team status", () => {
  it("at every step the row's overdue badge, Needs you, the toasts and the bell agree", () => {
    // Team Three out since 21:00, not heard; it radios at 21:45 (an event) and again at 22:05 (only in the server's timeline)
    const teams = [team("T1", "Team One", "standby", null), team("T3", "Team Three", "searching", T0), team("T4", "Team Four", "assigned", at(T0, 10))];
    const tasks: SectorTask[] = [{ sector_id: "A1", state: "in_progress", team_id: "T3", poa: 0.05, pod: null, note: null, updated_at: T0 }, { sector_id: "B2", state: "assigned", team_id: "T4", poa: 0.05, pod: null, note: null, updated_at: at(T0, 10) }];
    const allEvents = [radioIn("r1", "Team Three", at(T0, 45))];
    const allTimeline: TimelineEvent[] = [{ id: "t1", at: at(T0, 65), kind: "radio", team: "T3", text: "Sightline, Team Three. On the ridge, over.", direction: "in" }];
    const props = (min: number): CommandProps => {
      const now = new Date(at(T0, min));
      return {
        mission, status: "live", conditions: null, imageUrl: (r) => r, proposals: [], clues: [], fleet: null, links: NO_LINKS, sectors: [], tasks, teams,
        events: allEvents.filter((e) => new Date(e.at) <= now), timeline: allTimeline.filter((e) => new Date(e.at) <= now),
        actions: { assign: vi.fn(), droneLeg: vi.fn(), searched: vi.fn(), recheck: vi.fn(), found: vi.fn(), call: vi.fn(), recall: vi.fn(), recallDrone: vi.fn(), confirmClue: vi.fn() },
        onAddClue: vi.fn(), onDecide: vi.fn(), now: () => now, map: <div />, review: null, reviewCount: 0,
      };
    };
    const { rerender } = render(<CommandView {...props(0)} />);
    // the two regions, found by role once (they stay mounted through every rerender: checked each minute by
    // identity); inside them plain selectors, since 81 accessible-name lookups over the whole console made
    // this test take ~5 s under load and time out (the cold test's CI, 2026-10-26)
    const resources = screen.getByRole("region", { name: "Resources" });
    const needsYou = screen.getByRole("region", { name: "Needs you" });
    let sawOverdue = false;
    for (let min = 0; min <= 80; min += 1) {
      act(() => rerender(<CommandView {...props(min)} />));
      const p = props(min);
      const now = p.now!();
      const board = teamOrder(p.teams, p.events, now, 30, p.timeline);
      const truth = new Set(overdueTeams(board).map((x) => x.team.id));
      sawOverdue ||= truth.size > 0;
      // the rows
      expect(resources.isConnected && needsYou.isConnected).toBe(true);
      // the team rows: every article with a team, as getAllByRole("article") gave them (none hidden)
      const rows = [...resources.querySelectorAll<HTMLElement>("article[data-team]")].filter((a) => !a.closest("[hidden], [aria-hidden='true']"));
      expect(new Set(rows.filter((r) => r.getAttribute("data-overdue") === "true").map((r) => r.getAttribute("data-team")))).toEqual(truth);
      // Needs you
      const items = [...needsYou.querySelectorAll("[data-need-kind='overdue']")].map((e) => e.getAttribute("data-need")!.replace("overdue-", ""));
      expect(new Set(items)).toEqual(truth);
      expect(new Set(needs([], p.teams, p.events, [], now, 30, 0, board).flatMap((n) => (n.kind === "overdue" ? [n.team.id] : [])))).toEqual(truth);
      // the minutes on the row's badge are Needs you's minutes
      for (const id of truth) {
        const m = Math.round(board.find((x) => x.team.id === id)!.heard.min!);
        expect(rows.find((r) => r.getAttribute("data-team") === id)).toHaveTextContent(`Overdue · not heard ${m} min`);
        expect(needsYou).toHaveTextContent(`not heard for ${m} min`);
      }
      // the toasts and the bell: an alert stands only for a team overdue now, and every team overdue now has one
      const { toasts, log } = useNotify.getState();
      const alerts = new Set(log.filter((n) => n.tone === "alert" && n.key.startsWith("overdue:")).map((n) => n.key.slice(8)));
      expect(alerts).toEqual(truth);
      for (const t of toasts.filter((x) => x.key.startsWith("overdue:"))) expect(truth.has(t.key.slice(8))).toBe(true);
    }
    expect(sawOverdue).toBe(true);
    // heard at 22:05 in the server's timeline only, on a team whose last_heard_at is old: not overdue (the cold test)
    expect(heard(teams[1]!, allEvents, new Date(at(T0, 66)), 30, allTimeline).overdue).toBe(false);
    // the bell kept the story: overdue, then heard again
    expect(useNotify.getState().log.some((n) => n.title === "Team Three heard again")).toBe(true);
    // 81 renders of the whole console: under 1 s alone now, but a loaded parallel run can stretch it past
    // the 5 s default; 20 s is room, not a different test
  }, 20_000);

  it("a team heard on the radio inside its check-in window is not overdue, whatever its stale last_heard_at says", () => {
    const t = team("T2", "Team Two", "searching", T0);
    expect(heard(t, [radioIn("r9", "Team Two", at(T0, 147))], new Date(at(T0, 148)), 30).overdue).toBe(false);
  });

  it("rows keep their order: out, then free, then off duty, the roster's order within", () => {
    const now = new Date(at(T0, 20));
    const teams = [team("T1", "Team One", "standby", null), team("T2", "Team Two", "searching", T0), team("T3", "Team Three", "off_duty", null), team("T4", "Team Four", "assigned", at(T0, 19))];
    const order = () => teamOrder(teams, [], now, 30).map((x) => x.team.id);
    expect(order()).toEqual(["T2", "T4", "T1", "T3"]);
    // a radio call, or minutes passing, never reorders them
    expect(teamOrder(teams, [radioIn("r1", "Team Four", at(T0, 20))], new Date(at(T0, 50)), 30).map((x) => x.team.id)).toEqual(["T2", "T4", "T1", "T3"]);
  });
});

describe("teams: returning counts down, the map and the list agree", () => {
  it("after a pass with no find the team walks back, its ETA counting down, then is free at base camp", () => {
    const user: MissionEvent[] = [{ id: "u1", type: "task.updated", at: T0, summary: "", ref: "B3", data: { sector_id: "B3", state: "assigned", team_id: "T3", poa: 0, pod: null, note: null, updated_at: T0 } as never }];
    const passes = passesFrom("s", null, user);
    const ctx = { centre: () => ({ lat: 49.369, lon: -122.944 }), subject: null, foundAt: null };
    const end = passes[0]!.end;
    const etas: number[] = [];
    for (let t = end; t < end + 10 * MIN; t += MIN) {
      const p = placeOf(passes, t, ctx);
      if (p.status === "returning") etas.push(p.eta!);
    }
    expect(etas.length).toBeGreaterThan(2);
    for (let i = 1; i < etas.length; i++) expect(etas[i]!).toBeLessThan(etas[i - 1]!);
    const home = placeOf(passes, end + 30 * MIN, ctx);
    expect(home.status).toBe("standby");
    expect(home.pos).toEqual({ lat: 49.373, lon: -122.949 });
  });

  it("a recall cuts the pass: no find, the team walks back from where it was", () => {
    const user: MissionEvent[] = [
      { id: "u1", type: "task.updated", at: T0, summary: "", ref: "C2", data: { sector_id: "C2", state: "assigned", team_id: "T1", poa: 0, pod: null, note: null, updated_at: T0 } as never },
      { id: "u2", type: "mission.note", at: at(T0, 8), summary: "Search manager recalled Team One to base camp", ref: "T1", data: { action: "recall", team: "T1" } as never },
    ];
    const passes = passesFrom("s", { sector: "C2", lat: 49.37, lon: -122.944 }, user);
    expect(passes[0]).toMatchObject({ cut: true, detected: false });
    expect(placeOf(passes, new Date(at(T0, 9)).getTime(), { centre: () => ({ lat: 49.369, lon: -122.944 }), subject: null, foundAt: null }).status).toBe("returning");
  });

  it("the guided search: teams that radioed clues from the field are out there, never 'Free · at base camp'", () => {
    const fx = fixture as unknown as Partial<MissionData> & { now: string };
    const full = { data: fx, now: fx.now };
    for (const clue of (fx.clues ?? []).filter((c) => c.reported_by !== "command")) {
      const s = demoAt(full, clue.at, [], { seed: "overdue-hiker" });
      const t = s.teams!.find((x) => x.id === clue.reported_by)!;
      expect(t.status).not.toBe("standby");
      expect(Math.abs(t.position!.lat - clue.lat)).toBeLessThan(0.0005);
    }
  });
});

describe("drones: physics by the clock", () => {
  const fx = fixture as unknown as Partial<MissionData> & { now: string };
  const drone = fx.fleet!.drones[0]!;
  const home = { lat: 49.373, lon: -122.949 };
  const leg = { ...fx.fleet!.legs[0]!, id: "L101", status: "flying" as const };
  const sent = new Date("2026-10-24T21:43:00Z").getTime();
  const fleet: FleetState = { ...fx.fleet!, drones: [drone], legs: [leg] };
  const all = flights([drone], [legSortie(leg, sent, "Search manager")], home);
  const at = (min: number) => fleetNow(fleet, all, sent + min * MIN, home, [leg]);

  it("a leg takes its flight time (not done the minute it is sent), drains the battery per minute flown, returns, lands", () => {
    expect(at(1).legs[0]!.status).toBe("flying");
    let last = 101;
    let saw = new Set<string>();
    for (let m = 0; m <= 40; m++) {
      const d = at(m).drones[0]!;
      saw.add(d.status);
      if (d.status === "flying" || d.status === "returning") {
        expect(d.battery_pct).toBeLessThan(last);
        last = d.battery_pct;
      }
    }
    expect([...saw]).toEqual(expect.arrayContaining(["flying", "returning", "idle"]));
    // about the leg's own minutes in the air, never two hours
    const f = all[0]!;
    expect((f.landed - f.sortie.start) / MIN).toBeGreaterThan(leg.est_minutes);
    expect((f.landed - f.sortie.start) / MIN).toBeLessThan(leg.est_minutes + 10);
    expect(at(5).drones[0]!.battery_pct).toBeCloseTo(100 - 5 * DRAIN_PCT_PER_MIN, 0);
    expect(at(40)).toMatchObject({ drones: [{ status: "idle", battery_pct: 100, leg_id: null, position: home }], legs: [{ status: "done" }] });
  });

  it("the guided search: no drone flies for two hours, every one at base camp long after its legs", () => {
    const full = { data: fx, now: fx.now };
    const s = demoAt(full, "2026-10-24T23:30:00Z", [], { seed: "overdue-hiker" });
    for (const d of s.fleet!.drones) expect(d.status === "idle" || d.status === "charging").toBe(true);
  });
});

describe("every approval names the approver; one assignment is one line", () => {
  const fx = fixture as unknown as Partial<MissionData> & { now: string };
  const full = { data: fx, now: fx.now };
  it("guided: the survey's legs are auto-approved (guided survey); the visitor's approvals say You", () => {
    const p = fx.proposals!.find((x) => x.id === "p002")!;
    const when = "2026-10-24T21:42:30Z";
    const user: MissionEvent[] = [
      { id: "u1", type: "proposal.decided", at: when, summary: "", ref: "p002", data: { ...p, status: "approved", decided_by: "Search manager", decided_at: when } as never },
      { id: "u2", type: "task.updated", at: when, summary: "", ref: "C2", data: { sector_id: "C2", state: "assigned", team_id: "T1", poa: 0, pod: null, note: null, updated_at: when } as never },
      { id: "u3", type: "mission.note", at: when, summary: "Search manager assigned C2 to Team One", ref: "C2", data: { action: "assign", by: "Search manager", team: "T1", sector: "C2" } as never },
    ];
    const s = demoAt(full, "2026-10-24T22:30:00Z", user, { seed: "overdue-hiker" });
    const lines = buildTimeline(s.events ?? [], s.teams ?? [], s.timeline ?? []);
    // an approval line (not "flies its approved leg"): a decision on a proposal or a leg
    const approvals = lines.filter((e) => /approved the AI|approved for|auto-approved|approved by|approved in turn|flight line approved|approved \(/i.test(e.text));
    expect(approvals.length).toBeGreaterThan(2);
    // the scenario's own flight lines, with no survey decision in this run: pre-planned, never "auto-approved"
    for (const e of approvals) expect(e.text).toMatch(/^You approved|auto-approved: guided survey, you chose|pre-planned in the scenario, before you took over|\(by the search manager\)|approved by |standing approval/);
    // one line for the assignment, not three
    expect(lines.filter((e) => /C2/.test(e.text) && /assigned|approved/.test(e.text) && !/auto-approved/.test(e.text))).toHaveLength(1);
  });

  it("an edit to another team logs the team that went", () => {
    const p = fx.proposals!.find((x) => x.id === "p002")!;
    const e: MissionEvent = { id: "u1", type: "proposal.decided", at: "2026-10-24T21:43:00Z", summary: "", ref: "p002", data: { ...p, status: "approved", decided_by: "Search manager", decided_at: "2026-10-24T21:43:00Z", edits: { team: "T4" } } as never };
    const [line] = buildTimeline([e], fx.teams ?? []);
    expect(line!.text).toBe("You approved the AI's suggestion: Assign sector C2 to Team Four (edited from Team One)");
    expect(line!.team).toBe("T4");
  });

  it("a clue's detail says who and how once", () => {
    const c = { id: "c9", kind: "object", text: "glove", lat: 0, lon: 0, radius_m: 25, at: T0, reported_by: "command", source: "form", reliability: "medium", confirmed: true, at_team_position: false, confirmed_by_turn: null } as unknown as Clue;
    const [line] = buildTimeline([{ id: "e1", type: "clue.added", at: T0, summary: "", ref: "c9", data: c as never }], []);
    expect(line!.detail).toBe("logged at the command post · medium reliability · confirmed");
  });
});

describe("a sighting changes the plan", () => {
  const fx = fixture as unknown as Partial<MissionData> & { now: string };
  const full = { data: fx, now: fx.now };
  const sightAt = "2026-10-24T21:31:00Z";
  const sighting: MissionEvent = {
    id: "u9", type: "clue.added", at: sightAt, summary: "sighting", ref: "s-f0336-d01",
    data: { id: "s-f0336-d01", kind: "sighting", text: "person confirmed by the image reviewer in f0336 (f0336-d01, detector 0.82)", lat: 49.3687, lon: -122.9441, radius_m: 10, at: sightAt, at_team_position: false, reliability: "high", reported_by: "command", source: "form", confirmed: true, confirmed_by_turn: null } as never,
  };
  it("the agent proposes sending the nearest team to it, and its next proposals cite it", () => {
    const s = demoAt(full, "2026-10-24T21:45:00Z", [sighting], { seed: "overdue-hiker" });
    const send = s.proposals!.find((p) => p.id === "sight-s-f0336-d01")!;
    expect(send).toMatchObject({ status: "pending", kind: "assign_sector" });
    expect(send.summary).toMatch(/^Send Team \w+ to the sighting in [A-D]\d \(\+16 min\)$/);
    expect(send.reason).toMatch(/nearest team/);
    const p002 = s.proposals!.find((p) => p.id === "p002")!;
    expect(p002.reason).toMatch(/possible sighting in [A-D]\d waits for a team/);
    // not the team the first assignment asks for, while another can go
    expect(send.target.team).not.toBe(p002.target.team);
  });

  it("in the guided search it is never hidden by the step's pointer, nor counted in 'N more after this step'", () => {
    const p = (id: string, team: string, sector: string) => ({ ...fx.proposals!.find((x) => x.id === "p002")!, id, status: "pending" as const, decided_at: null, decided_by: null, target: { team, sector }, summary: `Send ${team} to the sighting in ${sector} (+16 min)` });
    render(
      <NeedsYou proposals={[p("sight-s-x", "T2", "C3"), p("p002", "T1", "C2")]} teams={fx.teams ?? []} drones={[]} events={[]} clues={[]} now={new Date("2026-10-24T21:45:00Z")} checkInMin={30} onDecide={vi.fn()} imageUrl={(r) => r} review={null} reviewCount={0} onCall={vi.fn()} onRecall={vi.fn()} onConfirmClue={vi.fn()} highlight="review" />,
    );
    const group = screen.getByRole("group", { name: "Possible sighting" });
    const card = group.querySelector("[data-proposal='sight-s-x']")!;
    expect(card).not.toHaveAttribute("data-dimmed");
    expect(card.className).not.toMatch(/\bhidden\b/);
    expect(within(group).getByRole("button", { name: /Send Team Two to the sighting/ })).toBeInTheDocument();
    // the hidden one is the C2 proposal, and only it
    expect(screen.getByRole("note")).toHaveTextContent("1 more after this step");
  });
});
