import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { placeName } from "../shell/SurveyIntro";
import { useReview } from "../review/store";
import { pct } from "./format";
import { duration, fewer, medianGapSeconds, ResultsSummary, seedNote } from "./ResultsSummary";

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
});

describe("ResultsSummary", () => {
  it("counts photos with a person, not people", () => {
    const m = structuredClone(cache.metrics);
    m.ranking.n_frames = 500;
    m.ranking.n_positive = 6;
    m.ranking.ranked.frames_to_all_hits = 7;
    render(<ResultsSummary metrics={m} />);
    expect(
      screen.getByRole("heading", { name: "All 6 photos with a person were in the first 7 photos of the queue." }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/people were in/)).toBeNull();
    expect(screen.getByText("This flight's order")).toBeInTheDocument();
  });

  it("says ranking has nothing to reorder when every photo has a person, and drops the race", () => {
    const m = structuredClone(cache.metrics);
    m.ranking.n_frames = 10;
    m.ranking.n_positive = 10;
    render(<ResultsSummary metrics={m} />);
    expect(screen.getByRole("heading", { name: "Every photo in this survey contains a person." })).toBeInTheDocument();
    expect(screen.queryByText("This flight's order")).toBeNull();
  });
});

describe("ResultsSummary in time and in your own answers", () => {
  beforeEach(() => useReview.setState({ history: [], answers: {}, cleared: null }));

  it("says the saving in photos and as a share of the survey, never in minutes at 33 s per section", () => {
    const m = structuredClone(cache.metrics);
    m.ranking.n_frames = 500;
    m.ranking.n_positive = 6;
    m.ranking.ranked.frames_to_all_hits = 7;
    m.ranking.flight_order.frames_to_all_hits = 336;
    m.baseline_human.seconds_per_image = 33;
    render(<ResultsSummary metrics={m} />);
    // One sentence under the headline; the race below carries the spread and this flight's order.
    const line = screen.getByText(/photos; a random order needs/);
    // Random order: E[last] = 6 x 501 / 7 = 429.4.
    expect(line).toHaveTextContent(/^That is 1\.4% of the 500 photos; a random order needs about 429\.$/);
    expect(screen.getByText("expected value; 10–90%: 342–492")).toBeInTheDocument();
    expect(screen.getByText("336")).toBeInTheDocument();
    // The survey's photos are sections of full photos; the human time is per full photo.
    expect(screen.queryByText(/min of looking|3 h 5 min/)).toBeNull();
    expect(screen.getByText("Time per full photo")).toBeInTheDocument();
    expect(screen.getByText(/For a whole 4000×3000 photo/)).toBeInTheDocument();
  });

  it("races the queue against the expected random order, with its spread, and this flight's order", () => {
    const m = structuredClone(cache.metrics);
    m.ranking.n_frames = 500;
    m.ranking.n_positive = 6;
    render(<ResultsSummary metrics={m} />);
    expect(screen.getByText("Random order")).toBeInTheDocument();
    expect(screen.getByText("expected value; 10–90%: 342–492")).toBeInTheDocument();
    expect(screen.getByText("one layout, as flown")).toBeInTheDocument();
  });

  it("summarises the reviewer's own answers for this survey's candidates", () => {
    useReview.setState({
      history: [
        { detectionId: "a", answer: "person", at: 0 },
        { detectionId: "b", answer: "not_person", at: 30_000 },
        { detectionId: "x", answer: "person", at: 40_000 },
      ],
      answers: { a: "person", b: "not_person", x: "person" },
    });
    render(<ResultsSummary metrics={cache.metrics} candidateIds={["a", "b", "c"]} />);
    // "x" is not one of this survey's candidates, so it is not counted.
    expect(screen.getByText(/2 of 3 candidates answered/)).toHaveTextContent("a median of 30 s per answer");
    expect(screen.getByText("Not answered").nextSibling).toHaveTextContent("1");
  });

  it("lets a new reviewer on a shared machine reset the saved answers from the summary", async () => {
    useReview.setState({
      surveyId: null,
      cleared: null,
      history: [{ detectionId: "a", answer: "person", at: 0 }],
      answers: { a: "person" },
    });
    render(<ResultsSummary metrics={cache.metrics} candidateIds={["a"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset review" }));
    expect(screen.getByText(/haven't answered any of the 1 candidates/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("asks for a review before there are answers", () => {
    render(<ResultsSummary metrics={cache.metrics} candidateIds={["a"]} />);
    expect(screen.getByText(/haven't answered any of the 1 candidates/)).toBeInTheDocument();
  });
});

describe("Results recall figures", () => {
  it("names the scoring next to each recall figure", () => {
    render(<ResultsSummary metrics={cache.metrics} />);
    const big = screen.getByText(pct(cache.metrics.detector.sar.recall), { selector: ".text-display" });
    expect(big.closest("div")).toHaveTextContent(`${pct(cache.metrics.detector.sar.recall)}SAR-APD`);
    expect(screen.getByText(new RegExp(`Strict VOC: ${pct(cache.metrics.detector.voc.recall)}`))).toBeInTheDocument();
  });
});

describe("Why resolution matters", () => {
  const v = (precision: number, recall: number, ap50: number) => ({ precision, recall, ap50 });
  const sevenRows = [
    { name: "Stock model, no tiling", voc: v(0.42, 0.196, 0.142) },
    { name: "Fine-tuned on tiles, run on shrunk photos", voc: v(0.38, 0.234, 0.144) },
    { name: "Stock model, full-resolution photo", voc: v(0.678, 0.181, 0.165) },
    { name: "Fine-tuned on tiles, full-resolution photo", voc: v(0.723, 0.905, 0.887) },
    { name: "Trained and run on whole photos", voc: v(0.727, 0.804, 0.776) },
    { name: "Fine-tuned + tiling", voc: v(0.802, 0.864, 0.868) },
    { name: "+ hard negatives", voc: v(0.738, 0.869, 0.851) },
  ];
  const bars = () => within(screen.getByRole("list", { name: "Recall by how the photo is read" })).getAllByRole("listitem");

  it("draws five bars from a seven-row file and highlights the tiled detector in use, not the best AP50", () => {
    render(<ResultsSummary metrics={{ ...cache.metrics, ablations: sevenRows }} />);
    const rows = bars();
    expect(rows.map((r) => r.textContent)).toEqual([
      "Stock, shrunk photo20%42%",
      "Fine-tuned, shrunk photo23%38%",
      "Trained on 1920 px photos80%73%",
      "Fine-tuned + tilingin use86%80%",
      "Fine-tuned, one 4000 px pass91%72%",
    ]);
    expect(rows.filter((r) => r.dataset.inUse)).toEqual([rows[3]]);
    expect(screen.getByText("needs about 20× the GPU memory")).toBeInTheDocument();
    expect(screen.getByText(/single full-resolution pass is not the model in use/)).toBeInTheDocument();
  });

  it("reads an old four-row file under the new names and leaves out the single-pass sentence", () => {
    render(<ResultsSummary metrics={cache.metrics} />); // sample: old names, four rows
    const rows = bars();
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("Fine-tuned, shrunk photo");
    expect(rows[2]).toHaveAttribute("data-in-use", "true");
    expect(screen.queryByText(/20× the GPU memory/)).toBeNull();
  });
});

describe("medianGapSeconds", () => {
  it("ignores one long pause between answers", () => {
    expect(medianGapSeconds([0, 4_000, 9_000, 600_000, 605_000])).toBe(5);
    expect(medianGapSeconds([1_000])).toBeNull();
  });
});

describe("duration", () => {
  it("reads like a person would say it", () => {
    expect(duration(231)).toBe("4 min");
    expect(duration(11_088)).toBe("3 h 5 min");
    expect(duration(7_200)).toBe("2 h");
    expect(duration(20)).toBe("20 s");
  });
});

describe("placeName", () => {
  it("drops a trailing parenthetical from the survey's area name", () => {
    expect(placeName("Mount Seymour, North Vancouver (simulated flight path)")).toBe("Mount Seymour, North Vancouver");
    expect(placeName("HERIDAL SB site (real EXIF positions)")).toBe("HERIDAL SB site");
    expect(placeName("Somewhere")).toBe("Somewhere");
  });
});

describe("fewer", () => {
  it("gives a percentage only when it means something", () => {
    expect(fewer(98, 123)).toBe("20% fewer");
    expect(fewer(11, 13)).toBeUndefined(); // the real-GPS survey: 2 cells is not "15% fewer"
    expect(fewer(5, 20)).toBe("75% fewer"); // a gap of 15 cells
    expect(fewer(123, 98)).toBeUndefined();
  });
});

describe("seedNote", () => {
  it("names the seed, and 'best of 3' only for the run the docs describe", () => {
    expect(seedNote(7, "seymour-demo", 1213, 1743)).toBe("Simulation seed 7, the best of 3 seeds tried");
    expect(seedNote(7, "seymour-demo", 98, 123)).toBe("Simulation seed 7");
    expect(seedNote(7, "heridal-sb", 11, 13)).toBe("Simulation seed 7");
    expect(seedNote(7, undefined, 98, 123)).toBe("Simulation seed 7");
  });
});
