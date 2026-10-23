// C-H1: the live map's features from the mission (the MapLibre drawing itself is checked in a browser).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Clue, FleetState, MapBase, Team } from "../../contract";
import { FloatingLegend, HeatKeyRow, legendOpenAtStart, LiveHeatMap, mapTextAlternative, NO_EVIDENCE_LABEL, pointFeatures, sectorFeatures } from "./LiveHeatMap";

const base = { lkp: { lat: 49.37, lon: -122.945 } } as MapBase;
const ring: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0], [0, 1]];

describe("live map features", () => {
  it("outlines each sector and labels it with its POA now", () => {
    const { lines, labels } = sectorFeatures([
      { sector_id: "B3", label: "Bravo Three", poa: 0.0612, drone_coverage: 0.2, polygon: ring },
      { sector_id: "B4", label: "Bravo Four", poa: 0.05, drone_coverage: 0 }, // an older server: no outline
    ]);
    expect(lines).toHaveLength(1);
    expect(labels[0]?.properties.text).toBe("B3 · 6.1 %");
    expect(labels[0]?.geometry.coordinates).toEqual([0.5, 0.5]);
  });

  it("puts the last-known point, clues and only teams with a position on the map", () => {
    const clue = { id: "c001", kind: "track", text: "boot prints", lat: 49.371, lon: -122.944, radius_m: 75, reliability: "medium", reported_by: "T1", source: "form", at: "2026-10-24T21:00:00Z" } as Clue;
    const teams = [
      { id: "T1", callsign: "Team One", status: "standby", position: { lat: 49.372, lon: -122.946 }, position_at: null },
      { id: "T2", callsign: "Team Two", status: "standby", position: null, position_at: null },
    ] as Team[];
    const pts = pointFeatures(base, [clue], teams);
    expect(pts.map((f) => f.properties.label)).toEqual(["Last known point", "c001 track", "Team One · standby"]);
    expect(pts.map((f) => f.properties.id)).toEqual(["", "c001", "T1"]); // ids select them on click
  });

  it("says when there is no map yet", () => {
    render(<LiveHeatMap mapBase={null} updates={[]} sectors={[]} clues={[]} teams={[]} />);
    expect(screen.getByText(/once the mission has its search area/)).toBeInTheDocument();
  });

  it("says the map in words for screen readers: sectors by POA, teams, clues, drones", () => {
    const clue = { id: "c001", kind: "track", text: "boot prints", reported_by: "T1", confirmed: false } as Clue;
    const teams = [
      { id: "T1", callsign: "Team One", status: "searching", position: { lat: 49.37, lon: -122.94 } },
      { id: "T2", callsign: "Team Two", status: "off_duty", position: null },
    ] as Team[];
    const fleet = { simulated: true, drones: [{ name: "Drone 1", status: "flying", battery_pct: 71.6 }] } as FleetState;
    const sectors = [
      { sector_id: "A1", label: "Alpha One", poa: 0.02, drone_coverage: 0 },
      { sector_id: "B3", label: "Bravo Three", poa: 0.12, drone_coverage: 0 },
    ];
    expect(mapTextAlternative({ sectors, teams, clues: [clue], fleet })).toEqual([
      "Sectors by probability (POA): B3 Bravo Three 12%; A1 Alpha One 2.0%.",
      "Teams: Team One searching; Team Two off duty, no position.",
      "Clues: c001 track: boot prints (Team One, unconfirmed).",
      "Drones (simulated): Drone 1 flying, battery 72%.",
    ]);
    expect(mapTextAlternative({ sectors: [], teams: [], clues: [] })).toEqual(["No sectors yet.", "No teams.", "No clues yet.", "No drones on the map."]);
  });

  it("says a drone's link in words in the summary, now that the map only shows its short id", () => {
    const fleet = { simulated: true, drones: [{ id: "D2", name: "Drone 2", status: "flying", battery_pct: 87.5 }] } as FleetState;
    const links = { D2: { link: "lost" as const, since: "2026-10-24T21:55:00Z", last_heard_at: "2026-10-24T21:55:00Z" } };
    const lines = mapTextAlternative({ sectors: [], teams: [], clues: [], fleet, links, now: new Date("2026-10-24T22:00:00Z") });
    expect(lines[3]).toBe("Drones (simulated): Drone 2 flying, battery 88%, link lost, last heard 5 min ago.");
  });

  it("starts the one legend as a small pill, no update count; a click or L opens it, remembered", () => {
    localStorage.removeItem("sightline.mapLegend");
    const { unmount } = render(<FloatingLegend updates={502} />);
    const pill = screen.getByRole("button", { name: /Legend/ });
    expect(pill).toHaveAttribute("aria-expanded", "false"); // closed at any width the first time
    expect(screen.queryByText(/map updates/)).toBeNull(); // the count is not news
    expect(screen.queryByRole("list", { name: "Map legend" })).toBeNull(); // hidden
    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "Map legend" });
    expect(list.className).toContain("grid-rows-4"); // two columns, at most four lines
    expect(list.querySelectorAll("li").length).toBeLessThanOrEqual(8);
    expect(screen.queryByText(/SIM/)).toBeNull(); // one disclosure chip in the header instead
    expect(list).toHaveTextContent("Base camp");
    expect(list).toHaveTextContent("Active drone leg");
    // The heat's own line above it: the three classes, both edges and the unshaded rest.
    const heat = screen.getByRole("list", { name: "Probability classes" });
    expect(heat).toHaveTextContent("Likelier than even: 90 · 80 · 50 % of the extra");
    expect(heat).toHaveTextContent("50 % edge");
    expect(heat).toHaveTextContent("90 % edge");
    expect(heat).toHaveTextContent("Darker: searched, lowered");
    expect(heat).toHaveTextContent("No shading: about as likely as an even spread");
    expect(heat).toHaveTextContent("Hatched: not photographed yet");
    expect(localStorage.getItem("sightline.mapLegend")).toBe("open");
    unmount();
    expect(legendOpenAtStart()).toBe(true);
    render(<FloatingLegend updates={502} />);
    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByRole("button", { name: /Legend/ })).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("sightline.mapLegend")).toBe("closed");
    localStorage.removeItem("sightline.mapLegend");
  });

  it("says there is no evidence yet while the map is flat, instead of naming shades nobody sees", () => {
    render(<HeatKeyRow evidence={false} />);
    const heat = screen.getByRole("list", { name: "Probability classes" });
    expect(heat).toHaveTextContent(NO_EVIDENCE_LABEL);
    expect(heat).not.toHaveTextContent("50 % edge");
    expect(heat).toHaveTextContent("Hatched: not photographed yet");
  });
});
