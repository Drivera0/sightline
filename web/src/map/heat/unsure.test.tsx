import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UnsureArea } from "../../search/store";
import { Legend } from "./Legend";
import { NextSearch } from "./NextSearch";
import { SectorList } from "./SectorList";
import type { SectorStatus } from "./sectors";
import { sectorsWithSightings } from "./sightings";
import { unsureListText, unsureMask, unsureReadoutText } from "./unsure";

const area = (detectionId: string, cells: number[]): UnsureArea => ({ detectionId, lat: 0, lon: 0, cells });

describe("unsure areas", () => {
  it("masks every unsure cell and finds the sectors holding them", () => {
    const mask = unsureMask(9, [area("a", [0, 1]), area("b", [8, 42, -1])]);
    expect(Array.from(mask)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1]);
    const cellSector = Int16Array.from([0, 0, 1, 1, 1, 1, 2, 2, 2]);
    expect([...sectorsWithSightings(cellSector, ["A", "B", "C"], mask)].sort()).toEqual(["A", "C"]);
  });

  it("counts them in the list line and the readout line", () => {
    expect(unsureListText(1)).toBe("Unsure · check again: 1 area the reviewer couldn't call");
    expect(unsureListText(3)).toBe("Unsure · check again: 3 areas the reviewer couldn't call");
    expect(unsureReadoutText(1)).toBe("1 unsure area kept at its value before the photo");
    expect(unsureReadoutText(2)).toBe("2 unsure areas kept at their value before the photo");
  });
});

const sector = (id: string) => ({ id, label: id, kind: "flight" as const, rect: { west: 0, east: 1, north: 0, south: 1 } });
const statuses: SectorStatus[] = [
  { sector: sector("1"), poa: 0.3, coverage: 1, cells: 1, state: "searched" },
  { sector: sector("2"), poa: 0.01, coverage: 1, cells: 1, state: "searched" },
  { sector: sector("3"), poa: 0.2, coverage: 1, cells: 1, state: "searched" },
];
const listProps = {
  statuses,
  outside: 0.5,
  currentId: null,
  hoverId: null,
  onHover: () => {},
  onSelect: () => {},
  layout: "flight" as const,
};

describe("unsure entry and tags", () => {
  it("tags the sectors holding an unsure area, with no separate entry in the sector list", () => {
    render(<SectorList {...listProps} sighted={new Set(["2"])} unsureSectors={new Set(["3"])} />);
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("data-sector", "2");
    expect(screen.queryByTestId("unsure-line")).toBeNull();
    expect(rows.find((r) => r.getAttribute("data-sector") === "3")!.textContent).toContain("Unsure · check again");
    expect(rows.find((r) => r.getAttribute("data-sector") === "1")!.textContent).not.toContain("Unsure");
  });

  it("leads the Search next list with the unsure entry, names its sectors, and flies on click", () => {
    const onSelect = vi.fn();
    const g = { rows: 2, cols: 2, cell_m: 20, origin_nw: { lat: 49.37, lon: -122.95 } };
    const map = { grid: g, lkp: { lat: 49.37, lon: -122.95 }, canopy: [0.8, 0.2, 0.8, 0.2] } as unknown as Parameters<typeof NextSearch>[0]["map"];
    const state = { p: Float64Array.from([0.1, 0.2, 0.3, 0.4]), outside: 0 };
    const { unmount } = render(
      <NextSearch
        map={map}
        state={state}
        covered={Uint8Array.from([1, 1, 1, 1])}
        overlap={Float64Array.from([1, 1, 1, 1])}
        onSelect={vi.fn()}
        unsure={{ count: 2, sectorNames: ["Sector 3"], onSelect }}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("data-unsure", "2");
    expect(screen.getByTestId("unsure-line").textContent).toBe("Unsure · check again: 2 areas the reviewer couldn't call");
    expect(screen.getByText("In Sector 3 · held until someone answers")).toBeInTheDocument();
    fireEvent.click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    unmount();
    render(<NextSearch map={map} state={state} covered={Uint8Array.from([1, 1, 1, 1])} overlap={Float64Array.from([1, 1, 1, 1])} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("unsure-line")).toBeNull();
  });
});

describe("Legend", () => {
  it("shows 'Unsure · check again' only with an unsure area on the map, next to the candidate sighting", () => {
    const { unmount } = render(<Legend simulatedPath hasSurveyed hasSightings hasUnsure />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const at = items.findIndex((t) => t.startsWith("Candidate sighting"));
    expect(items[at + 1]).toContain("Unsure · check again");
    unmount();
    render(<Legend simulatedPath hasSurveyed />);
    expect(screen.queryByText("Unsure · check again")).toBeNull();
  });
});
