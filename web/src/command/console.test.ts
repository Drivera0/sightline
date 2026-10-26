import { describe, expect, it } from "vitest";
import type { Clue, Conditions, MissionEvent, Proposal, Team } from "../contract";
import { daylightMin, duration, elapsedMin, etaMin, flyWord, heard, lastHeard, needs, peopleOut } from "./console";

const NOW = new Date("2026-10-24T22:00:00Z");
const team = (id: string, callsign: string, status: Team["status"], over: Partial<Team> = {}): Team => ({ id, callsign, members: 3, status, position: null, position_at: null, note: null, ...over });

describe("the command post's arithmetic", () => {
  it("elapsed, daylight and flyability in one word", () => {
    expect(duration(85)).toBe("1 h 25 min");
    expect(duration(7)).toBe("7 min");
    expect(elapsedMin({ created_at: "2026-10-24T20:30:00Z" }, NOW)).toBe(90);
    const c = { civil_twilight_end: "2026-10-25T01:36:00Z", flyable: true, flyable_until: "2026-10-25T01:36:00Z", flyability_reason: "gusts 15" } as Conditions;
    expect(daylightMin(c, NOW)).toBe(216);
    expect(flyWord(c, "America/Vancouver")).toMatchObject({ word: "Drones can fly until 18:36", tone: "ok" });
    expect(flyWord({ ...c, flyable: false, flyability_reason: "gusts 50" }, true)).toMatchObject({ word: "Drones grounded", tone: "alert", reason: "gusts 50" });
    expect(flyWord(null, true).word).toBe("Drone flying: not known");
  });

  it("counts the people in the field", () => {
    expect(peopleOut([team("T1", "One", "searching"), team("T2", "Two", "returning"), team("T3", "Three", "standby")])).toEqual({ people: 6, teams: 2 });
  });

  it("hears a team on its radio turns and check-ins, never its position", () => {
    const t = team("T2", "Team Two", "searching", { position_at: "2026-10-24T21:59:00Z" });
    const events = [
      { id: "e1", type: "radio.turn", at: "2026-10-24T21:37:48Z", ref: "r4", summary: "", data: { direction: "in", callsign: "Team Two" } },
      { id: "e2", type: "mission.note", at: "2026-10-24T21:41:00Z", ref: "T2", summary: "", data: { relay: { team_id: "T2" } } },
      { id: "e3", type: "radio.turn", at: "2026-10-24T21:50:00Z", ref: "r5", summary: "", data: { direction: "out", callsign: "Team Two" } },
    ] as unknown as MissionEvent[];
    expect(lastHeard(t, events)).toBe("2026-10-24T21:41:00Z");
    expect(heard(t, events, NOW, 30)).toEqual({ at: "2026-10-24T21:41:00Z", min: 19, overdue: false, due: false });
    expect(heard(t, events, NOW, 25)).toMatchObject({ overdue: false, due: true });
    expect(heard(t, events, NOW, 15)).toMatchObject({ overdue: true });
    expect(heard({ ...t, last_heard_at: "2026-10-24T21:58:00Z" }, events, NOW).min).toBe(2); // the newest wins: the server's field
    expect(heard({ ...t, last_heard_at: "2026-10-24T21:00:00Z" }, events, NOW).min).toBe(19); // and a newer radio call beats an old field (the cold test)
    expect(heard(team("T4", "Four", "standby"), [], NOW, 1)).toEqual({ at: null, min: null, overdue: false, due: false }); // at base: never overdue
  });

  it("puts a returning team's ETA at its walk back to base camp", () => {
    const t = team("T1", "One", "returning", { position: { lat: 49.3775, lon: -122.949 } });
    expect(etaMin(t, { lat: 49.373, lon: -122.949 })).toBe(10); // 500 m at 3 km/h
    expect(etaMin({ ...t, eta_min: 25 }, null)).toBe(25);
    expect(etaMin({ ...t, status: "searching" }, { lat: 49.373, lon: -122.949 })).toBeNull();
  });

  it("needs: proposals newest first, then candidates, overdue teams, clues to read back", () => {
    const p = (id: string, at: string, status: Proposal["status"] = "pending") => ({ id, created_at: at, status }) as Proposal;
    const late = team("T3", "Three", "searching", { last_heard_at: "2026-10-24T21:00:00Z" });
    const clue = { id: "c9", confirmed: false, reported_by: "T3" } as Clue;
    const n = needs([p("p1", "2026-10-24T21:00:00Z"), p("p2", "2026-10-24T21:30:00Z"), p("p3", AT0, "approved")], [late], [], [clue], NOW, 30, 4);
    expect(n.map((x) => x.id)).toEqual(["p2", "p1", "review", "overdue-T3", "clue-c9"]);
  });
});
const AT0 = "2026-10-24T20:00:00Z";
