import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FoundBanner } from "./FoundBanner";
import { classSwatches, isPlaceholderPrior, Legend, showsPlaceholderPrior, swatchColor } from "./Legend";
import { HEAT_PALETTES } from "./palette";
import { NextSearch, SHARE_LABELS } from "./NextSearch";
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

  it("lists connected patches with surveyed-area shares and an explicit remainder", () => {
    const onSelect = vi.fn();
    render(<NextSearch map={map} state={state} covered={covered} overlap={seenOnce} onSelect={onSelect} />);
    const rows = within(screen.getByRole("list", { name: "Most likely patches" })).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-patch-id", "1");
    expect(rows[0]).toHaveTextContent("dense forest");
    expect(rows[0]).toHaveTextContent("36.36%");
    expect(rows[0]).toHaveTextContent("1.5× avg per cell");
    expect(screen.getByTestId("patch-remainder")).toHaveTextContent("63.64%");
    expect(screen.getByTestId("avg-key")).toHaveTextContent("Share of the chance left in the surveyed area");

    const shares = [SHARE_LABELS.surveyed, SHARE_LABELS.restOfGrid, SHARE_LABELS.outside].map((label) =>
      Number.parseFloat(document.querySelector(`[data-share="${label}"]`)!.textContent!),
    );
    expect(shares[0]).toBeCloseTo(55, 2);
    expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(0.01);

    fireEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [lon, lat, id] = onSelect.mock.calls[0] as [number, number, number];
    expect(lat).toBeLessThan(grid.origin_nw.lat);
    expect(lon).toBeGreaterThan(grid.origin_nw.lon);
    expect(id).toBe(1);
  });

  it("excludes lightly photographed and held cells from patches and their denominator", () => {
    const overlap = Float64Array.from([0, 0.1, 0, 1.4, 1.5, 0, 0, 0.3]);
    const held = Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0]);
    render(<NextSearch map={map} state={state} covered={covered} overlap={overlap} held={held} onSelect={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Most likely patches" })).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-patch-id", "3");
    expect(rows[0]).toHaveTextContent("100.00%");
  });

  it("keeps Unsure ahead of the ranked patches", () => {
    render(
      <NextSearch
        map={map}
        state={state}
        covered={covered}
        overlap={seenOnce}
        onSelect={vi.fn()}
        unsure={{ count: 1, sectorNames: ["Sector 2"], onSelect: vi.fn() }}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("data-unsure", "1");
    expect(buttons[1]).toHaveAttribute("data-patch-id");
  });

  it("says so when no ground has been photographed", () => {
    render(<NextSearch map={map} state={state} covered={new Uint8Array(8)} overlap={new Float64Array(8)} onSelect={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Most likely patches" })).toBeNull();
    expect(screen.getByText("No ground photographed well enough yet")).toBeInTheDocument();
  });
});

describe("StepSlider", () => {
  it("describes the step", () => {
    expect(stepText(0, 500)).toBe("Before the first frame");
    expect(stepText(212, 500)).toBe("After frame 212 of 500");
  });

  it("shows the text and moves with the range input, in whole frames", () => {
    const onScrub = vi.fn();
    render(<StepSlider value={212} max={500} onScrub={onScrub} />);
    // Never broken mid-phrase on a narrow bar ("After frame 500 of / 500"): the parts wrap whole.
    expect(screen.getByText("After frame 212 of 500")).toHaveClass("whitespace-nowrap");
    expect(screen.getByText("Flight replay")).toHaveClass("whitespace-nowrap");
    fireEvent.change(screen.getByRole("slider"), { target: { value: "13" } });
    expect(onScrub).toHaveBeenCalledWith(13);
    // A label that changes (Play / Pause) and no toggle state, so it is never read "Pause, not pressed".
    expect(screen.getByRole("button", { name: "Play" })).not.toHaveAttribute("aria-pressed");
  });

  it("is only the controls: play, pause and skip call back; the clock moves the thumb while playing", () => {
    const onTogglePlay = vi.fn();
    const onSkip = vi.fn();
    const { rerender } = render(<StepSlider value={40} max={500} onScrub={vi.fn()} onTogglePlay={onTogglePlay} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("slider")).toHaveAttribute("step", "1");
    rerender(<StepSlider value={40} max={500} playing onScrub={vi.fn()} onTogglePlay={onTogglePlay} onSkip={onSkip} />);
    // Fractional while playing (the thumb glides), and the step text is not announced every commit.
    expect(screen.getByRole("slider")).toHaveAttribute("step", "any");
    expect(screen.getByText("After frame 40 of 500")).toHaveAttribute("aria-live", "off");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip to the end of the flight" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    rerender(<StepSlider value={500} max={500} onScrub={vi.fn()} onTogglePlay={onTogglePlay} onSkip={onSkip} />);
    // At the end it is marked unavailable but stays focusable, so keyboard focus is not dropped
    // to the page after a skip, and a second press does nothing.
    const skip = screen.getByRole("button", { name: "Skip to the end of the flight" });
    expect(skip).toHaveAttribute("aria-disabled", "true");
    expect(skip).not.toBeDisabled();
    skip.focus();
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(skip).toHaveFocus();
  });

  it("is hidden when there are no steps", () => {
    const { container } = render(<StepSlider value={0} max={0} onScrub={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Legend", () => {
  it("offers a labelled flight path switch when given a handler", () => {
    const onChange = vi.fn();
    render(
      <Legend simulatedPath hasSurveyed showPath onShowPathChange={onChange} />,
    );
    const toggle = screen.getByRole("switch", { name: "Flight path (simulated)" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

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

  it("names the three mass classes, the unshaded rest and both contour lines; the simulated labels are the map's own line", () => {
    render(<Legend simulatedPath hasSurveyed />);
    const classes = screen.getByRole("list", { name: "Probability classes" });
    expect(within(classes).getByText("Likeliest 50 %")).toBeInTheDocument();
    expect(within(classes).getByText("50 to 80 %")).toBeInTheDocument();
    expect(within(classes).getByText("80 to 90 %")).toBeInTheDocument();
    expect(within(classes).getByText("Outside 90 % of estimated probability")).toBeInTheDocument();
    expect(within(classes).getByText("Edge of the likeliest 50 %")).toBeInTheDocument();
    expect(within(classes).getByText("Edge of the 90 % region")).toBeInTheDocument();
    expect(screen.getByText(/on photographed ground/)).toBeInTheDocument();
    expect(screen.queryByText("Simulated flight path")).not.toBeInTheDocument();
    expect(screen.queryByText("Placeholder prior")).not.toBeInTheDocument();
    expect(screen.getByText("Surveyed area (outline)")).toBeInTheDocument();
    expect(screen.getByText("Not yet searched")).toBeInTheDocument();
  });

  it("never calls the unshaded ground empty or clear", () => {
    const { container } = render(<Legend simulatedPath hasSurveyed hasSightings hasUnsure />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\bclear(s|ed|ing)?\b/i);
    expect(text).not.toMatch(/\bempty\b/i);
    expect(text).not.toMatch(/\bno one\b|\bnobody\b/i);
  });

  it("colours the class swatches from the palette of the basemap under the map", () => {
    const { rerender } = render(<Legend simulatedPath hasSurveyed palette={HEAT_PALETTES.satellite} />);
    const swatch = () => within(screen.getByRole("list", { name: "Probability classes" })).getByText("Likeliest 50 %").querySelector("span") as HTMLElement;
    expect(swatch().style.background).toContain("rgb(227, 26, 28)"); // #e31a1c
    rerender(<Legend simulatedPath hasSurveyed palette={HEAT_PALETTES.dark} />);
    expect(swatch().style.background).toContain("rgb(254, 159, 109)"); // #fe9f6d
    expect(classSwatches(HEAT_PALETTES.dark)).toEqual([HEAT_PALETTES.dark.low, HEAT_PALETTES.dark.mid, HEAT_PALETTES.dark.top].map(swatchColor));
  });

  it("has a swatch for cells awaiting review", () => {
    render(<Legend simulatedPath={false} hasSurveyed />);
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
  });

  it("describes the search-next circles without promising a pulse (there is none under reduced motion)", () => {
    render(<Legend simulatedPath hasSurveyed />);
    expect(screen.getByText("Numbered as in the list; 1 is the likeliest")).toBeInTheDocument();
    expect(screen.queryByText(/pulses/)).toBeNull();
  });

});

describe("FoundBanner", () => {
  it("names one find with its photo, coordinates to 6 decimals and the position uncertainty", () => {
    render(<FoundBanner finds={[{ id: "f0005-d01", lat: 49.3712345678, lon: -122.9461234, radius_m: 10 }]} />);
    expect(screen.getByText("Person sighted: send ground team to check")).toBeInTheDocument();
    expect(screen.getByText("Photo f0005")).toBeInTheDocument();
    expect(screen.getByText("49.371235, -122.946123")).toBeInTheDocument();
    expect(screen.getByText("±10 m position uncertainty")).toBeInTheDocument();
  });

  it("lists every confirmed find, labels a simulated radius, and flies to a find", () => {
    const onFlyTo = vi.fn();
    const finds = [
      { id: "f0005-d01", lat: 49.371, lon: -122.946, radius_m: 10 },
      { id: "f0120-d02", lat: 49.369, lon: -122.944, radius_m: 10 },
    ];
    render(<FoundBanner finds={finds} simulatedRadius onFlyTo={onFlyTo} readingFor={(id) => (id === "f0005-d01" ? "R1" : undefined)} />);
    expect(screen.getByText("R1")).toBeInTheDocument();
    expect(screen.getByText("2 people sighted: send ground teams to check")).toBeInTheDocument();
    expect(screen.getAllByText("±10 m radius · simulated")).toHaveLength(2);
    screen.getAllByRole("button", { name: "Fly to it" })[1]!.click();
    expect(onFlyTo).toHaveBeenCalledWith(finds[1]);
    // A touch target on phones (44 px), at least 24 px with a mouse.
    expect(screen.getAllByRole("button", { name: "Fly to it" })[0]).toHaveClass("min-h-11", "lg:min-h-6");
  });

  it("renders nothing without a find", () => {
    const { container } = render(<FoundBanner finds={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
