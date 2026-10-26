// Every photo in the review queue reads apart from the others (the cold test, 2026-10-26: "Survey photo
// 273" twice, #3 at 0.17 and #13 at 0.41: two candidates in one photo), in plain words and never a
// detection's id; and an answered photo leaves the top of the waiting list. Built by lane A.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { photoName, ReviewRail, withSpots, type ReviewCard } from "../review/LiveReview";
import { demoCards, SECOND_LOOK_ID } from "./demoReview";

const frame = { id: "f0273", file: "frames/f0273.jpg", width_px: 1000, height_px: 750, flight_index: 1 };
const bundle = {
  survey: { frames: [frame, { ...frame, id: "f0336", file: "frames/f0336.jpg", flight_index: 0 }] },
  detections: {
    candidate_threshold: 0.29,
    frames: {
      // the detector's own candidate in photo 273, to the right of the second look's (box x 502)
      f0273: [{ id: "f0273-d01", conf: 0.41, crop: "crops/f0273-d01.jpg", box_px: [800, 300, 850, 360], lat: 49.37, lon: -122.94 }],
      f0336: [{ id: "f0336-d01", conf: 0.82, crop: "crops/f0336-d01.jpg", box_px: [10, 10, 60, 60], lat: 49.37, lon: -122.94 }],
    },
  },
} as unknown as CacheBundle;

describe("two candidates in one photo", () => {
  it("each says its spot, left to right, after the photo's number; a photo with one keeps its name", () => {
    const cards = demoCards(bundle, bundle.survey.frames, (r) => r, true);
    const names = Object.fromEntries(cards.map((c) => [c.id, photoName(c.frame)]));
    expect(names[SECOND_LOOK_ID]).toBe("Survey photo 273 · spot 1 of 2 · flagged by the AI re-check");
    expect(names["f0273-d01"]).toBe("Survey photo 273 · spot 2 of 2");
    expect(names["f0336-d01"]).toBe("Survey photo 336");
    // all apart, and no detection's id in what is read
    expect(new Set(Object.values(names)).size).toBe(cards.length);
    for (const n of Object.values(names)) expect(n).not.toMatch(/f\d{4}|-d\d{2}/);
  });

  it("a live mission's queue says it the same way", () => {
    const cards = withSpots([
      { id: "f0010-d02", frame: "DJI_0010.JPG", box: [40, 0, 50, 10] as [number, number, number, number] },
      { id: "f0010-d01", frame: "DJI_0010.JPG", box: [400, 0, 450, 10] as [number, number, number, number] },
    ]);
    expect(cards.map((c) => c.frame)).toEqual(["DJI_0010.JPG · spot 1 of 2", "DJI_0010.JPG · spot 2 of 2"]);
  });
});

describe("the waiting list", () => {
  const card = (id: string, conf: number): ReviewCard => ({ id, conf, crop: "", frame: `Survey photo ${id.slice(0, 5)}`, words: null });
  const cards = [card("f0336-d01", 0.82), card("f0127-d01", 0.8), card("f0193-d01", 0.79)];

  it("an answered photo goes below the ones still waiting", () => {
    render(<ReviewRail cards={cards} answers={{ "f0336-d01": "person" }} onAnswer={() => {}} />);
    const items = within(screen.getByRole("region", { name: "Review" })).getAllByRole("listitem").filter((li) => li.hasAttribute("data-candidate"));
    expect(items.map((li) => li.getAttribute("data-candidate"))).toEqual(["f0127-d01", "f0193-d01", "f0336-d01"]);
  });
});
