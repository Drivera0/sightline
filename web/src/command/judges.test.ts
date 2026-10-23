// What three cold judges found on the live site (2026-10-23), each fixed and held here.
import { describe, expect, it } from "vitest";
import type { MissionEvent, SectorTask, Team } from "../contract";
import { heard, outsideGrid, withTaskStatus } from "./console";
import { overdueToast } from "./notifications";

const team = (id: string, status: Team["status"], last: string | null = null): Team => ({ id, callsign: `Team ${id}`, members: 3, status, position: null, position_at: null, note: null, last_heard_at: last });
const task = (sector: string, state: SectorTask["state"], team_id: string | null): SectorTask => ({ sector_id: sector, state, team_id, poa: 0, pod: null, note: null, updated_at: "2026-10-24T21:50:00Z" });
const NOW = new Date("2026-10-24T22:00:00Z");

describe("judges 2026-10-23", () => {
  it("(1) a team in the field past its check-in is overdue, and says so in a toast", () => {
    const out = team("T3", "searching", "2026-10-24T20:48:00Z");
    expect(heard(out, [] as MissionEvent[], NOW, 30)).toMatchObject({ overdue: true });
    expect(overdueToast(out, 72, 30)).toMatchObject({ tone: "alert", title: "Team T3 is overdue", body: expect.stringContaining("Not heard for 72 min, past the 30-minute check-in") });
    // at base camp there is no check-in to keep
    expect(heard(team("T3", "standby", "2026-10-24T20:48:00Z"), [], NOW, 30).overdue).toBe(false);
  });

  it("(7) the probability outside the grid is shown, so the sectors' POA adds up", () => {
    expect(outsideGrid([{ poa: 0.1 }, { poa: 0.15 }])).toBeCloseTo(0.75);
    expect(outsideGrid([])).toBeNull();
  });

  it("(4) a team's status follows its tasks: assigned, searching", () => {
    const teams = [team("T4", "standby"), team("T1", "standby"), team("T2", "returning")];
    const tasks = [task("C4", "searched", "T4"), task("B4", "in_progress", "T4"), task("C2", "assigned", "T1"), task("B2", "in_progress", "T2")];
    expect(withTaskStatus(teams, tasks).map((t) => t.status)).toEqual(["searching", "assigned", "returning"]);
    expect(withTaskStatus([team("T4", "standby")], [task("C4", "searched", "T4")])[0]!.status).toBe("standby");
  });
});
