import { describe, expect, it } from "vitest";
import type { Mission, MissionEvent, Proposal, SectorTask, Team } from "../contract";
import { EMPTY } from "../lib/mission";
import { buildReport, reportMarkdown } from "./report";

const mission = {
  mission_id: "demo", name: "Mount Seymour (demo)", created_at: "2026-10-24T20:30:00Z", subject: "adult, red jacket, day hiker",
  area: { name: "Mount Seymour", lkp: { lat: 49.37, lon: -122.945 } }, status: "found",
  found: { team: "T1", sector: "C2", lat: 49.3712, lon: -122.9438, at: "2026-10-24T22:10:00Z" },
} as Mission;
const ev = (id: string, type: MissionEvent["type"], at: string, data: unknown, summary = ""): MissionEvent => ({ id, type, at, summary, ref: null, data: data as MissionEvent["data"] });

describe("the after-action report", () => {
  it("has the sections in order, built from the store", () => {
    const events = [
      ev("e1", "photo.processed", "2026-10-24T20:42:01Z", null, "f0001 processed (the flight starts)"),
      ev("e2", "clue.added", "2026-10-24T21:36:00Z", { id: "c002", kind: "track", text: "boot prints", reported_by: "T1", source: "form", confirmed: true }),
      ev("e3", "proposal.decided", "2026-10-24T21:43:00Z", { id: "p003", status: "approved", decided_by: "Dana", summary: "Assign sector C2 to Team One", target: {} } as unknown as Proposal),
      ev("e4", "radio.turn", "2026-10-24T21:50:00Z", { id: "r1", direction: "in", callsign: "Team One", transcript: "on scene", reply: null }),
      ev("e5", "mission.note", "2026-10-24T22:10:00Z", { action: "found", mission }, "Found: Team One has the subject in C2"),
    ];
    const r = buildReport(
      {
        ...EMPTY, mission, events,
        teams: [{ id: "T1", callsign: "Team One" } as Team],
        tasks: [{ sector_id: "B4", state: "searched", team_id: "T1", pod: 0.6, note: "both ditches" } as SectorTask],
        proposals: [{ status: "approved" }, { status: "rejected" }] as Proposal[],
      },
      new Date("2026-10-24T22:15:00Z"),
    );
    expect(r.period).toEqual({ from: "2026-10-24T20:30:00Z", to: "2026-10-24T22:10:00Z", minutes: 100 });
    expect(r.found).toMatchObject({ by: "Team One", sector: "C2" });
    expect(r.events.map((e) => e.text)).toEqual([
      "Survey photos: the flight starts",
      "Track: boot prints",
      "Dana approved the AI's suggestion: Assign sector C2 to Team One",
      "Found: Team One has the subject in C2",
    ]);
    expect(r.searched).toEqual([{ sector: "B4", pod: 0.6, team: "Team One", note: "both ditches" }]);
    expect(r).toMatchObject({ radioTurns: 1, proposals: { accepted: 1, rejected: 1, pending: 0 } });
    const md = reportMarkdown(r, true);
    expect(md).toContain("# After-action report: Mount Seymour (demo)");
    expect(md).toContain("- **Found:** by Team One in C2 at 22:10");
    expect(md).toContain("| B4 | 60 % | Team One | both ditches |");
    expect(md).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
