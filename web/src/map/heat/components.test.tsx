import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FoundBanner } from "./FoundBanner";
import { isPlaceholderPrior, Legend, showsPlaceholderPrior } from "./Legend";
import { NextSearch } from "./NextSearch";
import { StepSlider, stepText } from "./StepSlider";

const grid = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 20, rows: 2, cols: 4 };

describe("NextSearch", () => {
  const p = Float64Array.from([0.05, 0.2, 0.01, 0.1, 0.15, 0.02, 0.07, 0.1]);
  const state = { p, outside: 0.3 };
  const map = {
    grid,
    lkp: { lat: grid.origin_nw.lat, lon: grid.origin_nw.lon },
    canopy: [null, 0.8, null, 0.2, 0.5, null, null, 0.1],
  };
  const covered = Uint8Array.from([0, 1, 0, 1, 1, 0, 0, 1]);

  it("lists only photographed cells, most likely first, with labels, and shares that sum to 100%", () => {
    const onSelect = vi.fn();
    render(<NextSearch map={map} state={state} covered={covered} onSelect={onSelect} />);
    const rows = within(screen.getByRole("list", { name: "Most likely cells" })).getAllByRole("button");
    // Cell 6 (p 0.07) would be 5th, but it was never photographed; only the 4 covered cells count.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("data-idx"))).toEqual(["1", "4", "3", "7"]);
    expect(rows[0]).toHaveTextContent("dense forest");
    expect(rows[0]).toHaveTextContent("20.00%");
    expect(rows[1]).toHaveTextContent("dense forest"); // canopy 0.5
    expect(rows[2]).toHaveTextContent("open");
    expect(screen.queryByText("not photographed")).toBeNull();
    // Cell 1 centre is 10 m south, 30 m east of the LKP at the NW corner.
    expect(rows[0]).toHaveTextContent("32 m from LKP");

    const shares = ["Inside surveyed area", "Rest of grid", "Outside the grid"].map((label) =>
      Number.parseFloat(document.querySelector(`[data-share="${label}"]`)!.textContent!),
    );
    expect(shares[0]).toBeCloseTo(55, 2);
    expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(0.01);

    fireEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [lon, lat] = onSelect.mock.calls[0] as [number, number];
    expect(lat).toBeLessThan(grid.origin_nw.lat);
    expect(lon).toBeGreaterThan(grid.origin_nw.lon);
  });

  it("ranks a photographed cell above an unphotographed cell with higher p", () => {
    // With a flat prior every unphotographed cell ends up above every photographed one.
    const flat = { p: Float64Array.from([0.2, 0.05, 0.2, 0.2, 0.08, 0.2, 0.2, 0.2]), outside: 0 };
    render(<NextSearch map={map} state={flat} covered={covered} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Most likely cells" })).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-idx"))).toEqual(["3", "7", "4", "1"]);
  });

  it("says so when no cell has been photographed", () => {
    render(<NextSearch map={map} state={state} covered={new Uint8Array(8)} onSelect={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Most likely cells" })).toBeNull();
    expect(screen.getByText("No cell photographed yet")).toBeInTheDocument();
  });
});

describe("StepSlider", () => {
  it("describes the step", () => {
    expect(stepText(0, 500)).toBe("Before the first frame");
    expect(stepText(212, 500)).toBe("After frame 212 of 500");
  });

  it("shows the text and moves with the range input", () => {
    const onChange = vi.fn();
    render(<StepSlider value={212} max={500} onChange={onChange} />);
    expect(screen.getByText("After frame 212 of 500")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "13" } });
    expect(onChange).toHaveBeenCalledWith(13);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("is hidden when there are no steps", () => {
    const { container } = render(<StepSlider value={0} max={0} onChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Legend", () => {
  it("detects a placeholder prior in the manifest notes", () => {
    expect(isPlaceholderPrior("SAMPLE: fake detections, placeholder uniform prior, ...")).toBe(true);
    expect(isPlaceholderPrior("Placeholder Prior")).toBe(true);
    expect(isPlaceholderPrior("build_map: lane C not available, used a uniform prior with empty steps")).toBe(true);
    expect(isPlaceholderPrior("Koester hiker ring prior. Placeholder detections.")).toBe(false);
  });

  it("lets params.prior_source decide, and reads the notes only when it is null or missing", () => {
    expect(showsPlaceholderPrior("placeholder", "real prior")).toBe(true);
    expect(showsPlaceholderPrior("test citation: hiker distance table", "placeholder uniform prior")).toBe(false);
    expect(showsPlaceholderPrior(null, "placeholder uniform prior")).toBe(true);
    expect(showsPlaceholderPrior(undefined, "placeholder uniform prior")).toBe(true);
    expect(showsPlaceholderPrior(null, "real prior")).toBe(false);
  });

  it("shows the placeholder badge when prior_source is placeholder", () => {
    render(
      <Legend simulatedPath={false} params={{ prior_source: "placeholder" }} manifest={{ notes: "" }} hasSurveyed />,
    );
    expect(screen.getByText("Placeholder prior")).toBeInTheDocument();
  });

  it("hides the placeholder badge for a cited prior even if the notes mention a placeholder", () => {
    render(
      <Legend
        simulatedPath={false}
        params={{ prior_source: "test citation: hiker distance table" }}
        manifest={{ notes: "placeholder uniform prior" }}
        hasSurveyed
      />,
    );
    expect(screen.queryByText("Placeholder prior")).not.toBeInTheDocument();
  });

  it("falls back to the manifest notes for a 1.0 cache (prior_source null)", () => {
    render(
      <Legend simulatedPath={false} params={{ prior_source: null }} manifest={{ notes: "placeholder prior" }} hasSurveyed />,
    );
    expect(screen.getByText("Placeholder prior")).toBeInTheDocument();
  });

  it("shows the ramp words and the honesty badges", () => {
    render(<Legend simulatedPath params={{}} manifest={{ notes: "placeholder prior" }} hasSurveyed />);
    expect(screen.getByText("Less likely")).toBeInTheDocument();
    expect(screen.getByText("More likely")).toBeInTheDocument();
    expect(screen.getByText("Simulated flight path")).toBeInTheDocument();
    expect(screen.getByText("Placeholder prior")).toBeInTheDocument();
    expect(screen.getByText("Surveyed area (outline)")).toBeInTheDocument();
  });

  it("hides badges that do not apply", () => {
    render(<Legend simulatedPath={false} params={{}} manifest={{ notes: "real prior" }} hasSurveyed={false} />);
    expect(screen.queryByText("Simulated flight path")).not.toBeInTheDocument();
    expect(screen.queryByText("Placeholder prior")).not.toBeInTheDocument();
  });
});

describe("FoundBanner", () => {
  it("shows coordinates to 6 decimals and the position uncertainty", () => {
    render(<FoundBanner detection={{ id: "f0005-d01", lat: 49.3712345678, lon: -122.9461234, radius_m: 10 }} />);
    expect(screen.getByText("Person confirmed: dispatch ground team")).toBeInTheDocument();
    expect(screen.getByText("49.371235, -122.946123")).toBeInTheDocument();
    expect(screen.getByText("±10 m position uncertainty")).toBeInTheDocument();
  });
});
