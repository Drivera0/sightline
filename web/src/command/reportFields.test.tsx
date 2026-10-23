// The after-action report's fields from the server's report (PR #215, report.py): last seen, every sector's
// final POD, the drone legs with their minutes and photos; in the report view and the Markdown export.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Mission, SectorTask, Team } from "../contract";
import { EMPTY, type MissionData } from "../lib/mission";
import type { ServerReport } from "../lib/fixtureExtras";
import fixture from "./__fixtures__/scenarios/overdue-hiker.json";
import { MissionReport } from "./MissionReport";
import { buildReport, legRows, reportMarkdown, sectorPods } from "./report";

const data: MissionData = {
  ...EMPTY,
  mission: fixture.mission as unknown as Mission,
  teams: fixture.teams as unknown as Team[],
  tasks: fixture.tasks as unknown as SectorTask[],
  report: fixture.report as unknown as ServerReport,
};
const report = fixture.report as unknown as Required<ServerReport>;
const NOW = new Date(fixture.now);

describe("the report's new fields", () => {
  it("reads last seen, every sector's final POD and the legs from the server's report", () => {
    const r = buildReport(data, NOW);
    expect(r.lastSeen).toBe(fixture.mission.last_seen_at);
    expect(r.sectors).toHaveLength(report.sectors.length);
    expect(r.sectors.find((s) => s.sector === "A1")?.pod).toBeCloseTo(report.sectors.find((s) => s.sector === "A1")!.pod);
    expect(r.legList.map((l) => [l.leg, l.minutes, l.photos])).toEqual(report.legs.map((l) => [l.leg, l.minutes, l.photos]));
  });

  it("adds a ground search the console recorded since, as one more look", () => {
    const tasks = [{ sector_id: "A2", state: "searched", team_id: "T1", pod: 0.5, note: null } as SectorTask];
    const a2 = report.sectors.find((s) => s.sector === "A2")!;
    expect(sectorPods({ ...data, tasks }).find((s) => s.sector === "A2")?.pod).toBeCloseTo(1 - (1 - a2.pod) * 0.5);
  });

  it("without the server's report: the sectors' ground searches and the fleet's legs", () => {
    const sectors = [{ sector_id: "B3", label: "B3", poa: 0.1, drone_coverage: 0.4 }] as MissionData["sectors"];
    expect(sectorPods({ ...data, report: null, sectors, tasks: [] })).toEqual([{ sector: "B3", poa: 0.1, coverage: 0.4, pod: 0 }]);
    expect(legRows({ ...data, report: null, fleet: null })).toEqual([]);
  });

  it("the Markdown export has them", () => {
    const md = reportMarkdown(buildReport(data, NOW), true);
    expect(md).toMatch(/- \*\*Last seen:\*\* 19:48, 3 h 52 min before the call/);
    expect(md).toContain("## Every sector's final POD");
    expect(md).toContain("| A1 | 2.3 % | 0 % | 55 % |");
    expect(md).toContain("## Drone legs");
    expect(md).toContain("| L001 | Drone 1 | B3 | cancelled | 4.3 (reported) | 109 |");
    expect(md).not.toMatch(/\bclear(s|ed|ing)?\b|rule out/i);
  });

  it("the report view shows them", () => {
    render(<MissionReport data={data} now={NOW} missionUrl={null} />);
    expect(screen.getByText("Last seen")).toBeInTheDocument();
    const sectors = screen.getByRole("region", { name: "Every sector's final POD" });
    expect(within(sectors).getAllByRole("row")).toHaveLength(report.sectors.length + 1);
    const legs = screen.getByRole("region", { name: "Drone legs" });
    expect(within(legs).getAllByRole("row")).toHaveLength(report.legs.length + 1);
    expect(within(legs).getByText("109")).toBeInTheDocument();
  });
});
