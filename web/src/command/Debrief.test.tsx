// The Debrief's exports row (docs/EXPORTS.md): off on the demo (no API), new-tab links on a live mission.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Debrief, Exports } from "./Debrief";

const TEAMS = [
  { id: "T1", callsign: "Team One" },
  { id: "T2", callsign: "Team Two" },
];

describe("Exports", () => {
  it("on the demo: the three are shown off, with one line saying where they work", () => {
    render(<Exports missionUrl={null} teams={TEAMS} />);
    const row = screen.getByRole("group", { name: "Exports" });
    for (const name of ["ICS-204", "ICS-214", "CalTopo GeoJSON"]) expect(within(row).getByRole("button", { name })).toBeDisabled();
    expect(within(row).queryAllByRole("link")).toHaveLength(0);
    expect(within(row).getByRole("combobox", { name: "Team for the ICS-204" })).toBeDisabled();
    expect(row).toHaveTextContent(/available on a live mission/i);
  });

  it("on a live mission: each opens in a new tab, the ICS-204 for the team picked", async () => {
    render(<Exports missionUrl="http://api.test/missions/m1" teams={TEAMS} />);
    const row = screen.getByRole("group", { name: "Exports" });
    const link = (name: string) => within(row).getByRole("link", { name: new RegExp(`^${name}`) });
    expect(link("ICS-204")).toHaveAttribute("href", "http://api.test/missions/m1/ics204/T1.md");
    expect(link("ICS-214")).toHaveAttribute("href", "http://api.test/missions/m1/ics214.md");
    expect(link("CalTopo GeoJSON")).toHaveAttribute("href", "http://api.test/missions/m1/caltopo.geojson");
    for (const name of ["ICS-204", "ICS-214", "CalTopo GeoJSON"]) {
      expect(link(name)).toHaveAttribute("target", "_blank");
      expect(link(name)).toHaveAttribute("rel", "noreferrer");
    }
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "Team for the ICS-204" }), "T2");
    expect(link("ICS-204")).toHaveAttribute("href", "http://api.test/missions/m1/ics204/T2.md");
    expect(row).not.toHaveTextContent(/available on a live mission/i);
  });

  it("sits in the Debrief, and nothing there says clear", () => {
    render(
      <Debrief
        missionName="Mount Seymour (demo)"
        so={{ mapUpdates: [], tasks: [], clues: [], proposals: [] }}
        metrics={null}
        traceHref="#m/demo/trace"
        exports={{ missionUrl: null, teams: TEAMS }}
      />,
    );
    expect(within(screen.getByLabelText("Debrief")).getByRole("group", { name: "Exports" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
