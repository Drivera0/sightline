import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle, Metrics } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { ResultsSummary } from "./ResultsSummary";

// The Results summary read by a rescue volunteer or a judge with no computer-science background:
// every technical name the page keeps (because a figure is known by it) has plain words beside it.

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
});

const v = (precision: number, recall: number, ap50: number) => ({ precision, recall, ap50 });

/** The Mount Seymour demo's shape: 500 photos, 6 with a person, a 5 m search grid, all seven ablation rows. */
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
  m.ablations = [
    { name: "Stock model, no tiling", voc: v(0.42, 0.196, 0.142) },
    { name: "Fine-tuned on tiles, run on shrunk photos", voc: v(0.38, 0.234, 0.144) },
    { name: "Stock model, full-resolution photo", voc: v(0.678, 0.181, 0.165) },
    { name: "Fine-tuned on tiles, full-resolution photo", voc: v(0.723, 0.905, 0.887) },
    { name: "Trained and run on whole photos", voc: v(0.727, 0.804, 0.776) },
    { name: "Fine-tuned + tiling", voc: v(0.802, 0.864, 0.868) },
    { name: "+ hard negatives", voc: v(0.738, 0.869, 0.851) },
  ];
  return m;
}

const region = () => screen.getByRole("region", { name: "Results" });
const card = (name: string) => screen.getByRole("group", { name });
/** An element's own text, without its children's: where a word is actually written. */
const ownText = (el: Element) =>
  [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("");
/** Every element in the Results region that writes `term` itself. */
const writing = (term: string) => [...region().querySelectorAll("*")].filter((el) => ownText(el).includes(term));

describe("the race, in plain words", () => {
  it("says what a bar counts once, in the section's plain line above the chart", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(screen.getByRole("region", { name: "How much looking it saves" })).toHaveTextContent(
      /Photos a searcher looks at before every person in them is found/,
    );
  });

  it("puts plain words under the statistics of the random order and the flight's order", () => {
    render(<ResultsSummary metrics={demo()} />);
    const random = screen.getByText("expected value; 10–90%: 342–492").parentElement!;
    expect(random).toHaveTextContent("on average; 8 in 10 shuffles finish in that range");
    const flight = screen.getByText("one layout, as flown").parentElement!;
    expect(flight).toHaveTextContent("photos in the order the drone took them");
  });
});

describe("the cards, in plain words", () => {
  it("says what the strict score demands beside the strict figure", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(within(card("People found")).getByText(/test photos the detector never saw in training/)).toBeInTheDocument();
    for (const el of writing("VOC")) expect(ownText(el)).toMatch(/box must match the person closely/);
    expect(writing("VOC").length).toBeGreaterThan(0);
  });

  it("keeps SAR-APD only beside the words 'scored like the human study'", () => {
    render(<ResultsSummary metrics={demo()} />);
    for (const el of writing("SAR-APD")) expect(el.parentElement).toHaveTextContent("scored like the human study");
  });

  it("says how big a full photo is next to the photos on this page", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(within(card("Time per full photo")).getByText(/16 times the area of each photo here/)).toBeInTheDocument();
  });

  it("explains the naive map and the seed on the simulated search card", () => {
    render(<ResultsSummary metrics={demo()} surveyId="seymour-demo" cellM={5} />);
    const search = card("Ground to search");
    expect(within(search).getByText("Simulated")).toBeInTheDocument();
    expect(within(search).getByText(/naive map counts every photographed patch as already searched/)).toBeInTheDocument();
    expect(within(search).getByText(/each seed is one simulation run/)).toBeInTheDocument();
  });

  it("says a missing search figure is not measured, without the cache's version number", () => {
    const m = demo();
    m.search_sim.in_survey = undefined;
    render(<ResultsSummary metrics={m} />);
    expect(screen.getByText(/Not measured for this survey yet/)).toBeInTheDocument();
    expect(region()).not.toHaveTextContent(/contract 1\.1/);
  });
});

describe("why resolution matters, in plain words", () => {
  it("explains tiling and the graphics card in the intro", () => {
    render(<ResultsSummary metrics={demo()} />);
    expect(screen.getByText(/cuts each photo into small tiles and checks them one by one/)).toBeInTheDocument();
    for (const el of writing("GPU")) expect(el.closest("p")).toHaveTextContent(/graphics card/);
  });

  it("names the two columns and the bar labels' words in plain language", () => {
    render(<ResultsSummary metrics={demo()} />);
    const key = screen.getByText(/people found \(recall\), then alerts that are real people \(precision\)/);
    expect(key).toHaveTextContent(/Stock is the detector as downloaded; fine-tuned is further trained on drone photos of people/);
  });
});

describe("no bare jargon on the Results summary", () => {
  it("never says inference, native resolution or tiled inference", () => {
    render(<ResultsSummary metrics={demo()} surveyId="seymour-demo" cellM={5} />);
    expect(region()).not.toHaveTextContent(/inference|native resolution/i);
  });
});
