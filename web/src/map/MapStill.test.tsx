import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapStill, STILL, wantsStillMap } from "./MapStill";

const media = (matching: string[]) =>
  vi.fn((q: string) => ({ matches: matching.includes(q), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);

describe("the still map", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // jsdom has no matchMedia of its own
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("is off where the browser cannot tell (no matchMedia)", () => {
    expect(wantsStillMap()).toBe(false);
  });

  it("is on under 1024 px, on four cores or fewer, and when less data is asked for", () => {
    vi.stubGlobal("navigator", { ...navigator, hardwareConcurrency: 16 });
    window.matchMedia = media(["(max-width: 1023.98px)"]);
    expect(wantsStillMap()).toBe(true);
    window.matchMedia = media([]);
    expect(wantsStillMap()).toBe(false);
    window.matchMedia = media(["(prefers-reduced-data: reduce)"]);
    expect(wantsStillMap()).toBe(true);
    vi.stubGlobal("navigator", { ...navigator, hardwareConcurrency: 4 });
    window.matchMedia = media([]);
    expect(wantsStillMap()).toBe(true);
  });

  it("names itself, says how to load the map, and loads it from a button", () => {
    const onLoad = vi.fn();
    const { rerender } = render(<MapStill demo onLoad={onLoad} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", STILL.demoPhone);
    expect(screen.getByRole("img").getAttribute("alt")).toMatch(/demo map/);
    const button = screen.getByRole("button", { name: "Tap to load the map" });
    fireEvent.click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<MapStill demo loading onLoad={onLoad} />);
    expect(screen.getByRole("button", { name: "Loading the map…" })).toHaveAttribute("aria-busy", "true");
  });

  it("shows a plain basemap on a live mission", () => {
    const { container } = render(<MapStill demo={false} onLoad={() => {}} />);
    expect(container.querySelector("img")).toHaveAttribute("src", STILL.basemap);
    expect(screen.getByRole("button", { name: "Tap to load the map" })).toBeInTheDocument();
  });
});
