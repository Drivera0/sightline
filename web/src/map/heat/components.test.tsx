import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FoundBanner } from "./FoundBanner";
import { isPlaceholderPrior, Legend, showsPlaceholderPrior } from "./Legend";
import { MIN_OVERLAP } from "./coverage";
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
  const seenOnce = Float64Array.from([0, 1.5, 0, 1.4, 1.5, 0, 0, 1.4]); // every covered cell well photographed

  it("lists only photographed cells, most likely first, with labels, and shares that sum to 100%", () => {
    const onSelect = vi.fn();
    render(<NextSearch map={map} state={state} covered={covered} overlap={seenOnce} onSelect={onSelect} />);
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
    render(<NextSearch map={map} state={flat} covered={covered} overlap={seenOnce} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Most likely cells" })).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-idx"))).toEqual(["3", "7", "4", "1"]);
  });

  it("keeps tiny probabilities apart and shows each cell against the surveyed average", () => {
    // Real demo values: every photographed cell is around 0.02%, so 2 decimals would all read "0.02%".
    const tiny = {
      p: Float64Array.from([0.0002043, 0.0002014, 0.0002043, 0.0001954, 0.0000517, 0.0002043, 0.0002043, 0.0001119]),
      outside: 0.5,
    };
    render(<NextSearch map={map} state={tiny} covered={covered} overlap={seenOnce} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Most likely cells" })).getAllByRole("button");
    expect(rows[0]).toHaveTextContent("0.0201%");
    expect(rows[1]).toHaveTextContent("0.0195%");
    // Average over the 4 photographed cells = (2.014 + 1.954 + 0.517 + 1.119) / 4 = 1.401e-4
    expect(rows[0]).toHaveTextContent("1.4× avg");
    expect(rows[3]).toHaveTextContent("0.4× avg");
  });

  it("skips a lightly covered cell with higher p and lists the well covered forest cell", () => {
    // Cell 1 has the top p but the camera only touched a sliver of it (0.1); cell 4 is dense forest seen 1.5 times.
    const overlap = Float64Array.from([0, 0.1, 0, 1.4, 1.5, 0, 0, 0.3]);
    render(<NextSearch map={map} state={state} covered={covered} overlap={overlap} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Most likely cells" })).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-idx"))).toEqual(["4", "3"]);
    expect(rows[0]).toHaveTextContent("dense forest");
    // Average over the 2 eligible cells only: (0.15 + 0.1) / 2 = 0.125, so cell 4 is 1.2x.
    expect(rows[0]).toHaveTextContent("1.2× avg");
  });

  it("keeps a cell seen exactly the minimum overlap", () => {
    const overlap = Float64Array.from([0, MIN_OVERLAP, 0, 0, 0, 0, 0, 0]);
    render(<NextSearch map={map} state={state} covered={covered} overlap={overlap} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Most likely cells" })).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-idx"))).toEqual(["1"]);
  });

  it("says so when no cell is photographed well enough", () => {
    const thin = Float64Array.from([0, 0.2, 0, 0.3, 0.1, 0, 0, 0.4]);
    render(<NextSearch map={map} state={state} covered={covered} overlap={thin} onSelect={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Most likely cells" })).toBeNull();
    expect(screen.getByText("No cell photographed well enough yet")).toBeInTheDocument();
    // The shares still use the whole surveyed area.
    expect(document.querySelector('[data-share="Inside surveyed area"]')).toHaveTextContent("55.00%");
  });

  it("leaves cells awaiting review out of the ranking and out of the average", () => {
    // Cell 1 has the top p but is held; cell 4 comes first. Average over cells 3, 4, 7 = (0.1 + 0.15 + 0.1) / 3.
    const held = Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0]);
    render(<NextSearch map={map} state={state} covered={covered} overlap={seenOnce} held={held} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Most likely cells" })).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-idx"))).toEqual(["4", "3", "7"]);
    expect(rows[0]).toHaveTextContent("1.3× avg");
  });

  it("says so when no cell has been photographed", () => {
    render(<NextSearch map={map} state={state} covered={new Uint8Array(8)} overlap={new Float64Array(8)} onSelect={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Most likely cells" })).toBeNull();
    expect(screen.getByText("No cell photographed well enough yet")).toBeInTheDocument();
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
    expect(screen.getByText(/Inside the surveyed area/)).toBeInTheDocument();
    expect(screen.getByText("Not yet searched")).toBeInTheDocument();
  });

  it("has a swatch for cells awaiting review", () => {
    render(<Legend simulatedPath={false} params={{}} manifest={{ notes: "" }} hasSurveyed />);
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
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
