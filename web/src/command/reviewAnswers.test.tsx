// The review answers of contract 15.7: Not the subject and Object (with its type) beside Person, Not a
// person and Unsure, in the review frame and on the candidate cards, with keys; an Object answer makes the
// clue candidate the data expects, and Needs you shows it as a clue candidate to confirm.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clue, MissionEvent, TimelineEvent } from "../contract";
import type { DistractorFrame } from "../lib/fixtureExtras";
import { ReviewRail, type ReviewCard } from "../review/LiveReview";
import { useSecondLook } from "../review/SecondLook";
import fixture from "./__fixtures__/scenarios/missing-child.json";
import { useConsole } from "./consoleStore";
import { distractorCards, objectClue } from "./demoReview";
import { NeedsYou } from "./NeedsYou";
import { ReviewFrame } from "./ReviewFrame";

const distractors = fixture.distractors as unknown as DistractorFrame[];
const timeline = fixture.timeline as unknown as TimelineEvent[];
const events = fixture.events as unknown as MissionEvent[];
const clues = fixture.clues as unknown as Clue[];
const card = (id: string, over: Partial<ReviewCard> = {}): ReviewCard => ({ id, conf: 0.5, crop: `/c/${id}.jpg`, frame: id.slice(0, 5), words: null, ...over });

beforeEach(() => {
  useConsole.getState().reset();
  useSecondLook.getState().reset();
});

describe("review answers", () => {
  it("the frame offers all five, with keys; S answers Not the subject, O then 1 picks a backpack", () => {
    const onAnswer = vi.fn();
    render(<ReviewFrame cards={[card("f0501-d01", { object: "fire ring" }), card("f0502-d01"), card("f0503-d01")]} answers={{}} onAnswer={onAnswer} />);
    act(() => useConsole.getState().openReview(null));
    const group = screen.getByRole("group", { name: "Answer" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Person P", "Not a person N", "Not the subject S", "Object O", "Unsure U"]);
    fireEvent.keyDown(window, { key: "s" });
    expect(onAnswer).toHaveBeenLastCalledWith("f0501-d01", "not_subject");
    fireEvent.keyDown(window, { key: "o" });
    const picker = screen.getByRole("group", { name: "Object type" });
    expect(within(picker).getAllByRole("button").map((b) => b.textContent)).toEqual(["backpack1", "fire ring2", "shelter3", "other4", "Cancel"]);
    fireEvent.keyDown(window, { key: "1" });
    expect(onAnswer).toHaveBeenLastCalledWith("f0502-d01", "object", "backpack");
  });

  it("the candidate cards offer them too; Object opens the type picker, the second look's guess marked", async () => {
    const onAnswer = vi.fn();
    render(<ReviewRail cards={[card("f0501-d01", { object: "fire ring" })]} answers={{}} onAnswer={onAnswer} />);
    const c = screen.getByLabelText("Candidate f0501-d01");
    expect(within(c).getAllByRole("button").map((b) => b.textContent).slice(-5)).toEqual(["Person", "Not a person", "Not the subject", "Object", "Unsure"]);
    await userEvent.click(within(c).getByRole("button", { name: "Object" }));
    const picker = within(c).getByRole("group", { name: "Object type" });
    expect(within(picker).getByRole("button", { name: "fire ring" })).toHaveAttribute("title", "The second look's guess");
    await userEvent.click(within(picker).getByRole("button", { name: "fire ring" }));
    expect(onAnswer).toHaveBeenCalledWith("f0501-d01", "object", "fire ring");
    fireEvent.keyDown(window, { key: "s" });
    expect(onAnswer).toHaveBeenLastCalledWith("f0501-d01", "not_subject");
  });

  it("the scenario's distractors join the queue once their second look is on the timeline", () => {
    expect(distractorCards(distractors, [], events)).toEqual([]);
    const all = distractorCards(distractors, timeline, events);
    expect(all.map((c) => c.id)).toEqual(distractors.map((d) => d.detection_id));
    const ring = all.find((c) => c.id === "f0501-d01")!;
    expect(ring).toMatchObject({ object: "fire ring", size: [1000, 750], words: "Second look: probably not a person · looks like a fire ring" });
    expect(ring.photo).toMatch(/cache-extras\/distractors\/fire-ring\.jpg$/);
  });

  it("an Object answer makes the clue candidate the data expects", () => {
    const d = distractors.find((x) => x.review === "object")!;
    const expected = clues.find((c) => c.id === d.clue)!;
    const made = objectClue(d.detection_id, d.review_object as "fire ring", { lat: d.lat, lon: d.lon }, d.clue!, expected.at);
    const keys = ["id", "kind", "text", "radius_m", "reliability", "reported_by", "source", "detection_id", "confirmed", "lat", "lon"] as const;
    for (const k of keys) expect(made[k], k).toEqual(expected[k]);
  });

  it("Needs you shows it as a clue candidate to confirm", async () => {
    const onConfirm = vi.fn();
    const candidate = clues.find((c) => c.source === "review")!;
    render(
      <NeedsYou proposals={[]} teams={[]} drones={[]} events={[]} clues={[candidate]} now={new Date(candidate.at)} checkInMin={30} onDecide={vi.fn()} imageUrl={(r) => r} review={null} reviewCount={0} onCall={vi.fn()} onRecall={vi.fn()} onConfirmClue={onConfirm} />,
    );
    const item = screen.getByRole("article", { name: "Clue candidate to confirm" });
    expect(item).toHaveTextContent(`Clue candidate to confirm: ${candidate.text}`);
    await userEvent.click(within(item).getByRole("button", { name: "Confirm clue" }));
    expect(onConfirm).toHaveBeenCalledWith(candidate.id);
  });
});
