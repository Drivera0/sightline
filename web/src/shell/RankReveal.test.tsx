import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { RankReveal } from "./RankReveal";
import { scanStops, stopMs } from "./scan";

let cache: CacheBundle;
const original = window.matchMedia;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
  // Motion on, so the scanner runs.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = original;
});

describe("RankReveal scanner caption", () => {
  it("changes the caption only once the new photo has loaded", () => {
    const stops = scanStops(cache);
    const [first, second] = stops;
    render(<RankReveal cache={cache} dir="sample" onStart={() => {}} />);
    const caption = () => screen.getByText(/· photo \d+$/);

    fireEvent.load(screen.getByAltText(`Frame ${first!.frame.id}`), {});
    expect(caption()).toHaveTextContent(first!.frame.id);

    act(() => {
      vi.advanceTimersByTime(stopMs(first!));
    });
    // The next photo is on its way: the caption still names the one on screen.
    expect(screen.getByAltText(`Frame ${second!.frame.id}`)).toBeInTheDocument();
    expect(caption()).toHaveTextContent(first!.frame.id);

    fireEvent.load(screen.getByAltText(`Frame ${second!.frame.id}`), {});
    expect(caption()).toHaveTextContent(second!.frame.id);
  });

  it("offers Skip animation while scanning", () => {
    render(<RankReveal cache={cache} dir="sample" onStart={() => {}} />);
    expect(screen.getByRole("button", { name: "Skip animation" })).toBeInTheDocument();
  });
});
