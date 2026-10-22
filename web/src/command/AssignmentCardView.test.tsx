// E-09: the assignment card from lane B's card JSON; the print, GPX and KML buttons; the sector outline.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssignmentCard } from "../contract";
import { AssignmentCardView, compass, outline } from "./AssignmentCardView";

const card: AssignmentCard = {
  mission_id: "a1b2c3d4",
  sector_id: "B3",
  sector_label: "Bravo Three",
  team_id: "T2",
  team_callsign: "Team Two",
  polygon: [[-122.94, 49.376], [-122.937, 49.376], [-122.937, 49.374], [-122.94, 49.374], [-122.94, 49.376]],
  area_m2: 62500,
  entry: { name: "B3 entry (north edge)", lat: 49.376, lon: -122.9385, note: "entry" },
  bearing_deg_from_team: 124,
  distance_m_from_team: 380,
  waypoints: [
    { name: "B3 entry (north edge)", lat: 49.376, lon: -122.9385, note: "entry" },
    { name: "B3 sweep 1 start", lat: 49.3759, lon: -122.94, note: "sweep" },
  ],
  poa: 0.0612,
  drone_coverage: 0.4,
  look_for: ["adult, red jacket", "person seen in a photo: red jacket, lying (f0001-d01)"],
  evidence_crops: ["crops/f0001-d01.jpg"],
  conditions_line: "wind 18 km/h, gusts 30; no rain",
  daylight_remaining_min: 95,
  radio: "Channel 2, callsign Sightline",
  generated_at: "2026-10-24T22:00:00Z",
};

const view = (over: Partial<AssignmentCard> = {}) =>
  render(<AssignmentCardView card={{ ...card, ...over }} gpxUrl="/c.gpx" kmlUrl="/c.kml" imageUrl={(r) => `/f/${r}`} backHref="#m/x/command" />);

describe("assignment card", () => {
  it("shows who goes where, what to look for, and how to report", () => {
    view();
    expect(screen.getByRole("heading")).toHaveTextContent("Team Two · Sector Bravo Three (B3)");
    expect(screen.getByText(/POA 6 % · drone coverage 40 % · 6.3 ha/)).toBeInTheDocument();
    expect(screen.getByText(/380 m at 124° \(SE\) from Team Two's last position/)).toBeInTheDocument();
    expect(screen.getByText("person seen in a photo: red jacket, lying (f0001-d01)")).toBeInTheDocument();
    expect(screen.getByAltText("photo crop crops/f0001-d01.jpg")).toHaveAttribute("src", "/f/crops/f0001-d01.jpg");
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText(/Daylight left: 95 min/)).toBeInTheDocument();
    expect(screen.getByText("Channel 2, callsign Sightline")).toBeInTheDocument();
    expect(screen.getByText(/reads every clue back; confirm it before it is logged/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bclear(ed)?\b/i);
  });

  it("prints, and downloads GPX and KML", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    view();
    await userEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Download GPX" })).toHaveAttribute("href", "/c.gpx");
    expect(screen.getByRole("link", { name: "Download KML" })).toHaveAttribute("download", "B3.kml");
  });

  it("leaves out the team's bearing when its position is unknown", () => {
    view({ bearing_deg_from_team: null, distance_m_from_team: null, team_callsign: null });
    expect(screen.getByRole("heading")).toHaveTextContent("Unassigned · Sector Bravo Three");
    expect(screen.queryByText(/last position/)).toBeNull();
  });

  it("draws the outline north up in a 100 box, with the entry on it", () => {
    const { path, entry } = outline(card);
    // 0.003° of longitude at 49.37° N is 0.00195° of latitude: about as wide (217 m) as tall (222 m)
    const xs = [...path.matchAll(/[ML](\S+) (\S+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const w = Math.max(...xs.map((x) => x[0]!)) - Math.min(...xs.map((x) => x[0]!));
    const h = Math.max(...xs.map((x) => x[1]!)) - Math.min(...xs.map((x) => x[1]!));
    expect(h).toBeCloseTo(90);
    expect(w / h).toBeCloseTo(0.976, 2);
    expect(entry[1]).toBeCloseTo(5); // the north edge
    expect([compass(0), compass(124), compass(350)]).toEqual(["N", "SE", "N"]);
  });

  it("renders lane B's real card fixture (scripts/make_card_fixture.py)", async () => {
    const real = (await import("./__fixtures__/card_sector_B3.json")).default as unknown as AssignmentCard;
    render(<AssignmentCardView card={real} gpxUrl="/c.gpx" kmlUrl="/c.kml" imageUrl={(r) => r} />);
    expect(screen.getByRole("heading")).toHaveTextContent(`${real.team_callsign} · Sector ${real.sector_label} (B3)`);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(real.waypoints.length + 1);
  });
});

