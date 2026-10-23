// A distractor frame (a ground-level photo of an object among the aerial ones) carries an "object photo"
// badge in the review frame and on its card, so the odd photo is explained; the badge never says "simulated".
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { MissionEvent, TimelineEvent } from "../contract";
import type { DistractorFrame } from "../lib/fixtureExtras";
import { OBJECT_PHOTO_TITLE, ReviewRail } from "../review/LiveReview";
import { useSecondLook } from "../review/SecondLook";
import fixture from "./__fixtures__/scenarios/dementia.json";
import { useConsole } from "./consoleStore";
import { distractorCards } from "./demoReview";
import { ReviewFrame } from "./ReviewFrame";

const cards = distractorCards(fixture.distractors as unknown as DistractorFrame[], fixture.timeline as unknown as TimelineEvent[], fixture.events as unknown as MissionEvent[]);
const plain = { id: "f0042-d01", conf: 0.6, crop: "/c.jpg", frame: "Survey photo f0042", words: null, photo: "/f.jpg", size: [1000, 750] as [number, number], box: [1, 2, 3, 4] as [number, number, number, number] };

beforeEach(() => {
  useConsole.getState().reset();
  useSecondLook.getState().reset();
});

describe("the object photo badge", () => {
  it("every distractor card is flagged, from the data", () => {
    expect(cards.length).toBe(fixture.distractors.length);
    expect(cards.every((c) => c.distractor)).toBe(true);
  });

  it("shows on a distractor's photo in the review frame, and not on a survey photo", () => {
    render(<ReviewFrame cards={[cards[0]!, plain]} answers={{}} onAnswer={() => {}} />);
    act(() => useConsole.getState().openReview(cards[0]!.id));
    const frame = screen.getByRole("dialog", { name: "Review candidates" });
    expect(within(frame).getByText("object photo")).toHaveAttribute("title", OBJECT_PHOTO_TITLE);
    act(() => useConsole.getState().openReview(plain.id));
    expect(within(frame).queryByText("object photo")).toBeNull();
  });

  it("shows on the candidate card too, and never says simulated", () => {
    render(<ReviewRail cards={[cards[0]!, plain]} answers={{}} onAnswer={() => {}} />);
    expect(within(screen.getByLabelText(`Candidate ${cards[0]!.id}`)).getByText("object photo")).toBeInTheDocument();
    expect(within(screen.getByLabelText(`Candidate ${plain.id}`)).queryByText("object photo")).toBeNull();
    expect(`object photo ${OBJECT_PHOTO_TITLE}`).not.toMatch(/simulat/i);
  });
});
