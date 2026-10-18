import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SectorList } from "./SectorList";
import {
  buildSectors,
  currentSector,
  flightLines,
  LINES_PER_SECTOR,
  rankSectors,
  sectorState,
  sectorStatuses,
  type SurveyFrameLike,
} from "./sectors";

const M_PER_DEG = 111_320;
function grid(cellM: number) {
  const n = 1000 / cellM;
  return { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: cellM, rows: n, cols: n };
}
const mLon = M_PER_DEG * Math.cos((49.37 * Math.PI) / 180);
const at = (east: number, south: number): [number, number] => [-122.95 + east / mLon, 49.37 - south / M_PER_DEG];

/** A lawnmower flight: `lines` east-west lines of `perLine` frames (20 x 15 m footprints), 16 m apart. */
function lawnmower(lines: number, perLine: number, west = 400, north = 400): SurveyFrameLike[] {
  const frames: SurveyFrameLike[] = [];
  for (let l = 0; l < lines; l++) {
    for (let k = 0; k < perLine; k++) {
      const col = l % 2 === 0 ? k : perLine - 1 - k;
      const cx = west + 10 + col * 20;
      const cy = north + 7.5 + l * 16;
      const [lon, lat] = at(cx, cy);
      frames.push({
        pose: { lon, lat },
        footprint: [at(cx - 10, cy - 7.5), at(cx + 10, cy - 7.5), at(cx + 10, cy + 7.5), at(cx - 10, cy + 7.5)],
      });
    }
  }
  return frames;
}

describe("flight sectors", () => {
  it("finds east-west flight lines and groups them into numbered sectors in flight order", () => {
    const g = grid(20);
    const frames = lawnmower(8, 5);
    expect(flightLines(g, frames)).toHaveLength(8);
    const layout = buildSectors(g, frames);
    expect(layout.kind).toBe("flight");
    const flight = layout.sectors.filter((s) => s.kind === "flight");
    expect(flight.map((s) => s.label)).toEqual(["1", "2"]);
    expect(flight[0]!.steps).toEqual([1, LINES_PER_SECTOR * 5]);
    expect(flight[1]!.steps).toEqual([LINES_PER_SECTOR * 5 + 1, 40]);
    // Sector 1 is north of sector 2 and they share an edge.
    expect(flight[0]!.rect.south).toBeCloseTo(flight[1]!.rect.north, 9);
    expect(layout.sectors.filter((s) => s.kind === "outer").map((s) => s.id)).toEqual(["N", "E", "S", "W"]);
  });

  it("puts every cell in exactly one sector, at any cell size", () => {
    for (const cellM of [20, 10, 5]) {
      const g = grid(cellM);
      const layout = buildSectors(g, lawnmower(8, 5));
      expect(layout.cellSector).toHaveLength(g.rows * g.cols);
      expect(Math.min(...layout.cellSector)).toBeGreaterThanOrEqual(0);
      // A cell centre inside the first flight block belongs to sector 1.
      const row = Math.floor((400 + 10) / cellM);
      const col = Math.floor((400 + 50) / cellM);
      expect(layout.sectors[layout.cellSector[row * g.cols + col]!]!.id).toBe("S1");
      // The grid's north-west corner is in the outer north sector.
      expect(layout.sectors[layout.cellSector[0]!]!.id).toBe("N");
    }
  });

  it("falls back to a 4 x 4 A1-D4 lattice when the flight is not east-west lines", () => {
    const g = grid(5);
    const layout = buildSectors(g, lawnmower(2, 5));
    expect(layout.kind).toBe("lattice");
    expect(layout.sectors.map((s) => s.label).slice(0, 5)).toEqual(["A1", "B1", "C1", "D1", "A2"]);
    expect(layout.sectors[layout.cellSector[0]!]!.label).toBe("A1");
    expect(layout.sectors[layout.cellSector[g.rows * g.cols - 1]!]!.label).toBe("D4");
    // 250 m sectors on the 1 km grid: 50 x 50 cells of 5 m each.
    const counts = new Map<number, number>();
    for (const k of layout.cellSector) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 2500)).toBe(true);
  });
});

describe("sector status", () => {
  const g = grid(20);
  const layout = buildSectors(g, lawnmower(8, 5));
  const n = g.rows * g.cols;

  it("POA sums to the in-grid share and coverage counts photographed cells", () => {
    const p = new Float64Array(n).fill(0.6 / n);
    const covered = new Uint8Array(n);
    // Photograph every cell of sector 1.
    layout.cellSector.forEach((k, i) => {
      if (layout.sectors[k]!.id === "S1") covered[i] = 1;
    });
    const statuses = sectorStatuses(layout, { p, outside: 0.4 }, covered);
    const total = statuses.reduce((sum, s) => sum + s.poa, 0);
    expect(total).toBeCloseTo(0.6, 12);
    const s1 = statuses.find((s) => s.sector.id === "S1")!;
    expect(s1.coverage).toBe(1);
    expect(s1.state).toBe("searched");
    expect(statuses.find((s) => s.sector.id === "S2")!.state).toBe("not_searched");
    // Ranked by POA: the big outer sectors first under a flat prior.
    expect(["N", "S"]).toContain(rankSectors(statuses)[0]!.sector.id);
  });

  it("normalises POA when p and outside do not sum to 1", () => {
    const p = new Float64Array(n).fill(2 / n);
    const statuses = sectorStatuses(layout, { p, outside: 2 }, new Uint8Array(n));
    expect(statuses.reduce((sum, s) => sum + s.poa, 0)).toBeCloseTo(0.5, 12);
  });

  it("names the state from coverage", () => {
    expect(sectorState(1)).toBe("searched");
    expect(sectorState(0.9)).toBe("searched");
    expect(sectorState(0.5)).toBe("in_progress");
    expect(sectorState(0.01)).toBe("not_searched");
    expect(sectorState(0)).toBe("not_searched");
  });

  it("knows which sector the drone is in during the replay, and none at the ends", () => {
    expect(currentSector(layout, 0, 40)).toBeNull();
    expect(currentSector(layout, 5, 40)!.id).toBe("S1");
    expect(currentSector(layout, 21, 40)!.id).toBe("S2");
    expect(currentSector(layout, 40, 40)).toBeNull();
  });
});

describe("SectorList", () => {
  const g = grid(20);
  const layout = buildSectors(g, lawnmower(8, 5));
  const n = g.rows * g.cols;
  const p = new Float64Array(n).fill(0.5 / n);
  const statuses = sectorStatuses(layout, { p, outside: 0.5 }, new Uint8Array(n));

  it("lists sectors by POA with coverage and state, and links them to the map", async () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    render(
      <SectorList
        statuses={statuses}
        outside={0.5}
        currentId="S2"
        hoverId={null}
        onHover={onHover}
        onSelect={onSelect}
        layout="flight"
      />,
    );
    const rows = within(screen.getByRole("list", { name: "Sectors by remaining probability" })).getAllByRole("button");
    expect(rows).toHaveLength(statuses.length);
    expect(rows[0]!.textContent).toMatch(/Sector (N|S)/);
    const poas = rows.map((r) => Number(r.textContent!.match(/([\d.]+)%$/)![1]));
    expect([...poas].sort((a, b) => b - a)).toEqual(poas);
    expect(screen.getByText(/Drone here/)).toBeInTheDocument();
    expect(screen.getByText(/Outside the 1 km grid: 50\.0%/)).toBeInTheDocument();
    await userEvent.hover(rows[1]!);
    expect(onHover).toHaveBeenCalled();
    await userEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }));
  });
});
