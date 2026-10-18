import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { placeName } from "../shell/SurveyIntro";
import { useReview } from "../review/store";
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
    const line = screen.getByText(/to reach everyone/);
    expect(line).toHaveTextContent("That is 1.4% of the 500 photos to reach everyone.");
    // Random order: E[last] = 6 x 501 / 7 = 429.4; 10th percentile 342.
    expect(line).toHaveTextContent("A random order needs about 429 on average (9 in 10 random orders need at least 342)");
    expect(line).toHaveTextContent("one layout, not an average) needed 336");
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
    expect(seedNote(7, "seymour-demo", 98, 123)).toBe("Seed 7, the best of 3 seeds tried (docs/LANE_C_SEARCH.md)");
    expect(seedNote(7, "seymour-demo", 99, 123)).toBe("Seed 7");
    expect(seedNote(7, "heridal-sb", 11, 13)).toBe("Seed 7");
    expect(seedNote(7, undefined, 98, 123)).toBe("Seed 7");
  });
});
