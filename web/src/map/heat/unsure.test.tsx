import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UnsureArea } from "../../search/store";
import { Legend } from "./Legend";
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

describe("SectorList with unsure areas", () => {
  it("adds the unsure entry after the candidate sightings, names and tags its sectors, and flies on click", () => {
    const onSelect = vi.fn();
    render(<SectorList {...listProps} sighted={new Set(["2"])} unsure={{ count: 2, sectors: new Set(["3"]), onSelect }} />);
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveAttribute("data-sector", "2");
    expect(rows[1]).toHaveAttribute("data-unsure", "2");
    expect(rows[2]).toHaveAttribute("data-sector", "1");
    expect(screen.getByTestId("unsure-line").textContent).toBe("Unsure · check again: 2 areas the reviewer couldn't call");
    expect(screen.getByText("In Sector 3 · held until someone answers")).toBeInTheDocument();
    // The sector holding an unsure area is tagged in its own row too.
    const tagged = rows.find((r) => r.getAttribute("data-sector") === "3")!;
    expect(tagged.textContent).toContain("Unsure · check again");
    expect(rows.find((r) => r.getAttribute("data-sector") === "1")!.textContent).not.toContain("Unsure");
    fireEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("puts the entry first when there is no sighting, and leaves it out with no unsure area", () => {
    const { unmount } = render(<SectorList {...listProps} unsure={{ count: 1, sectors: new Set(["1"]), onSelect: () => {} }} />);
    expect(screen.getAllByRole("button")[0]).toHaveAttribute("data-unsure", "1");
    expect(screen.getByTestId("unsure-line").textContent).toBe("Unsure · check again: 1 area the reviewer couldn't call");
    unmount();
    render(<SectorList {...listProps} />);
    expect(screen.queryByTestId("unsure-line")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(3);
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
