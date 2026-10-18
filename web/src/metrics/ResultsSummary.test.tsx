import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { placeName } from "../shell/SurveyIntro";
import { ResultsSummary } from "./ResultsSummary";

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

describe("placeName", () => {
  it("drops a trailing parenthetical from the survey's area name", () => {
    expect(placeName("Mount Seymour, North Vancouver (simulated flight path)")).toBe("Mount Seymour, North Vancouver");
    expect(placeName("HERIDAL SB site (real EXIF positions)")).toBe("HERIDAL SB site");
    expect(placeName("Somewhere")).toBe("Somewhere");
  });
});
