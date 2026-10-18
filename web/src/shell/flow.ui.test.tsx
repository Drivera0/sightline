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
    expect(screen.getByRole("heading", { name: /20 photos from a simulated drone search over/ })).toBeInTheDocument();
    // The human miss rate comes from metrics.baseline_human.recall.
    expect(screen.getByText(/of people missed by eye/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start: rank 20 photos" })).toBeInTheDocument();
  });

  it("ranks, then reveals the queue headline from the ranking metrics", async () => {
    render(<Shell cache={cache} />);
    await userEvent.click(screen.getByRole("button", { name: "Start: rank 20 photos" }));
    expect(current()).toHaveTextContent("Rank");
    // sample metrics: ranked.frames_to_first_hit = 1
    expect(await screen.findByText(/first photo you see/)).toBeInTheDocument();
    expect(screen.getByTestId("rank-counts")).toHaveTextContent("3 of 20 photos flagged for review · 3 boxes");
    // The queue opens on #1, and the architecture waits behind a disclosure.
    const queue = screen.getByRole("list", { name: "Ranked candidates" });
    expect(queue.querySelector("li")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Start review" })).toHaveFocus();
    const how = screen.getByRole("button", { name: /How the detector works/ });
    expect(how).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(how);
    expect(how).toHaveAttribute("aria-expanded", "true");
    // It opens large, in a dialog with Close focused; Escape closes it and focus returns.
    const dialog = screen.getByRole("dialog", { name: "How the detector works" });
    expect(within(dialog).getByRole("button", { name: /Close/ })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "How the detector works" })).not.toBeInTheDocument();
    expect(how).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(current()).toHaveTextContent("Review");
  });

  it("shows the review queue and the map side by side, with the keys always visible", () => {
    window.location.hash = "#review";
    render(<Shell cache={cache} />);
    expect(screen.getByRole("listbox", { name: "Candidates" })).toBeInTheDocument();
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
    expect(screen.getByText(/Darker red = more likely. Grey = not yet photographed./)).toBeInTheDocument();
  });

  it("ends on the results headline numbers, with the full metrics below", () => {
    window.location.hash = "#results";
    render(<Shell cache={cache} />);
    const headline = screen.getByRole("region", { name: "Results" });
    expect(within(headline).getByText(/Recall/)).toBeInTheDocument();
    expect(screen.getByTestId("mount-metrics")).toBeInTheDocument();
  });

  it("gives Review and Search next one primary action that says what happens", async () => {
    window.location.hash = "#review";
    render(<Shell cache={cache} />);
    const nav = () => screen.getByRole("navigation", { name: "Step navigation" });
    await userEvent.click(within(nav()).getByRole("button", { name: /See where to search/ }));
    expect(current()).toHaveTextContent("Search next");
    await userEvent.click(within(nav()).getByRole("button", { name: /See results/ }));
    expect(current()).toHaveTextContent("Results");
    expect(screen.queryByRole("navigation", { name: "Step navigation" })).toBeNull();
  });

  it("ends Results with a closing card: replay the tour, the real-GPS survey and the code", async () => {
    window.location.hash = "#results";
    const onCacheDirChange = vi.fn();
    render(
      <Shell
        cache={cache}
        cacheDir="demo"
        onCacheDirChange={onCacheDirChange}
        surveyOptions={[
          { dir: "demo", label: "Mount Seymour simulation" },
          { dir: "real-gps", label: "Real EXIF positions" },
        ]}
      />,
    );
    const card = screen.getByRole("region", { name: "What next" });
    expect(within(card).getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.com/Drivera0/sightline");
    await userEvent.click(within(card).getByRole("button", { name: "Try the real-GPS survey" }));
    expect(onCacheDirChange).toHaveBeenCalledWith("real-gps");
  });

  it("replays the tour from the closing card", async () => {
    window.location.hash = "#results";
    render(<Shell cache={cache} />);
    await userEvent.click(screen.getByRole("button", { name: "Replay the tour" }));
    expect(screen.getByRole("dialog", { name: "Guided tour" })).toBeInTheDocument();
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

  it("plays a guided tour from the survey: captions per step, Next by hand, Esc to leave", async () => {
    render(<Shell cache={cache} />);
    await userEvent.click(screen.getByRole("button", { name: "Watch 60-second tour" }));
    const tour = () => screen.getByRole("dialog", { name: "Guided tour" });
    // jsdom can't tell the motion preference, so the tour runs captions-only with Next.
    expect(tour()).toHaveTextContent("Tour · 1 of 5");
    expect(tour()).toHaveTextContent("Reduced motion: press Next");
    await userEvent.click(within(tour()).getByRole("button", { name: "Next" }));
    expect(current()).toHaveTextContent("Rank");
    await userEvent.click(within(tour()).getByRole("button", { name: "Next" }));
    expect(current()).toHaveTextContent("Review");
    expect(tour()).toHaveTextContent("This demo answer is not saved");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Guided tour" })).toBeNull();
    // Leaving the tour leaves the viewer where they were.
    expect(current()).toHaveTextContent("Review");
  });

  it("stops the tour on any key and lets that key do its usual job", async () => {
    render(<Shell cache={cache} />);
    await userEvent.keyboard("t");
    expect(screen.getByRole("dialog", { name: "Guided tour" })).toBeInTheDocument();
    await userEvent.keyboard("5");
    expect(screen.queryByRole("dialog", { name: "Guided tour" })).toBeNull();
    expect(current()).toHaveTextContent("Results");
  });

  it("offers the tour in the shortcuts list", async () => {
    render(<Shell cache={cache} />);
    await userEvent.keyboard("?");
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    await userEvent.click(within(dialog).getByRole("button", { name: /Watch the 60-second tour/ }));
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Guided tour" })).toBeInTheDocument();
  });
});

describe("one name for M", () => {
  it("calls it Show on map in the shortcuts list", async () => {
    const { SHORTCUT_GROUPS } = await import("./shortcuts");
    const m = SHORTCUT_GROUPS.flatMap((g) => g.shortcuts).find((s) => s.keys.includes("M"));
    expect(m?.description).toBe("Show on map");
  });
});
