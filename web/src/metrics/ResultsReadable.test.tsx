import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle, Metrics } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { axisTicks, ResultsSummary } from "./ResultsSummary";

// The Results page read by a person, not a reviewer of the code: units people think in, which way
// is good, plain words before jargon, and charts that carry a scale and a legend.

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
});

/** The Mount Seymour demo's shape: 500 frames, 6 with a person, a 5 m search grid. */
function demo(): Metrics {
  const m = structuredClone(cache.metrics);
  m.ranking.n_frames = 500;
  m.ranking.n_positive = 6;
  m.ranking.ranked.frames_to_first_hit = 1;
  m.ranking.ranked.frames_to_all_hits = 7;
  m.ranking.flight_order.frames_to_all_hits = 336;
  m.search_sim.in_survey = {
    trials: 1341,
    methods: [
      { name: "Prior only", median_cells: 2038, p90_cells: 3560 },
      { name: "Naive: photographed = cleared", median_cells: 1743, p90_cells: 3348 },
      { name: "Sightline: canopy-aware", median_cells: 1213, p90_cells: 2940 },
    ],
  };
  return m;
}

const card = (name: string) => screen.getByRole("group", { name });

describe("axisTicks", () => {
  it("steps by 1, 2 or 5 × a power of ten, at most six intervals, ending at or below the max", () => {
    expect(axisTicks(500)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(axisTicks(20)).toEqual([0, 5, 10, 15, 20]);
    expect(axisTicks(37)).toEqual([0, 10, 20, 30]);
    expect(axisTicks(1)).toEqual([0, 1]);
  });
});

describe("the three result cards", () => {
  it("say which way is better in the card, not at the end of a footnote", () => {
    render(<ResultsSummary metrics={demo()} cellM={5} />);
    expect(within(card("People found")).getByText("higher is better")).toBeInTheDocument();
    expect(within(card("Time per full photo")).getByText("lower is better")).toBeInTheDocument();
    expect(within(card("Ground to search")).getByText("lower is better")).toBeInTheDocument();
    expect(screen.queryByText(/\(lower is better\)/)).toBeNull();
  });

  it("put plain words beside the scoring name", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(within(card("People found")).getByText("scored like the human study")).toBeInTheDocument();
  });

  it("lead the search card with ground area, keeping the cell counts underneath", () => {
    render(<ResultsSummary metrics={demo()} cellM={5} />);
    const search = card("Ground to search");
    // 1,213 and 1,743 cells of 5 m × 5 m: 3.0 ha and 4.4 ha.
    expect(within(search).getByText("3.0 ha", { selector: ".text-display" })).toBeInTheDocument();
    expect(within(search).getByText("4.4 ha")).toBeInTheDocument();
    expect(within(search).getByText(/1,213 vs 1,743 cells/)).toBeInTheDocument();
    expect(within(search).getByText("30% less")).toBeInTheDocument();
  });

  it("highlight how much better Sightline is in green, like the details below", () => {
    const m = demo();
    m.detector.sar.recall = 0.896;
    m.baseline_human.recall = 0.68;
    m.detector.seconds_per_image = 0.251;
    m.baseline_human.seconds_per_image = 33;
    render(<ResultsSummary metrics={m} cellM={5} />);
    expect(within(card("People found")).getByText("+22 pts better")).toHaveClass("text-ok");
    expect(within(card("Time per full photo")).getByText("131× faster")).toHaveClass("text-ok");
    expect(within(card("Ground to search")).getByText("30% less")).toHaveClass("text-ok");
  });

  it("say so in amber when Sightline is worse, never in green", () => {
    const m = demo();
    m.detector.sar.recall = 0.6;
    m.baseline_human.recall = 0.68;
    render(<ResultsSummary metrics={m} cellM={5} />);
    expect(within(card("People found")).getByText("−8 pts worse")).toHaveClass("text-warn");
  });

  it("fall back to cells when the grid's cell size is unknown", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(within(card("Ground to search")).getByText("1,213", { selector: ".text-display" })).toBeInTheDocument();
  });

  it("set the big figures in the body sans with proportional digits, not monospace", () => {
    render(<ResultsSummary metrics={demo()} cellM={5} />);
    for (const big of document.querySelectorAll(".text-display")) {
      expect(big).not.toHaveClass("font-mono");
    }
  });
});

