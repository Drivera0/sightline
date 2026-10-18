import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { useReview } from "../review/store";
import { Shell } from "./Shell";

// jsdom has no WebGL: stand in for lane B's map and show what the shell passes it.
vi.mock("../map/MapView", () => ({
  MapView: ({ layers }: { layers?: ReactNode }) => <div data-testid="map-view">{layers}</div>,
}));

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
  localStorage.clear();
  useReview.setState({ surveyId: null, history: [], answers: {} });
  window.location.hash = "";
});

const stepBar = () => screen.getByRole("navigation", { name: "Demo steps" });
const current = () => within(stepBar()).getByRole("button", { current: "step" });

describe("guided flow", () => {
  it("opens on the survey, with the size of the job and one clear action", () => {
    render(<Shell cache={cache} />);
    expect(current()).toHaveTextContent("Survey");
    expect(screen.getByRole("heading", { name: /20 drone photos/ })).toBeInTheDocument();
    // The human miss rate comes from metrics.baseline_human.recall.
    expect(screen.getByText(/of people missed by eye/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rank with Sightline" })).toBeInTheDocument();
  });

  it("ranks, then reveals the queue headline from the ranking metrics", async () => {
    render(<Shell cache={cache} />);
    await userEvent.click(screen.getByRole("button", { name: "Rank with Sightline" }));
    expect(current()).toHaveTextContent("Rank");
    // sample metrics: ranked.frames_to_first_hit = 1
    expect(await screen.findByText(/first photo you see/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 20 photos flagged/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(current()).toHaveTextContent("Review");
  });

  it("shows the review queue and the map side by side, with the keys always visible", () => {
    window.location.hash = "#review";
    render(<Shell cache={cache} />);
    expect(screen.getByRole("list", { name: "Candidates" })).toBeInTheDocument();
    expect(screen.getByTestId("mount-map")).toBeInTheDocument();
    const hints = screen.getByRole("region", { name: "Review keys" });
    for (const label of ["Person", "Not a person", "Unsure", "Undo"]) {
      expect(within(hints).getByText(label)).toBeInTheDocument();
    }
  });

  it("puts lane C's heat layer inside the map on the search step", () => {
    window.location.hash = "#search";
    render(<Shell cache={cache} />);
    expect(within(screen.getByTestId("map-view")).getByTestId("mount-heat")).toBeInTheDocument();
    expect(screen.getByText(/Dark ground is not yet searched/)).toBeInTheDocument();
  });

  it("ends on the results headline numbers, with the full metrics below", () => {
    window.location.hash = "#results";
    render(<Shell cache={cache} />);
    const headline = screen.getByRole("region", { name: "Results" });
    expect(within(headline).getByText(/Recall/)).toBeInTheDocument();
    expect(screen.getByTestId("mount-metrics")).toBeInTheDocument();
  });

  it("loads saved review answers on the results step after a reload, without visiting Review", () => {
    useReview.setState({ surveyId: null, history: [], answers: {} });
    localStorage.setItem(
      `sightline.review.${cache.survey.survey_id}`,
      JSON.stringify([{ detectionId: "f0005-d01", answer: "person", at: 1 }]),
    );
    window.location.hash = "#results";
    render(<Shell cache={cache} />);
    expect(useReview.getState().answers).toEqual({ "f0005-d01": "person" });
    localStorage.removeItem(`sightline.review.${cache.survey.survey_id}`);
  });

  it("moves between steps with the number keys and the step bar, and keeps the hash in sync", async () => {
    render(<Shell cache={cache} />);
    await userEvent.keyboard("3");
    expect(current()).toHaveTextContent("Review");
    expect(window.location.hash).toBe("#review");
    await userEvent.click(within(stepBar()).getByRole("button", { name: /Results/ }));
    expect(current()).toHaveTextContent("Results");
  });

  it("M in the review queue goes to the search step", async () => {
    window.location.hash = "#review";
    render(<Shell cache={cache} />);
    await userEvent.keyboard("m");
    expect(current()).toHaveTextContent("Search next");
  });
});
