import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CandidateShare } from "../../search/update";
import { CELL, cellKinds } from "./classes";
import { SectorList } from "./SectorList";
import {
  candidateMask,
  cellAt,
  pctText,
  sectorsWithSightings,
  sightingAreaText,
  sightingAtCell,
  sightingReading,
  withoutCandidates,
} from "./sightings";
import type { SectorStatus } from "./sectors";

const area = (cells: number[], share: number, poa: number, ids = ["d"]): CandidateShare => ({ detectionIds: ids, cells, share, poa });

describe("sighting readings", () => {
  it("one candidate: the search ends here if it is them; several: its share among them", () => {
    expect(sightingReading(area([1], 1, 0.001), 1)).toBe(
      "Candidate sighting · if this is the missing person, the search ends here (100%)",
    );
    expect(sightingReading(area([1], 0.625, 0.001), 3)).toBe("Candidate sighting · 63% of the chance among 3 sightings");
    expect(sightingAreaText(area([1], 1, 0.000213))).toBe("This area held 0.021% of the map");
    expect(pctText(0.05)).toBe("5%");
    expect(pctText(0)).toBe("0%");
  });
});

describe("candidate cells", () => {
  it("masks the areas, clears them from another mask, finds the area under a cell and their sectors", () => {
    const sightings = [area([1, 2], 0.5, 0.1), area([7], 0.5, 0.1)];
    const mask = candidateMask(9, sightings);
    expect(Array.from(mask)).toEqual([0, 1, 1, 0, 0, 0, 0, 1, 0]);
    expect(Array.from(withoutCandidates(Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 1, 1]), mask))).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(sightingAtCell(sightings, 7)).toBe(sightings[1]);
    expect(sightingAtCell(sightings, 4)).toBeUndefined();
    const cellSector = Int16Array.from([0, 0, 1, 1, 1, 1, 2, 2, 2]);
    expect([...sectorsWithSightings(cellSector, ["A", "B", "C"], mask)].sort()).toEqual(["A", "B", "C"]);
  });

  it("cellAt maps a position to its grid cell, -1 outside", () => {
    const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 20, rows: 3, cols: 3 };
    const mLon = 111_320 * Math.cos((49.37 * Math.PI) / 180);
    expect(cellAt(grid, [-122.95 + 30 / mLon, 49.37 - 30 / 111_320])).toBe(4);
    expect(cellAt(grid, [-122.95 - 1 / mLon, 49.37])).toBe(-1);
  });

  it("cellKinds draws candidate cells in the likeliest class, even where held or unphotographed", () => {
    const p = Float64Array.from([0.01, 0.01, 0.01, 0.5]);
    const kinds = cellKinds(p, Uint8Array.from([1, 0, 1, 1]), Uint8Array.from([1, 0, 0, 0]), Uint8Array.from([1, 1, 0, 0]));
    expect(kinds[0]).toBe(CELL.top);
    expect(kinds[1]).toBe(CELL.top);
    // Cell 3 alone holds 98 % of the rest: it is the likeliest 50 %; cell 2 is outside the 90 % region.
    expect(kinds[3]).toBe(CELL.top);
    expect(kinds[2]).toBe(CELL.none);
  });
});

describe("SectorList with a sighting", () => {
  it("lists the sector holding a candidate first, with the ground-team label", () => {
    const sector = (id: string) => ({ id, label: id, kind: "flight" as const, rect: { west: 0, east: 1, north: 0, south: 1 } });
    const statuses: SectorStatus[] = [
      { sector: sector("1"), poa: 0.3, coverage: 1, cells: 1, state: "searched" },
      { sector: sector("2"), poa: 0.01, coverage: 1, cells: 1, state: "searched" },
    ];
    render(
      <SectorList
        statuses={statuses}
        outside={0.5}
        currentId={null}
        hoverId={null}
        onHover={() => {}}
        onSelect={() => {}}
        layout="flight"
        sighted={new Set(["2"])}
      />,
    );
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveAttribute("data-sector", "2");
    expect(screen.getByText("Candidate sighting · send ground team to check")).toBeInTheDocument();
  });
});
