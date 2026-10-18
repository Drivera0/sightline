import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache, useCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { MetricsView } from "./MetricsView";
import {
  bestByAp50,
  deltaPts,
  isResizedRow,
  pct,
  seconds,
  speedup,
} from "./format";

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
  useCache.setState({
    status: "ready",
    data: cache,
    error: null,
    dir: "sample",
  });
});

describe("format helpers", () => {
  it("formats percentages and deltas", () => {
    expect(pct(0.812)).toBe("81%");
    expect(pct(0.812, 1)).toBe("81.2%");
    expect(deltaPts(0.8, 0.68)).toBe("+12 pts");
    expect(deltaPts(0.5, 0.68)).toBe("−18 pts");
    expect(deltaPts(0.68, 0.68)).toBe("±0 pts");
  });

  it("formats time and speed-ups", () => {
    expect(seconds(33)).toBe("33 s");
    expect(seconds(0.9)).toBe("0.90 s");
    expect(seconds(1.25)).toBe("1.3 s");
    expect(speedup(0.9, 33)).toBe("37× faster");
    expect(speedup(33, 33)).toBe("about the same");
    expect(speedup(0, 33)).toBe("—");
  });

  it("picks the best ablation row by AP50 and flags no-tiling rows", () => {
    expect(
      bestByAp50([
        { voc: { ap50: 0.2 } },
        { voc: { ap50: 0.7 } },
        { voc: { ap50: 0.7 } },
      ]),
    ).toBe(1);
    expect(bestByAp50([])).toBe(-1);
    expect(isResizedRow("Stock model, no tiling")).toBe(true);
    expect(isResizedRow("Fine-tuned + tiling")).toBe(false);
  });
});

