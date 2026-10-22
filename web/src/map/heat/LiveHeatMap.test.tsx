// C-H1: the live map's features from the mission (the MapLibre drawing itself is checked in a browser).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Clue, MapBase, Team } from "../../contract";
import type { FleetState } from "../../contract";
import { LiveHeatMap, legFeatures, pointFeatures, sectorFeatures } from "./LiveHeatMap";

const base = { lkp: { lat: 49.37, lon: -122.945 } } as MapBase;
const ring: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0], [0, 1]];

describe("live map features", () => {
  it("outlines each sector and labels it with its POA now", () => {
    const { lines, labels } = sectorFeatures([
      { sector_id: "B3", label: "Bravo Three", poa: 0.0612, drone_coverage: 0.2, polygon: ring },
      { sector_id: "B4", label: "Bravo Four", poa: 0.05, drone_coverage: 0 }, // an older server: no outline
    ]);
    expect(lines).toHaveLength(1);
    expect(labels[0]?.properties.text).toBe("B3 · 6 %");
    expect(labels[0]?.geometry.coordinates).toEqual([0.5, 0.5]);
  });

  it("puts the last-known point, clues and only teams with a position on the map", () => {
    const clue = { id: "c001", kind: "track", lat: 49.371, lon: -122.944 } as Clue;
    const teams = [
      { id: "T1", callsign: "Team One", position: { lat: 49.372, lon: -122.946 } },
      { id: "T2", callsign: "Team Two", position: null },
    ] as Team[];
    const pts = pointFeatures(base, [clue], teams);
    expect(pts.map((f) => f.properties.label)).toEqual(["Last known point", "c001 track", "Team One"]);
    expect(pts.map((f) => f.properties.id)).toEqual(["", "c001", "T1"]); // ids select them on click
  });

  it("says when there is no map yet", () => {
    render(<LiveHeatMap mapBase={null} updates={[]} sectors={[]} clues={[]} teams={[]} />);
    expect(screen.getByText(/once the mission has its search area/)).toBeInTheDocument();
  });

  it("draws drones (labelled simulated) and only approved or flying legs", () => {
    const fleet = {
      drones: [{ id: "D1", name: "Drone 1", simulated: true, position: { lat: 49.371, lon: -122.94 } }],
      legs: [
        { id: "L1", status: "flying", waypoints: ring },
        { id: "L2", status: "done", waypoints: ring },
        { id: "L3", status: "approved", waypoints: ring },
      ],
    } as unknown as FleetState;
    expect(legFeatures(fleet).map((f) => f.properties.id)).toEqual(["L1", "L3"]);
    expect(pointFeatures(base, [], [], fleet).at(-1)?.properties.label).toBe("Drone 1 (simulated)");
  });
});