describe("the race", () => {
  it("has an axis from 0 to the survey's photo count", () => {
    render(<ResultsSummary metrics={demo()} />);
    const axis = screen.getByTestId("race-axis");
    expect([...axis.querySelectorAll("[data-tick]")].map((t) => t.textContent)).toEqual([
      "0",
      "100",
      "200",
      "300",
      "400",
      "500",
    ]);
  });

  it("explains its marks with a legend instead of a paragraph, and draws the spread solid", () => {
    render(<ResultsSummary metrics={demo()} />);
    const legend = screen.getByRole("list", { name: "Chart legend" });
    expect(within(legend).getByText("First person found")).toBeInTheDocument();
    expect(within(legend).getByText("8 in 10 random orders finish here")).toBeInTheDocument();
    expect(screen.queryByText(/dashed box/)).toBeNull();
    expect(document.querySelector("[data-band]")).not.toHaveClass("border-dashed");
  });

  it("marks the end of Sightline's short bar with a dot, and keeps the glow and the orange off the text", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(document.querySelector("[data-end-dot]")).toBeInTheDocument();
    expect(document.querySelector("[class*='shadow-[0_0_18px']")).toBeNull();
    expect(screen.getByText("7", { selector: "[data-count]" })).not.toHaveClass("text-accent-soft");
  });
});

describe("why resolution matters", () => {
  it("heads its two number columns instead of explaining them in a footnote", () => {
    render(<ResultsSummary metrics={demo()} />);
    const headers = screen.getByTestId("resolution-headers");
    expect(within(headers).getByText("Recall")).toBeInTheDocument();
    expect(within(headers).getByText("Precision")).toBeInTheDocument();
    expect(screen.queryByText(/grey figure is precision/)).toBeNull();
  });
});

describe("design critique fixes", () => {
  it("keeps each glance card to one plain line, with the measuring detail one click away", () => {
    render(<ResultsSummary metrics={demo()} cellM={5} />);
    for (const name of ["People found", "Time per full photo", "Ground to search"]) {
      const more = within(card(name)).getByText("How it's measured").closest("details")!;
      expect(more).not.toHaveAttribute("open");
    }
    // The scoring and simulation notes live inside the fold, not on the card face.
    const people = within(card("People found")).getByText(/Strict VOC/);
    expect(people.closest("details")).not.toBeNull();
    const ground = within(card("Ground to search")).getByText(/1,213 vs 1,743 cells/);
    expect(ground.closest("details")).not.toBeNull();
  });

  it("leads the race with Sightline, labels its result beside the dot, and drops the unlabelled % column", () => {
    render(<ResultsSummary metrics={demo()} />);
    const rows = [...document.querySelectorAll("[data-race-row]")].map((r) => r.getAttribute("data-race-row"));
    expect(rows).toEqual(["Sightline ranked queue", "This flight's order", "Random order"]);
    expect(screen.getByText("7 photos")).toBeInTheDocument();
    expect(screen.queryByText("85.9%")).toBeNull();
  });

  it("keeps the race's exact figures in a fold under the chart", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(screen.getByText("expected value; 10–90%: 342–492").closest("details")).not.toBeNull();
  });

  it("names the comparison 'People (by eye)' on the cards", () => {
    render(<ResultsSummary metrics={demo()} cellM={5} />);
    expect(within(card("People found")).getByText("People (by eye)")).toBeInTheDocument();
    expect(within(card("Time per full photo")).getByText("People (by eye)")).toBeInTheDocument();
    expect(screen.queryByText("Human")).toBeNull();
  });

  it("drops the small labels that repeated each section's title", () => {
    render(<ResultsSummary metrics={demo()} candidateIds={["a"]} />);
    expect(screen.queryByText("Where it still misses")).toBeNull();
    expect(screen.queryByText("Answers so far")).toBeNull();
    expect(screen.queryByText("Photos looked at before every person is found")).toBeNull();
  });
});
