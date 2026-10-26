// The log says exactly what was chosen (round 2 of the cold usability test, 2026-10-25: "it still does
// things I didn't say"). Log without mapping moves nothing; an edited team is the button's team; "edited
// from" only when it changed; Watch instead's decisions are its own; one sighting proposal per place, never
// dropped without a logged outcome; after the find the stat stays and open items close in the log; every
// move in a guided run names who decided it. Built by lane A.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clue, MapUpdate, MissionEvent, Proposal, Team } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import { ApprovalInbox } from "./ApprovalInbox";
import { needs, sectorAt, subjectWord, WATCH_BY } from "./console";
import { activeInject, agentOption, choiceFor, currentCard, hastyFact, injects, sendAllLabel, standingUser, type Choice, type GuideInput } from "./guide";
import { guidedOptsFor } from "./GuideRun";
import { closedOnFind, demoAt, legApprover, placeOf, subjectOf, type DemoFull } from "./missionTime";
import { passesFrom } from "./sim";
import { SECOND_LOOK_ID } from "./demoReview";
import { STORY_NOT_A_PERSON, storyClue, storyProposal } from "./storyCopy";
import { buildTimeline } from "./timeline";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[] };
const fx = demo as unknown as Fixture;
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f${String(k + 1).padStart(4, "0")}`, cells: [], canopy: null, at: "2026-10-24T20:30:00Z" }));
const full: DemoFull = { now: fx.now, data: { ...fx, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] } };
const SEED = "overdue-hiker";
const queue = [
  { id: "f0336-d01", conf: 0.82 },
  { id: SECOND_LOOK_ID, conf: 0.17 },
  { id: STORY_NOT_A_PERSON, conf: 0.47 },
];
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const ms = (s: string) => new Date(s).getTime();
let seq = 0;
const ev = (type: MissionEvent["type"], at: number | string, data: unknown, summary = "", ref: string | null = null): MissionEvent => ({ id: `u${String(++seq).padStart(4, "0")}`, type, at: typeof at === "string" ? at : iso(at), summary, ref, data: data as never });
const sightingAt = (id: string, at: number, lat: number, lon: number): MissionEvent =>
  ev("clue.added", at, { id, kind: "sighting", text: `person confirmed in photo ${id}`, lat, lon, radius_m: 10, at: iso(at), at_team_position: false, reliability: "high", reported_by: "command", source: "form", confirmed: true, confirmed_by_turn: null }, "sighting", id);

beforeEach(() => sessionStorage.clear());

describe("Log without mapping: logged as unconfirmed, the map unchanged", () => {
  const clue = storyClue(full)!;
  const p = storyProposal(full)!;
  const at = ms(p.created_at) + 30_000;
  // what the console emits for "Log without mapping" (GuideRun perform)
  const logged = ev("clue.added", ms(clue.at) + 60_000, { ...clue, confirmed: false, logged: true, decided_by: "Search manager" }, `${clue.id} logged without mapping`, clue.id);
  const choices = [{ inject: "clue", option: "log" }];

  it("does not confirm the clue, holds its map update, and leaves Needs you", () => {
    const opts = guidedOptsFor(full, SEED, choices, [logged]);
    expect(opts.mapClue).toBe(false);
    const s = demoAt(full, iso(at), [logged], opts) as MissionData;
    const c = s.clues.find((x) => x.id === clue.id)!;
    expect(c.confirmed).toBe(false);
    expect(s.mapUpdates.some((u) => u.source === "clue" && u.ref === clue.id)).toBe(false);
    expect(needs(s.proposals, s.teams, s.events, s.clues, new Date(at)).some((n) => n.id === `clue-${clue.id}`)).toBe(false);
    const line = buildTimeline(s.events, s.teams, s.timeline).find((e) => e.kind === "clue" && e.refs.includes(clue.id) && /logged/.test(e.detail ?? ""))!;
    expect(line.detail).toMatch(/logged without mapping by you: not confirmed, the map unchanged/);
    expect(line.detail).not.toMatch(/· confirmed/);
  });

  it("the agent's card and its log line stop citing it as what raised the sector", () => {
    const s = demoAt(full, iso(at), [logged], guidedOptsFor(full, SEED, choices, [logged])) as MissionData;
    const card = s.proposals.find((x) => x.id === p.id)!;
    expect(card.reason).not.toMatch(new RegExp(`${clue.id} \\(`));
    expect(card.reason).toMatch(/logged without mapping: it moved nothing on the map/);
    const said = s.events.find((e) => e.type === "proposal.new" && e.ref === p.id)?.data as unknown as Proposal | undefined;
    if (said) expect(said.reason).not.toMatch(new RegExp(`${clue.id} \\(`));
    // the share it states is the one the map shows
    const pct = /^(\w+) · ([\d.]+) %/.exec(card.reason);
    if (pct) expect(Number(pct[2])).toBeCloseTo(s.sectors.find((x) => x.sector_id === pct[1])!.poa * 100, 1);
  });
});

describe("the card's buttons and the log say the team that was chosen", () => {
  const team = (id: string, callsign: string): Team => ({ id, callsign, members: 3, status: "standby", position: null, position_at: null, note: null });
  const TEAMS = [team("T1", "Team One"), team("T2", "Team Two"), team("T4", "Team Four")];
  const prop = (over: Partial<Proposal> = {}): Proposal => ({
    id: "p002", kind: "assign_sector", summary: "Assign sector C2 to Team One", reason: "C2 holds the most.", briefing: "Team One, Sightline. New assignment: sector C2. Over.",
    target: { team: "T1", sector: "C2" }, evidence: [], status: "pending", created_by: "agent", created_at: "2026-10-24T21:42:00Z", decided_at: null, decided_by: null, decision_reason: null, edits: null, ...over,
  });

  it("after Edit to Team Four the main button reads 'Send only Team Four to C2', and the radio goes to Team Four", async () => {
    const onDecide = vi.fn();
    const lead = { id: "p002", label: "Send all 4 free teams to the AI's picks", onClick: vi.fn(), second: "Send only Team One to C2" };
    render(<ApprovalInbox proposals={[prop()]} teams={TEAMS} onDecide={onDecide} imageUrl={(r) => r} lead={lead} />);
    await userEvent.click(screen.getByRole("button", { name: /Edit team or briefing/ }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "T4");
    expect(screen.queryByRole("button", { name: /Send only Team One/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send all/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Send only Team Four to C2/ }));
    expect(lead.onClick).not.toHaveBeenCalled();
    expect(onDecide).toHaveBeenCalledWith("p002", "approve", "Search manager", undefined, { team: "T4", briefing: "Team Four, Sightline. New assignment: sector C2. Over." });
  });

  it("an unedited approval sends no edit, even when the agent re-planned the team after the card opened", async () => {
    const onDecide = vi.fn();
    const { rerender } = render(<ApprovalInbox proposals={[prop()]} teams={TEAMS} onDecide={onDecide} imageUrl={(r) => r} />);
    rerender(<ApprovalInbox proposals={[prop({ target: { team: "T2", sector: "C2" }, summary: "Assign sector C2 to Team Two" })]} teams={TEAMS} onDecide={onDecide} imageUrl={(r) => r} />);
    await userEvent.click(screen.getByRole("button", { name: /Send Team Two to C2/ }));
    expect(onDecide).toHaveBeenCalledWith("p002", "approve", "Search manager", undefined, undefined);
  });

  it("'(edited from X)' only when the team changed; Watch instead's decisions say 'Watch instead chose'", () => {
    const at = "2026-10-24T21:43:00Z";
    const decided = (over: Partial<Proposal>) => ev("proposal.decided", at, { ...prop(), status: "approved", decided_at: at, decided_by: "Search manager", ...over }, "", "p002");
    const same = buildTimeline([decided({ edits: { team: "T1" } })], TEAMS)[0]!;
    expect(same.text).toBe("You approved the AI's suggestion: Assign sector C2 to Team One");
    const changed = buildTimeline([decided({ edits: { team: "T4" } })], TEAMS)[0]!;
    expect(changed.text).toBe("You approved the AI's suggestion: Assign sector C2 to Team Four (edited from Team One)");
    const watched = buildTimeline([decided({ decided_by: WATCH_BY })], TEAMS)[0]!;
    expect(watched.text).toBe("Watch instead chose the AI's suggestion: Assign sector C2 to Team One");
    expect(watched.text).not.toMatch(/You approved/);
    const found = buildTimeline([ev("mission.note", at, { action: "found", by: WATCH_BY, mission: { found: { team: "T1" } } }, "Found: Team One has the subject in C2", "C2")], TEAMS)[0]!;
    expect(found.text).toBe("Found: Team One has the subject in C2 (Watch instead chose it)");
  });
});

describe("sightings: one proposal per place, never dropped without a logged outcome", () => {
  const subject = subjectOf(full)!;
  const p = storyProposal(full)!;
  const t = ms(p.created_at) - 10 * 60_000;
  // two photos of the same place, a few metres apart (the cold test: two cards, two distances)
  const two = [sightingAt("s-a", t, subject.lat, subject.lon), sightingAt("s-b", t + 1000, subject.lat + 0.0001, subject.lon + 0.0001)];
  const where = sectorAt(full.data.sectors ?? [], subject)!;

  it("two sightings in one sector make one proposal, the nearest team at its distance", () => {
    const s = demoAt(full, iso(ms(p.created_at)), two, { seed: SEED }) as MissionData;
    const cards = s.proposals.filter((x) => x.id.startsWith("sight-") && x.target.sector === where);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.reason).toMatch(/on 2 survey photos/);
    const m = Number(/\((\d+) m,/.exec(cards[0]!.reason)?.[1]);
    const team = s.teams.find((x) => x.id === cards[0]!.target.team)!;
    const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) * 111_320;
    const nearest = Math.min(...two.map((e) => metres(team.position!, e.data as unknown as Clue)));
    expect(Math.abs(m - nearest)).toBeLessThanOrEqual(1);
  });

  it("Send all names the sighting while it waits, and its free count leaves out the returning teams", () => {
    const list = injects({ full, seed: SEED, user: two, choices: [], queue });
    const a = list.find((i) => i.key === "assign")!;
    expect(a.options[0]!.label).toMatch(new RegExp(`the nearest one to the sighting in ${where} first$`));
    expect(a.options[0]!.label).toMatch(/^Send the 2 free teams and the 2 returning ones/);
    expect(sendAllLabel(2, "Team One", "C2", { returning: 2 })).toBe("Send the 2 free teams and the 2 returning ones to the AI's picks now");
  });

  it("a team sent there another way supersedes it, and the log says so", () => {
    const s0 = demoAt(full, iso(ms(p.created_at)), two, { seed: SEED }) as MissionData;
    const card = s0.proposals.find((x) => x.id.startsWith("sight-") && x.target.sector === where)!;
    const sent = ev("task.updated", ms(p.created_at) + 60_000, { sector_id: where, state: "assigned", team_id: "T3", poa: 0, pod: null, note: null, updated_at: iso(ms(p.created_at) + 60_000) });
    const s = demoAt(full, iso(ms(p.created_at) + 2 * 60_000), [...two, sent], { seed: SEED }) as MissionData;
    const after = s.proposals.find((x) => x.id === card.id)!;
    expect(after.status).toBe("superseded");
    expect(after.decision_reason).toBe("superseded: Team Three sent to the sighting");
    expect(s.timeline.some((e) => e.text === `Sighting in ${where}: superseded: Team Three sent to the sighting`)).toBe(true);
  });
});

describe("after the find", () => {
  it("the Subject stat reads 'Found 15:27 · C2'", () => {
    expect(subjectWord([], () => "15:27", { at: "2026-10-24T22:27:00Z", sector: "C2" })).toBe("Found 15:27 · C2");
  });

  it("the finding team is on the carry-out, the others walk back", () => {
    const subject = subjectOf(full)!;
    const t0 = ms("2026-10-24T21:45:00Z");
    const user = [ev("task.updated", t0, { sector_id: "A1", state: "assigned", team_id: "T3", poa: 0, pod: null, note: null, updated_at: iso(t0) })];
    const other = passesFrom(SEED, subject, user)[0]!;
    const foundAt = other.arrive + 60_000;
    const ctx = { centre: () => ({ lat: 49.38, lon: -122.95 }), subject, foundAt };
    expect(placeOf([other], foundAt + 60_000, ctx).status).toBe("returning");
    const hit = { ...other, sector: subject.sector, detected: true, end: foundAt - 1000 };
    expect(placeOf([hit], foundAt + 60_000, ctx).note).toBe("carry-out");
  });

  it("open proposals and clues close with 'closed: subject found', each one logged", () => {
    const at = "2026-10-24T22:00:00Z";
    const s = demoAt(full, at, [], { seed: SEED }) as MissionData;
    const open = s.proposals.filter((x) => x.status === "pending");
    expect(open.length).toBeGreaterThan(0);
    const found = ev("mission.note", at, { action: "found", by: "Search manager", mission: { ...s.mission, status: "found", found: { team: "T1", sector: "C2", lat: 0, lon: 0, at } } }, "Found", "C2");
    const c = closedOnFind(s, [found]);
    expect(c.proposals.filter((x) => x.status === "pending")).toHaveLength(0);
    for (const x of open) {
      expect(c.proposals.find((y) => y.id === x.id)!.decision_reason).toBe("closed: subject found");
      expect(c.timeline.some((e) => e.text.startsWith("Closed: subject found") && e.text.includes(x.summary))).toBe(true);
    }
  });
});

describe("every move in a guided run says who decided it", () => {
  it("names the hasty search as a fact in the first step, pre-planned", () => {
    const first = injects({ full, seed: SEED, user: [], choices: [], queue })[0]!;
    expect(hastyFact(full)).toMatch(/^Teams One and Two are already out on a hasty search along the trail \(sent at the call, 13:35: pre-planned in the scenario, before you took over\)\. $/);
    expect(first.prompt.startsWith(hastyFact(full))).toBe(true);
    expect(legApprover(null)).toBe("pre-planned in the scenario, before you took over");
    expect(legApprover({ option: "serpentine", watched: false })).toBe("auto-approved: guided survey, you chose the lawnmower pattern");
    expect(legApprover({ option: "serpentine", watched: true })).toMatch(/Watch instead chose the lawnmower pattern/);
    expect(legApprover({ option: "planner", watched: true })).toMatch(/Watch instead chose/);
  });

  for (const watch of [false, true])
    it(`${watch ? "Watch instead" : "the visitor"}: every team or drone move in the log has its approver or source`, () => {
      const by = watch ? WATCH_BY : "Search manager";
      const choices: Choice[] = [];
      const mine: MissionEvent[] = [];
      let user: MissionEvent[] = [];
      for (let guard = 0; guard < 80; guard++) {
        user = standingUser(full, SEED, mine, choices);
        const input: GuideInput = { full, seed: SEED, user, choices, queue };
        const i = activeInject(injects(input), choices);
        if (!i) break;
        const card = currentCard(i, choices);
        const opt = agentOption(i, card).id;
        choices.push(choiceFor(i, opt, i.at, card, watch));
        // what the console emits for each decision (GuideRun perform, the store's decide/assign/found)
        if (i.id === "assign") {
          const p = i.key === "assign" ? storyProposal(full)! : (demoAt(full, iso(i.at + 1000), user, { seed: SEED }).proposals ?? []).find((x) => x.id === i.proposal)!;
          if (p?.target.team && p.target.sector) {
            mine.push(ev("proposal.decided", i.at, { ...p, status: "approved", decided_by: by, decided_at: iso(i.at) }, "", p.id));
            mine.push(ev("task.updated", i.at, { sector_id: p.target.sector, state: "assigned", team_id: p.target.team, poa: 0, pod: null, note: null, updated_at: iso(i.at) }));
            mine.push(ev("mission.note", i.at, { action: "assign", by, team: p.target.team, sector: p.target.sector }, `${by} assigned ${p.target.sector} to ${p.target.team}`, p.target.sector));
          }
        }
        if (i.id === "find" && i.find) mine.push(ev("mission.note", i.at, { action: "found", by, mission: { ...full.data.mission, status: "found", found: { team: i.find.team, sector: i.find.sector, lat: 0, lon: 0, at: iso(i.at) } } }, "Found", i.find.sector));
      }
      expect(choices.at(-1)!.inject).toBe("find");
      const end = ms(user.find((e) => (e.data as { action?: string } | null)?.action === "found")!.at) + 60_000;
      const s = demoAt(full, iso(end), user, guidedOptsFor(full, SEED, choices, user)) as MissionData;
      const lines = buildTimeline(s.events, s.teams, s.timeline);
      // a move: a team assigned or sent out, a flight line approved or re-tasked
      const moves = lines.filter((e) => /\bassigned\b|out on a hasty search|flight line approved|approved the AI|chose the AI|re-task|sent elsewhere/i.test(e.text));
      expect(moves.length).toBeGreaterThan(3);
      for (const e of moves) expect(e.text, e.text).toMatch(watch ? /Watch instead|pre-planned in the scenario/ : /^You |\bYou\b|you chose|pre-planned in the scenario|your standing approval/);
      for (const e of moves) if (watch) expect(e.text, e.text).not.toMatch(/^You approved|your standing approval/);
    });
});
