import { describe, expect, it } from "vitest";
import type { Clue, MissionEvent, Proposal, SectorTask, Team, TimelineEvent } from "../contract";
import { buildTimeline, fromEvent, inFilter, plain, teamOf } from "./timeline";

const AT = "2026-10-24T21:40:00Z";
const TEAMS = [{ id: "T1", callsign: "Team One" }, { id: "T2", callsign: "Team Two" }] as Team[];
const ev = (id: string, type: MissionEvent["type"], data: unknown, summary = "", at = AT, ref: string | null = null): MissionEvent => ({ id, type, at, summary, ref, data: data as MissionEvent["data"] });
const turn = (direction: "in" | "out", callsign: string, transcript: string) => ({ id: "r1", direction, callsign, transcript, reply: "Team Two, Sightline. Copy.", audio: null, state: "committed", actions: [], asr_ms: null, llm_ms: null, tts_ms: null, at: AT });

describe("the timeline", () => {
  it("reads a radio turn as the team's words, with Sightline's reply under it", () => {
    const e = fromEvent(ev("e1", "radio.turn", turn("in", "Team Two", "Blue bottle by the creek, over. (typed for the demo fixture)")), TEAMS)!;
    expect(e).toMatchObject({ kind: "radio", team: "T2", text: "Team Two: Blue bottle by the creek, over.", detail: "Sightline: Team Two, Sightline. Copy." });
    expect(fromEvent(ev("e2", "radio.turn", turn("out", "Team One", "return to base camp")), TEAMS)!.text).toBe("To Team One: return to base camp");
  });

  it("offers Confirm only on a clue awaiting read-back", () => {
    const c = { id: "c009", kind: "object", text: "glove", reported_by: "T1", source: "radio", reliability: "high", confirmed: false } as Clue;
    expect(fromEvent(ev("e1", "clue.added", c), TEAMS)!.clue?.id).toBe("c009");
    expect(fromEvent(ev("e1", "clue.added", { ...c, confirmed: true }), TEAMS)!.clue).toBeNull();
  });

  it("says decisions in words, the agent's and the search manager's alike, without the fixture's script notes", () => {
    const p = { id: "p003", status: "approved", decided_by: "Search manager (scripted for the demo fixture)", summary: "Assign sector C2 to Team One", target: { sector: "C2", team: "T1" }, decision_reason: null } as unknown as Proposal;
    expect(fromEvent(ev("e1", "proposal.decided", p), TEAMS)!.text).toBe("Search manager approved agent p003: Assign sector C2 to Team One");
    const direct = fromEvent(ev("e2", "mission.note", { action: "assign", by: "Dana", team: "T2", sector: "B3" }, "Dana assigned B3 to Team Two", AT, "B3"), TEAMS)!;
    expect(direct).toMatchObject({ kind: "decision", text: "Dana assigned B3 to Team Two", team: "T2", sector: "B3" });
    const searched = fromEvent(ev("e3", "task.updated", { sector_id: "B4", state: "searched", team_id: "T1", pod: 0.6 } as SectorTask), TEAMS)!;
    expect(searched).toMatchObject({ kind: "checkin", text: "B4 searched at POD 60 % (Team One)" });
  });

  it("leaves out the news: each photo, each map step, each position report of a flight", () => {
    expect(fromEvent(ev("e1", "photo.processed", null, "f0042 processed"), TEAMS)).toBeNull();
    expect(fromEvent(ev("e1", "photo.processed", null, "f0001 processed (the flight starts)"), TEAMS)!.text).toBe("Survey photos: the flight starts");
    expect(fromEvent(ev("e1", "map.updated", { seq: 1 }), TEAMS)).toBeNull();
    expect(fromEvent(ev("e1", "fleet.updated", {}, "D1 on L005"), TEAMS)).toBeNull();
    expect(fromEvent(ev("e1", "fleet.updated", {}, "L005 for Drone 1 over B3 (sent by Dana)"), TEAMS)!.kind).toBe("drone");
  });

  it("merges repeats into the newest line, newest first, and filters by chip", () => {
    const relay = (id: string, at: string) => ev(id, "mission.note", { relay: { team_id: "T2" } }, "Team Two heard via D3, just now (simulated relay)", at);
    const t = buildTimeline([relay("e1", "2026-10-24T21:55:00Z"), relay("e2", "2026-10-24T21:57:00Z"), relay("e3", "2026-10-24T21:59:00Z")], TEAMS);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ id: "e3", repeats: 3, text: "Team Two heard via D3, just now", kind: "checkin" });
    expect(inFilter(t[0]!, "Radio")).toBe(true);
    expect(inFilter(t[0]!, "Decisions")).toBe(false);
  });

  it("shows the server's timeline, and the events it does not cover (a direct action just taken)", () => {
    const server: TimelineEvent[] = [{ id: "e9", at: AT, kind: "found", team: "Team One", sector: "C2", text: "Team One has the subject in C2", refs: [] }];
    const t = buildTimeline([ev("e9", "radio.turn", turn("in", "Team One", "on scene")), ev("u1", "radio.turn", turn("in", "Team Two", "hello"))], TEAMS, server);
    expect(t.map((e) => [e.id, e.kind, e.team])).toEqual([["u1", "radio", "T2"], ["e9", "found", "T1"]]); // e9 is the server's; u1 (the console's own) it has not sent
    expect(teamOf(TEAMS, "team two")).toBe("T2");
  });
});

describe("the demo's per-line notes", () => {
  it("are left to the one disclosure chip", () => {
    expect(plain("Subject found by Team One in sector C2 (by Search manager (scripted for the demo fixture))")).toBe("Subject found by Team One in sector C2 (by Search manager)");
    expect(plain("Sightline, Team One. Subject located, over. (typed for the demo fixture)")).toBe("Sightline, Team One. Subject located, over.");
    expect(plain("Team Two heard via D3, just now (simulated relay)")).toBe("Team Two heard via D3, just now");
  });
});
