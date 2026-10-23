// The review frame (V3 §3): it opens on the first waiting candidate with the photo, the crop and the AI
// second look; P/N/U answer and it moves on by itself; at the end it says so; Esc closes it; the rail's
// own keys stand down while it is open; the map is told which candidate is in view.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSelection } from "../lib/selection";
import { reviewKeys, type LiveAnswer, type ReviewCard } from "../review/LiveReview";
import { RUN_MAX_MS, SECOND_LOOK_LABEL, useSecondLook } from "../review/SecondLook";
import { useConsole } from "./consoleStore";
import { frameCard, ReviewFrame } from "./ReviewFrame";

const card = (id: string, over: Partial<ReviewCard> = {}): ReviewCard => ({ id, conf: 0.8, crop: `/c/${id}.jpg`, frame: `Survey photo ${id.slice(0, 5)}`, words: null, ...over });
const cards = [
  card("f0336-d01", { photo: "/f/f0336.jpg", size: [1000, 750], box: [100, 150, 200, 300] }),
  card("f0273-d02", { words: "Second look: likely a person · standing · 2 people", chips: ["OpenCV 5 zoom native", "Nemotron-3.5-Super-VL"], relook: [{ url: "/r/z.jpg", name: "relook/f0273-d02-zoom_native.jpg" }], ms: 1733 }),
  card("f0127-d01"),
];

function Harness({ onAnswer }: { onAnswer: (id: string, a: LiveAnswer) => void }) {
  const [answers, setAnswers] = useState<Record<string, LiveAnswer>>({});
  return (
    <ReviewFrame
      cards={cards}
      answers={answers}
      onAnswer={(id, a) => {
        setAnswers((x) => ({ ...x, [id]: a }));
        onAnswer(id, a);
      }}
    />
  );
}

describe("the review frame", () => {
  beforeEach(() => {
    useConsole.getState().reset();
    useSecondLook.getState().reset();
  });

  it("picks the candidate asked for while it waits, else the first waiting", () => {
    expect(frameCard(cards, {}, null)?.id).toBe("f0336-d01");
    expect(frameCard(cards, {}, "f0127-d01")?.id).toBe("f0127-d01");
    expect(frameCard(cards, { "f0336-d01": "person" }, "f0336-d01")?.id).toBe("f0273-d02");
    expect(frameCard(cards, { "f0336-d01": "person", "f0273-d02": "unsure", "f0127-d01": "not_person" }, null)).toBeNull();
  });

  it("opens on the first, answers with P/N/U and moves on by itself, then says it is done", async () => {
    const onAnswer = vi.fn();
    render(<Harness onAnswer={onAnswer} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useConsole.getState().openReview(null));
    const frame = screen.getByRole("dialog", { name: "Review candidates" });
    expect(frame).toHaveTextContent("1 of 3");
    expect(within(frame).getByAltText("Survey photo f0336, the whole photo")).toHaveAttribute("src", "/f/f0336.jpg");
    expect(useSelection.getState().selectedDetectionId).toBe("f0336-d01"); // the map pans to it
    expect(reviewKeys.frameOpen).toBe(true);
    await userEvent.keyboard("p");
    expect(onAnswer).toHaveBeenLastCalledWith("f0336-d01", "person");
    expect(frame).toHaveTextContent("2 of 3");
    expect(within(frame).getByText("f0273-d02")).toBeInTheDocument();
    await userEvent.keyboard("u");
    await userEvent.click(within(frame).getByRole("button", { name: /Not a person/ }));
    expect(onAnswer).toHaveBeenLastCalledWith("f0127-d01", "not_person");
    expect(frame).toHaveTextContent("Every candidate has an answer.");
  });

  it("runs the AI second look from its button, its progress then the result, and Esc closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness onAnswer={vi.fn()} />);
    act(() => useConsole.getState().openReview("f0273-d02"));
    const frame = screen.getByRole("dialog");
    expect(within(frame).getByText("Nemotron-3.5-Super-VL")).toBeInTheDocument();
    await userEvent.click(within(frame).getByRole("button", { name: SECOND_LOOK_LABEL }));
    expect(within(frame).getByLabelText("Second look running")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(RUN_MAX_MS));
    expect(within(frame).getByLabelText("Second look result")).toHaveTextContent("AI second look done in 1.7 s");
    expect(within(frame).getByAltText("Re-look image relook/f0273-d02-zoom_native.jpg")).toBeInTheDocument();
    vi.useRealTimers();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reviewKeys.frameOpen).toBe(false);
  });

  it("a candidate with no second look has the button off, and says why", () => {
    render(<Harness onAnswer={vi.fn()} />);
    act(() => useConsole.getState().openReview("f0127-d01"));
    expect(screen.getByRole("button", { name: SECOND_LOOK_LABEL })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent("No second look on this one");
  });
});
