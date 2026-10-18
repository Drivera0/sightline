import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle, Metrics } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { MISSES_BY_SITE, MISSES_BY_SIZE, ResultsCharts, ROBUSTNESS_5M } from "./ResultsCharts";
import { ResultsSummary } from "./ResultsSummary";

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
});

const v = (precision: number, recall: number, ap50: number) => ({ precision, recall, ap50 });

/** The live demo's numbers: seven ablation rows, the 5 m search run, the human baseline. */
function demo(): Metrics {
  const m = structuredClone(cache.metrics);
  m.ablations = [
    { name: "Stock model, no tiling", voc: v(0.42, 0.196, 0.142) },
    { name: "Fine-tuned on tiles, run on shrunk photos", voc: v(0.38, 0.234, 0.144) },
    { name: "Stock model, full-resolution photo", voc: v(0.678, 0.181, 0.165) },
    { name: "Fine-tuned on tiles, full-resolution photo", voc: v(0.723, 0.905, 0.887) },
    { name: "Trained and run on whole photos", voc: v(0.727, 0.804, 0.776) },
    { name: "Fine-tuned + tiling", voc: v(0.802, 0.864, 0.868) },
    { name: "+ hard negatives", voc: v(0.738, 0.869, 0.851) },
  ];
  m.detector.sar = { precision: 0.898, recall: 0.896, ap: 0.921 };
  m.detector.seconds_per_image = 0.251;
  m.baseline_human = { ...m.baseline_human, precision: 0.59, recall: 0.68, seconds_per_image: 33 };
  m.search_sim.seed = 7;
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

const chart = (name: string) => screen.getByRole("figure", { name });

describe("the cited tables", () => {
  it("add up to the test set: 337 people, 46 missed", () => {
    expect(MISSES_BY_SITE.reduce((s, r) => s + r.people, 0)).toBe(337);
    expect(MISSES_BY_SITE.reduce((s, r) => s + r.missed, 0)).toBe(46);
    expect(MISSES_BY_SIZE.reduce((s, r) => s + r.people, 0)).toBe(337);
  });

  it("hold the demo's own run at the default noise, so the gate can match it", () => {
    const first = ROBUSTNESS_5M[0]!;
    expect(first.noise).toBe(0.15);
    expect(first.naive[0]).toBe(1743);
    expect(first.sightline[0]).toBe(1213);
  });
});

describe("time to read a survey", () => {
  it("compares a person and the detector on 500 full photos, in hours and minutes", () => {
    render(<ResultsCharts metrics={demo()} />);
    const fig = chart("Time to read a survey of 500 full photos");
    expect(within(fig).getByText("4 h 35 min")).toBeInTheDocument(); // 500 × 33 s
    expect(within(fig).getByText("2 min")).toBeInTheDocument(); // 500 × 0.251 s
  });
});

describe("precision and recall map", () => {
  it("plots every measured variant and AIR under strict scoring, labelling the one in use", () => {
    render(<ResultsCharts metrics={demo()} />);
    const fig = chart("How many people it finds, and how often its alerts are right");
    expect(fig.querySelectorAll("[data-point]")).toHaveLength(8); // 7 variants + AIR
    expect(within(fig).getByText("Sightline (in use)")).toBeInTheDocument();
    expect(within(fig).getByText("AIR")).toBeInTheDocument();
    // People were scored only with the looser rule, so they are not on the strict plot.
    expect(within(fig).queryByText("People")).toBeNull();
  });

  it("switches to the human study's scoring, where people, Sightline and AIR can sit together", () => {
    render(<ResultsCharts metrics={demo()} />);
    const fig = chart("How many people it finds, and how often its alerts are right");
    fireEvent.click(within(fig).getByRole("button", { name: "Scored like the human study" }));
    expect(fig.querySelectorAll("[data-point]")).toHaveLength(3);
    expect(within(fig).getByText("People")).toBeInTheDocument();
    expect(within(fig).getByText("Sightline")).toBeInTheDocument();
  });

  it("has a table with every point, for screen readers and exact values", () => {
    render(<ResultsCharts metrics={demo()} />);
    const table = within(chart("How many people it finds, and how often its alerts are right")).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(9); // header + 8
    expect(within(table).getByText("AIR (Pyrrö et al. 2021)")).toBeInTheDocument();
  });
});

describe("search robustness", () => {
  it("draws Sightline and the naive map across canopy-noise levels, marking our measured error", () => {
    render(<ResultsCharts metrics={demo()} surveyId="seymour-demo" cellM={5} />);
    const fig = chart("Does the map still help if our tree-cover estimate is wrong?");
    expect(fig.querySelectorAll("[data-series='sightline'] [data-point]")).toHaveLength(5);
    expect(fig.querySelectorAll("[data-series='naive'] [data-point]")).toHaveLength(5);
    expect(within(fig).getByText("our measured error")).toBeInTheDocument();
    expect(within(fig).getAllByText(/simulated/i).length).toBeGreaterThan(0);
  });

  it("stays off for any other run, because the table was measured on this one", () => {
    const other = demo();
    other.search_sim.in_survey!.methods[2]!.median_cells = 1300;
    render(<ResultsCharts metrics={other} surveyId="seymour-demo" cellM={5} />);
    expect(screen.queryByRole("figure", { name: "Does the map still help if our tree-cover estimate is wrong?" })).toBeNull();
  });
});

describe("where it misses", () => {
  it("ranks the test sites worst first and gives the size bins with their counts", () => {
    render(<ResultsCharts metrics={demo()} />);
    const fig = chart("Where the detector misses people");
    const sites = within(within(fig).getByRole("list", { name: "People found, by test site" })).getAllByRole("listitem");
    expect(sites.map((s) => s.dataset.label)).toEqual(["CAB", "MED", "ZRI", "BLI", "CAP, GRO", "6 other sites"]);
    const sizes = within(within(fig).getByRole("list", { name: "People found, by how big the person looks" })).getAllByRole("listitem");
    expect(sizes).toHaveLength(4);
    expect(sizes[3]).toHaveTextContent("10 people");
  });
});

describe("on the Results page", () => {
  it("sits below the three cards", () => {
    render(<ResultsSummary metrics={demo()} surveyId="seymour-demo" cellM={5} />);
    expect(chart("Where the detector misses people")).toBeInTheDocument();
  });
});
