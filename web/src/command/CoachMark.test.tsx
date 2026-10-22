import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CoachMark, placeCard } from "./CoachMark";
import { missionSoFar } from "./Debrief";

describe("CoachMark", () => {
  it("puts the card beside its target where there is room, under it next, and along the bottom on a phone", () => {
    expect(placeCard({ top: 100, left: 1000, width: 400, height: 500 }, 1440, 900)).toEqual({ top: 100, left: 1000 - 320 - 12 });
    expect(placeCard({ top: 100, left: 20, width: 300, height: 500 }, 1440, 900)).toEqual({ top: 100, left: 332 });
    expect(placeCard({ top: 100, left: 20, width: 1400, height: 200 }, 1440, 900)).toEqual({ top: 312, left: 20 });
    expect(placeCard({ top: 100, left: 20, width: 300, height: 500 }, 390, 844)).toBeNull();
  });

  it("is one sentence with Next, Back and Exit; the arrows step, Space pauses the clock, Esc leaves", async () => {
    const on = { onNext: vi.fn(), onBack: vi.fn(), onExit: vi.fn(), onToggleClock: vi.fn() };
    render(<CoachMark text="Photos are landing." target="#nothing" index={2} count={5} {...on} />);
    const card = screen.getByRole("dialog", { name: "The story, 2 of 5" });
    expect(card).toHaveTextContent("Photos are landing.");
    await userEvent.keyboard("{ArrowRight}{ArrowLeft}");
    expect(on.onNext).toHaveBeenCalledOnce();
    expect(on.onBack).toHaveBeenCalledOnce();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard(" ");
    expect(on.onToggleClock).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(on.onExit).toHaveBeenCalledOnce();
  });

  it("waits for the action on a gate: Skip instead of Next, and the right arrow does nothing", async () => {
    const onNext = vi.fn();
    render(<CoachMark text="Approve it." target="#nothing" index={3} count={5} gate="Approve it on the card." onNext={onNext} onExit={vi.fn()} onToggleClock={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    await userEvent.keyboard("{ArrowRight}");
    expect(onNext).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onNext).toHaveBeenCalledOnce();
  });
});

describe("the Debrief's line", () => {
  it("says the mission so far, with each searched sector's POD", () => {
    const line = missionSoFar({
      mapUpdates: [{ source: "frame" }, { source: "frame" }, { source: "ground" }] as never,
      tasks: [{ sector_id: "B4", state: "searched", pod: 0.6 }, { sector_id: "A1", state: "in_progress", pod: null }] as never,
      clues: [{}] as never,
      proposals: [{ status: "approved" }, { status: "pending" }] as never,
    });
    expect(line).toBe("2 photos on the map · 1 proposal decided · 1 sector searched (B4 at POD 60 %) · 1 clue");
    expect(line).not.toMatch(/\bclear/i);
  });
});
