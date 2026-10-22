// E-10: the feed shows the newest 50 events and filters by kind.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MissionEvent } from "../contract";
import { EventFeed, FEED_LIMIT, feedEvents } from "./EventFeed";

const ev = (i: number, type: MissionEvent["type"]): MissionEvent => ({
  id: `e${String(i).padStart(5, "0")}`, type, at: `2026-10-24T21:${String(i % 60).padStart(2, "0")}:00Z`, summary: `${type} ${i}`, ref: null, data: null,
});
const events = Array.from({ length: 70 }, (_, i) => ev(i + 1, i % 7 === 0 ? "clue.added" : "photo.processed"));

describe("event feed", () => {
  it("keeps the newest 50, newest first", () => {
    const shown = feedEvents(events, "All");
    expect(shown).toHaveLength(FEED_LIMIT);
    expect(shown[0]!.id).toBe("e00070");
  });

  it("filters by kind with chips", async () => {
    render(<EventFeed events={events} />);
    expect(screen.getByText(/The last 50 of 70 events/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clues & tasks" }));
    const feed = screen.getByLabelText("Mission feed");
    expect(within(feed).getAllByText(/^clue\.added \d+$/)).toHaveLength(10);
    expect(within(feed).queryByText(/^photo\.processed/)).toBeNull();
    expect(screen.getByRole("button", { name: "Clues & tasks" })).toHaveAttribute("aria-pressed", "true");
  });

  it("labels each event in words, keeping the raw type as its tooltip", () => {
    render(<EventFeed events={[ev(1, "clue.added"), ev(2, "fleet.updated")]} />);
    const feed = screen.getByLabelText("Mission feed");
    expect(within(feed).getByText("Clue")).toHaveAttribute("title", "clue.added");
    expect(within(feed).getByText("Drones")).toHaveAttribute("title", "fleet.updated");
  });
});
