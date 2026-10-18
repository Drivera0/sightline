import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { SPECK_DELAY_MS, speckTimeline, topCandidate } from "./speck";
import { SPECK_MEDIA, SpeckReveal, resetSpeckVisit } from "./SpeckReveal";
import { SurveyIntro } from "./SurveyIntro";

let cache: CacheBundle;
const original = window.matchMedia;

function setMedia({ reduced = false, wide = true }: { reduced?: boolean; wide?: boolean } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: query === SPECK_MEDIA ? wide : query.includes("reduce") ? reduced : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const status = () => screen.getByTestId("speck").getAttribute("data-status");
const card = () => document.querySelector("figure");

/** The hidden card's photo loads, then the delay runs out. */
function loadAndWait() {
  fireEvent.load(card()!.querySelector("img")!);
  act(() => {
    vi.advanceTimersByTime(SPECK_DELAY_MS);
  });
}

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
  resetSpeckVisit();
  setMedia();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = original;
});

describe("SpeckReveal", () => {
  it("waits for the photo and the delay, plays the top candidate once, then rests with Replay", () => {
    render(<SpeckReveal cache={cache} dir="sample" />);
    expect(status()).toBe("waiting");
    expect(card()).toHaveClass("invisible");
    // Not before the photo has loaded.
    act(() => {
      vi.advanceTimersByTime(SPECK_DELAY_MS * 2);
    });
    expect(status()).toBe("waiting");

    loadAndWait();
    expect(status()).toBe("playing");
    const fig = screen.getByRole("figure");
    expect(fig).toHaveAccessibleName("Top candidate in photo f0005: Person · detector score 0.87 · 48 px wide in a 1000 px photo");
    expect(fig.querySelector("img")).toHaveAttribute("src", expect.stringContaining("frames/f0005.jpg"));
    expect(screen.getByText("Person · detector score 0.87")).toBeInTheDocument();
    expect(screen.getByText("48 px wide in a 1000 px photo")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(speckTimeline(topCandidate(cache)!).endAt);
    });
    expect(status()).toBe("rest");
    expect(card()).toBeNull();
    expect(screen.getByRole("button", { name: "Replay the detection preview" })).toBeInTheDocument();
  });

  it("does not play again on a later visit to the page in the same session", () => {
    const { unmount } = render(<SpeckReveal cache={cache} dir="sample" />);
    loadAndWait();
    expect(status()).toBe("playing");
    unmount();
    render(<SpeckReveal cache={cache} dir="sample" />);
    expect(status()).toBe("rest");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(status()).toBe("rest");
  });

  it("replays from the keyboard, and Skip ends it", () => {
    render(<SpeckReveal cache={cache} dir="sample" />);
    loadAndWait();
    fireEvent.click(screen.getByRole("button", { name: "Skip the detection preview" }));
    expect(status()).toBe("rest");
    const replay = screen.getByRole("button", { name: "Replay the detection preview" });
    replay.focus();
    expect(replay).toHaveFocus();
    fireEvent.click(replay);
    expect(status()).toBe("playing");
    expect(screen.getByRole("figure")).toHaveClass("sl-speck-card");
    act(() => {
      vi.advanceTimersByTime(speckTimeline(topCandidate(cache)!).endAt);
    });
    expect(status()).toBe("rest");
  });

  it("shows the end state still under reduced motion: photo, box and label, no Replay", () => {
    setMedia({ reduced: true });
    render(<SpeckReveal cache={cache} dir="sample" />);
    expect(status()).toBe("still");
    const fig = screen.getByRole("figure");
    expect(fig).not.toHaveClass("sl-speck-card");
    expect(fig.querySelector(".sl-speck-scan")).toBeNull();
    expect(screen.getByText("Person · detector score 0.87")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /detection preview/ })).toBeNull();
  });

  it("goes quiet when the tour starts, and does not start later", () => {
    const { rerender } = render(<SpeckReveal cache={cache} dir="sample" />);
    loadAndWait();
    expect(status()).toBe("playing");
    rerender(<SpeckReveal cache={cache} dir="sample" quiet />);
    expect(status()).toBe("rest");
    expect(card()).toBeNull();
    expect(screen.queryByRole("button", { name: /detection preview/ })).toBeNull();

    resetSpeckVisit();
    const second = render(<SpeckReveal cache={cache} dir="sample" quiet />);
    expect(second.container.querySelector("[data-status]")).toHaveAttribute("data-status", "rest");
  });

  it("renders nothing on narrow screens or without a candidate", () => {
    setMedia({ wide: false });
    const narrow = render(<SpeckReveal cache={cache} dir="sample" />);
    expect(narrow.container).toBeEmptyDOMElement();
    narrow.unmount();

    setMedia();
    const c = structuredClone(cache);
    c.detections.candidate_threshold = 0.99;
    const none = render(<SpeckReveal cache={c} dir="sample" />);
    expect(none.container).toBeEmptyDOMElement();
  });

  it("leaves autofocus on the hero's Start button", () => {
    render(<SurveyIntro cache={cache} dir="sample" onRank={() => {}} onTour={() => {}} modelBackground={false} />);
    expect(screen.getByRole("button", { name: /Start: rank/ })).toHaveFocus();
    loadAndWait();
    expect(status()).toBe("playing");
    expect(screen.getByRole("button", { name: /Start: rank/ })).toHaveFocus();
  });
});
