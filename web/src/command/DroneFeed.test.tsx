import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetState } from "../contract";
import type { DroneFeedClip } from "../lib/fixtureExtras";
import fixture from "./__fixtures__/scenarios/overdue-hiker.json";
import { activeFeed, DroneFeed, FEED_LABEL } from "./DroneFeed";

const feeds = fixture.feeds as DroneFeedClip[];
const base = fixture.fleet as unknown as FleetState;
/** The fleet with only `legs` flying (each by its own drone). */
const flying = (...legs: string[]): FleetState => ({
  ...base,
  legs: base.legs.map((l) => ({ ...l, status: legs.includes(l.id) ? "flying" : "done" })),
  drones: base.drones.map((d) => {
    const leg = base.legs.find((l) => legs.includes(l.id) && l.drone_id === d.id);
    return { ...d, status: leg ? "flying" : "idle", leg_id: leg?.id ?? null };
  }),
});

function setMedia(match: (q: string) => boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: match(q), media: q, addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the drone feed tile", () => {
  it("shows the flying leg's clip, the selected drone's first", () => {
    const leg2 = base.legs.find((l) => l.id === "L002")!;
    const leg3 = base.legs.find((l) => l.id === "L003")!;
    expect(activeFeed(feeds, flying("L002", "L003"))?.feed.leg).toBe("L002");
    expect(activeFeed(feeds, flying("L002", "L003"), leg3.drone_id)?.feed.leg).toBe("L003");
    expect(activeFeed(feeds, flying("L002"))?.sector).toBe(leg2.sector_id);
    expect(activeFeed(feeds, flying())).toBeNull();
    expect(activeFeed([], flying("L002"))).toBeNull();
  });

  it("plays it muted and looping on a desktop, with its poster and the label", () => {
    setMedia(() => false);
    const { container } = render(<DroneFeed feeds={feeds} fleet={flying("L002")} />);
    const v = container.querySelector("video")!;
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.getAttribute("src")).toMatch(/feed\/forest-2\.mp4$/);
    expect(v.getAttribute("poster")).toMatch(/feed\/forest-2\.jpg$/);
    expect(screen.getByText(FEED_LABEL)).toBeInTheDocument();
    expect(FEED_LABEL).toBe("drone feed · public-domain footage, not this flight");
  });

  it("on a phone starts folded, then shows the poster until a gesture", () => {
    setMedia((q) => q.includes("pointer: coarse"));
    const { container } = render(<DroneFeed feeds={feeds} fleet={flying("L002")} />);
    expect(container.querySelector("video, img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the drone feed" }));
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/forest-2\.jpg$/);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("is hidden with prefers-reduced-data, and when no leg flies", () => {
    setMedia((q) => q.includes("reduced-data"));
    const { container, rerender } = render(<DroneFeed feeds={feeds} fleet={flying("L002")} />);
    expect(container).toBeEmptyDOMElement();
    setMedia(() => false);
    rerender(<DroneFeed feeds={feeds} fleet={flying()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