describe("MetricsView", () => {
  it("shows our recall, precision and speed against the human baseline", () => {
    render(<MetricsView />);

    expect(
      screen.getByRole("heading", { name: /human baseline/i }),
    ).toBeInTheDocument();
    // sample metrics.json: recall 0.80 vs 0.68, precision 0.812 vs 0.59, 0.9 s vs 33 s
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("+12 pts better")).toBeInTheDocument();
    expect(screen.getByText("81%")).toBeInTheDocument();
    expect(screen.getByText("+22 pts better")).toBeInTheDocument();
    expect(screen.getByText("0.90 s")).toBeInTheDocument();
    expect(screen.getByText("37× faster")).toBeInTheDocument();
  });

  it("marks sample numbers as such", () => {
    render(<MetricsView />);
    expect(screen.getByText("Sample numbers")).toBeInTheDocument();
  });

  it("lists the four ablation rows, labels the untiled ones, and highlights the best", () => {
    render(<MetricsView />);

    const table = screen.getByRole("table", { name: "Ablations" });
    const rows = within(table).getAllByRole("row").slice(1); // skip the header
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Stock model, no tiling");
    expect(rows[0]).toHaveTextContent("resized to 1024");
    expect(rows[2]).not.toHaveTextContent("resized to 1024");
    expect(rows[3]).toHaveTextContent("+ hard negatives");
    expect(rows[3]).toHaveTextContent("best");
    expect(rows[3]).toHaveAttribute("data-highlight", "true");
    expect(rows[2]).not.toHaveAttribute("data-highlight");
    expect(within(rows[3]!).getByText("76.6%")).toBeInTheDocument();
  });

  it("shows the ranking result: ranked vs the random-order expectation, this flight's order last", () => {
    render(<MetricsView />);

    const table = screen.getByRole("table", { name: "Ranking" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Ranked by detector");
    expect(rows[0]).toHaveAttribute("data-highlight", "true");
    expect(within(rows[0]!).getByText("1")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Random order, expected");
    expect(within(rows[1]!).getByText("7")).toBeInTheDocument();
    // 7 photos at the published 33 s each, in minutes
    expect(within(rows[1]!).getByText(/^3\.\d min$/)).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("This flight's order (one layout)");
    expect(rows[2]).not.toHaveAttribute("data-highlight");
  });

  it("shows the search simulation with its simulated badge", () => {
    render(<MetricsView />);

    expect(screen.getByText("Simulated evaluation")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Search simulation" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent("Sightline: canopy-aware");
    expect(within(rows[2]!).getByText("120")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("450")).toBeInTheDocument();
  });

  it("gives every number a source tooltip", () => {
    const { container } = render(<MetricsView />);

    const numbers = container.querySelectorAll("span.font-mono.tabular-nums");
    expect(numbers.length).toBeGreaterThan(20);
    for (const el of numbers) {
      expect(el.getAttribute("title")).toMatch(/metrics\.|arXiv/);
    }
    expect(
      screen.getAllByText(/HERIDAL test set, 101 images/).length,
    ).toBeGreaterThan(0);
  });

  it("renders from an explicit metrics prop too", () => {
    const custom = {
      ...cache.metrics,
      detector: { ...cache.metrics.detector, model: "yolo11s-x" },
    };
    render(<MetricsView metrics={custom} />);
    expect(screen.getByText("yolo11s-x")).toBeInTheDocument();
    expect(screen.queryByText("Sample numbers")).not.toBeInTheDocument();
  });
});

describe("motion", () => {
  it("renders the final numbers at once when reduced motion is preferred (as in jsdom)", async () => {
    const { prefersReducedMotion } = await import("./motion");
    expect(prefersReducedMotion()).toBe(true); // jsdom has no matchMedia
    render(<MetricsView />);
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByLabelText("80%")).toBeInTheDocument();
  });

  it("shows comparison bars for each headline tile", () => {
    render(<MetricsView />);
    expect(
      screen.getAllByRole("img", { name: /bars compare ours to human/ }),
    ).toHaveLength(3);
  });
});

describe("ablation rows that were not measured", () => {
  const withAblations = (ablations: CacheBundle["metrics"]["ablations"]) => ({
    ...cache.metrics,
    detector: { ...cache.metrics.detector, model: "yolo11s-heridal-tiled" },
    ablations,
  });

  it("shows a missing row as not yet measured, never as numbers", () => {
    render(
      <MetricsView
        metrics={withAblations(cache.metrics.ablations.slice(0, 3))}
      />,
    );
    const rows = within(screen.getByRole("table", { name: "Ablations" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent("+ hard negatives");
    expect(rows[3]).toHaveTextContent("Not yet measured");
    expect(rows[3]).not.toHaveTextContent("%");
    expect(rows[2]).toHaveTextContent("best"); // best is chosen among measured rows only
  });

  it("treats an all-zero row (a placeholder) as not measured", () => {
    const zero = { precision: 0, recall: 0, ap50: 0 };
    const rows4 = cache.metrics.ablations.map((r, i) =>
      i === 3 ? { ...r, voc: zero } : r,
    );
    render(<MetricsView metrics={withAblations(rows4)} />);
    const rows = within(screen.getByRole("table", { name: "Ablations" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows[3]).toHaveTextContent("Not yet measured");
    expect(rows[3]).not.toHaveTextContent("0.0%");
  });

  it("never renders any all-zero row as a result", () => {
    const zero = { precision: 0, recall: 0, ap50: 0 };
    const allZero = cache.metrics.ablations.map((r) => ({ ...r, voc: zero }));
    const { container } = render(
      <MetricsView metrics={withAblations(allZero)} />,
    );
    const table = screen.getByRole("table", { name: "Ablations" });
    expect(within(table).getAllByText("Not yet measured")).toHaveLength(4);
    expect(table.textContent).not.toMatch(/0\.0%/);
    expect(container.querySelector('[data-measured="false"]')).not.toBeNull();
  });
});

describe("ablationDisplayRows", () => {
  it("keeps canonical order, fills gaps, and appends unknown rows", async () => {
    const { ablationDisplayRows } = await import("./format");
    const v = { precision: 0.5, recall: 0.5, ap50: 0.5 };
    const out = ablationDisplayRows([
      { name: "Fine-tuned + tiling", voc: v },
      { name: "Extra", voc: v },
    ]);
    expect(out.map((r) => [r.name, r.measured])).toEqual([
      ["Stock model, no tiling", false],
      ["Fine-tuned, no tiling", false],
      ["Fine-tuned + tiling", true],
      ["+ hard negatives", false],
      ["Extra", true],
    ]);
  });
});

describe("search simulation highlighting", () => {
  it("highlights the method with the fewest median cells, not always the Sightline row", () => {
    const methods = [
      { name: "Prior only", median_cells: 1260, p90_cells: 2246 },
      {
        name: "Naive: photographed = cleared",
        median_cells: 1177,
        p90_cells: 2131,
      },
      { name: "Sightline: canopy-aware", median_cells: 1192, p90_cells: 2149 },
    ];
    const metrics = {
      ...cache.metrics,
      search_sim: { ...cache.metrics.search_sim, methods },
    };
    render(<MetricsView metrics={metrics} />);
    const rows = within(
      screen.getByRole("table", { name: "Search simulation" }),
    )
      .getAllByRole("row")
      .slice(1);
    expect(rows[1]).toHaveAttribute("data-highlight", "true");
    expect(rows[2]).not.toHaveAttribute("data-highlight");
  });
});

describe("search simulation: inside the surveyed area, and ties", () => {
  const methods = (prior: number, naive: number, sightline: number) => [
    { name: "Prior only", median_cells: prior, p90_cells: prior + 100 },
    {
      name: "Naive: photographed = cleared",
      median_cells: naive,
      p90_cells: naive + 120,
    },
    {
      name: "Sightline: canopy-aware",
      median_cells: sightline,
      p90_cells: sightline + 130,
    },
  ];
  const withSim = (search_sim: CacheBundle["metrics"]["search_sim"]) => ({
    ...cache.metrics,
    search_sim,
  });

  it("highlights nothing when the fewest cells is a tie", () => {
    const sim = {
      ...cache.metrics.search_sim,
      methods: methods(1260, 1201, 1201),
      in_survey: null,
    };
    render(<MetricsView metrics={withSim(sim)} />);
    const table = screen.getByRole("table", { name: "Search simulation" });
    expect(table.querySelector('[data-highlight="true"]')).toBeNull();
  });

  it("shows the inside-the-survey numbers when present, highlighting the real winner", () => {
    const sim = {
      ...cache.metrics.search_sim,
      methods: methods(1260, 1201, 1201),
      in_survey: { trials: 2000, methods: methods(147, 121, 110) },
    };
    render(<MetricsView metrics={withSim(sim)} />);
    const inside = screen.getByRole("table", {
      name: "Search simulation inside the surveyed area",
    });
    const rows = within(inside).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent("Sightline: canopy-aware");
    expect(rows[2]).toHaveAttribute("data-highlight", "true");
    expect(within(rows[2]!).getByText("110")).toBeInTheDocument();
    expect(
      screen.getByText(/2,000 trials whose person was in a photographed cell/),
    ).toBeInTheDocument();
  });

  it("says plainly when the inside-the-survey numbers are not measured", () => {
    const sim = { ...cache.metrics.search_sim, in_survey: null };
    render(<MetricsView metrics={withSim(sim)} />);
    expect(
      screen.queryByRole("table", {
        name: "Search simulation inside the surveyed area",
      }),
    ).toBeNull();
    expect(
      screen.getByText(/Inside-the-survey numbers: not yet measured/),
    ).toBeInTheDocument();
  });
});
