import { describe, expect, it } from "vitest";
import { placeCard } from "./CoachMark";
import { missionSoFar } from "./Debrief";

describe("where a mark goes", () => {
  it("puts the card beside its target where there is room, under it next, and along the bottom on a phone", () => {
    expect(placeCard({ top: 100, left: 1000, width: 400, height: 500 }, 1440, 900)).toEqual({ top: 100, left: 1000 - 320 - 12 });
    expect(placeCard({ top: 100, left: 20, width: 300, height: 500 }, 1440, 900)).toEqual({ top: 100, left: 332 });
    expect(placeCard({ top: 100, left: 20, width: 1400, height: 200 }, 1440, 900)).toEqual({ top: 312, left: 20 });
    expect(placeCard({ top: 100, left: 20, width: 300, height: 500 }, 390, 844)).toBeNull();
  });

  it("keeps the status line and the scrubber in view: t4's mark beside the task board slides down its side", () => {
    // the console at 1440 × 900: the task board on the left, the status line over the map, the scrubber on it
    const board = { top: 117, left: 12, width: 324, height: 415 };
    const status = { top: 122, left: 348, width: 680, height: 20 };
    const scrubber = { top: 620, left: 360, width: 656, height: 50 };
    expect(placeCard(board, 1440, 900, 150)).toEqual({ top: 117, left: 348 }); // what it did: over the status line
    const at = placeCard(board, 1440, 900, 150, [status, scrubber])!;
    expect(at).toEqual({ top: 532 - 150, left: 348 });
    for (const a of [status, scrubber]) expect(at.top + 150 <= a.top || at.top >= a.top + a.height).toBe(true);
    // nowhere free: the first spot, as before
    expect(placeCard(board, 1440, 900, 150, [{ top: 0, left: 0, width: 1440, height: 900 }])).toEqual({ top: 117, left: 348 });
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
