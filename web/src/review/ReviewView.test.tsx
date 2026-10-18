import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { useSelection } from "../lib/selection";
import { ReviewView } from "./ReviewView";
import { useReview } from "./store";

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
  localStorage.clear();
  useReview.setState({ surveyId: null, history: [], answers: {}, cleared: null, demoSaved: null });
  useSelection.getState().clear();
});

const queue = () => within(screen.getByRole("list", { name: "Candidates" })).getAllByRole("listitem");
const current = () => queue().find((li) => li.querySelector('[aria-current="true"]'))!;
const status = (li: HTMLElement) => within(li).getByTestId("status").textContent;
const show = () => render(<ReviewView cache={cache} dir="sample" onShowMap={() => {}} />);

describe("ReviewView list and progress", () => {
  it("lists the candidates most confident first, each with confidence and status", () => {
    show();

    const items = queue();
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("f0005");
    expect(items[0]).toHaveTextContent("#1 · 87%");
    expect(items[1]).toHaveTextContent("f0012");
    expect(items[2]).toHaveTextContent("f0008");
    expect(items.map(status)).toEqual(["Unreviewed", "Unreviewed", "Unreviewed"]);
  });

  it("shows progress as a sentence", () => {
    show();

    expect(screen.getByText("0 of 3 reviewed · 0 people confirmed")).toBeInTheDocument();
  });

  it("starts on the first candidate and shows its crop, frame, rank and confidence", () => {
    show();

    expect(current()).toHaveTextContent("f0005");
    const crop = screen.getByAltText("Crop of detection f0005-d01");
    expect(crop).toHaveAttribute("src", "/cache/sample/crops/f0005-d01.jpg");
    expect(screen.getByTestId("detail")).toHaveTextContent("Frame f0005");
    expect(screen.getByTestId("detail")).toHaveTextContent("Rank 1");
    expect(screen.getByTestId("detail")).toHaveTextContent("0.874");
  });

  it("shows the whole frame as a thumbnail with the box outlined", () => {
    show();

    expect(screen.getByAltText("Frame f0005")).toHaveAttribute("src", "/cache/sample/frames/f0005.jpg");
    const box = screen.getByTestId("frame-box");
    expect(box).toHaveAttribute("x", "512");
    expect(box).toHaveAttribute("y", "300");
    expect(box).toHaveAttribute("width", "48");
    expect(box).toHaveAttribute("height", "62");
  });

  it("says so when there is nothing to review", () => {
    cache.detections.candidate_threshold = 0.99;

    show();

    expect(screen.getByText(/no candidates/i)).toBeInTheDocument();
  });
});

describe("ReviewView answering", () => {
  it("P marks the current candidate as a person and counts it", async () => {
    show();

    await userEvent.keyboard("p");

    expect(status(queue()[0]!)).toBe("Person");
    expect(screen.getByText("1 of 3 reviewed · 1 person confirmed")).toBeInTheDocument();
    expect(useReview.getState().answers).toEqual({ "f0005-d01": "person" });
  });

  it("N and U record not a person and unsure", async () => {
    show();

    await userEvent.keyboard("n");
    await userEvent.keyboard("u");

    expect(queue().map(status)).toEqual(["Not a person", "Unsure", "Unreviewed"]);
  });

  it("the answer buttons do the same as the keys", async () => {
    show();

    await userEvent.click(screen.getByRole("button", { name: /not a person/i }));

    expect(status(queue()[0]!)).toBe("Not a person");
  });

  it("moves on to the next unreviewed candidate after an answer", async () => {
    show();

    await userEvent.keyboard("p");

    expect(current()).toHaveTextContent("f0012");
  });

  it("skips reviewed candidates when moving on, and wraps round to the start", async () => {
    show();
    await userEvent.keyboard("j"); // now on f0012
    await userEvent.keyboard("p"); // answers f0012, moves to f0008
    expect(current()).toHaveTextContent("f0008");

    await userEvent.keyboard("n"); // answers f0008, wraps to f0005 (still unreviewed)

    expect(current()).toHaveTextContent("f0005");
  });

  it("stays put and says so when every candidate is reviewed", async () => {
    show();

    await userEvent.keyboard("pnu");

    expect(screen.getByText(/all candidates reviewed/i)).toBeInTheDocument();
    expect(screen.getByText("3 of 3 reviewed · 1 person confirmed")).toBeInTheDocument();
  });

  it("Z undoes the last answer and goes back to that candidate", async () => {
    show();
    await userEvent.keyboard("p");

    await userEvent.keyboard("z");

    expect(status(queue()[0]!)).toBe("Unreviewed");
    expect(current()).toHaveTextContent("f0005");
    expect(screen.getByText("0 of 3 reviewed · 0 people confirmed")).toBeInTheDocument();
  });

  it("starts on the first candidate nobody has answered yet, using saved answers", () => {
    localStorage.setItem(
      "sightline.review.sample",
      JSON.stringify([{ detectionId: "f0005-d01", answer: "person", at: 1 }]),
    );

    show();

    expect(status(queue()[0]!)).toBe("Person");
    expect(current()).toHaveTextContent("f0012");
  });

  it("ignores keys typed into a text field", async () => {
    render(
      <>
        <input aria-label="note" />
        <ReviewView cache={cache} dir="sample" onShowMap={() => {}} />
      </>,
    );

    await userEvent.type(screen.getByLabelText("note"), "pnu");

    expect(useReview.getState().history).toEqual([]);
  });
});

describe("ReviewView moving and selecting", () => {
  it("J and the down arrow go to the next candidate, K and the up arrow to the previous", async () => {
    show();

    await userEvent.keyboard("j");
    expect(current()).toHaveTextContent("f0012");
    await userEvent.keyboard("{ArrowDown}");
    expect(current()).toHaveTextContent("f0008");
    await userEvent.keyboard("k");
    expect(current()).toHaveTextContent("f0012");
    await userEvent.keyboard("{ArrowUp}");
    expect(current()).toHaveTextContent("f0005");
  });

  it("does not move past either end of the list", async () => {
    show();

    await userEvent.keyboard("k");
    expect(current()).toHaveTextContent("f0005");
    await userEvent.keyboard("jjjj");
    expect(current()).toHaveTextContent("f0008");
  });

  it("moving selects the detection, so the map can follow", async () => {
    show();

    await userEvent.keyboard("j");

    expect(useSelection.getState()).toMatchObject({
      selectedDetectionId: "f0012-d01",
      selectedFrameId: "f0012",
    });
  });

  it("the map follows the queue: the first candidate is selected, and each answer selects the next", async () => {
    show();
    expect(useSelection.getState().selectedDetectionId).toBe("f0005-d01");

    await userEvent.keyboard("p");
    expect(current()).toHaveTextContent("f0012");
    expect(useSelection.getState().selectedDetectionId).toBe("f0012-d01");

    await userEvent.keyboard("n");
    expect(current()).not.toHaveTextContent("f0012");
    expect(useSelection.getState().selectedDetectionId).not.toBe("f0012-d01");
  });

  it("clicking a candidate makes it current and selected", async () => {
    show();

    await userEvent.click(within(queue()[2]!).getByRole("button"));

    expect(current()).toHaveTextContent("f0008");
    expect(useSelection.getState().selectedDetectionId).toBe("f0008-d01");
  });

  it("jumps to a detection selected elsewhere, such as a click on a map pin", () => {
    show();

    act(() => useSelection.getState().selectDetection("f0008-d01"));

    expect(current()).toHaveTextContent("f0008");
  });

  it("M selects the detection and asks the shell to show the map", async () => {
    const onShowMap = vi.fn();
    render(<ReviewView cache={cache} dir="sample" onShowMap={onShowMap} />);

    await userEvent.keyboard("m");

    expect(onShowMap).toHaveBeenCalledTimes(1);
    expect(useSelection.getState().selectedDetectionId).toBe("f0005-d01");
  });
});

describe("ReviewView full frame view", () => {
  it("Enter opens the full frame with the box outlined, and Escape closes it", async () => {
    show();

    await userEvent.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Full frame" });
    expect(within(dialog).getByAltText("Full frame f0005")).toHaveAttribute("src", "/cache/sample/frames/f0005.jpg");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keys do not answer while the full frame is open", async () => {
    show();
    await userEvent.keyboard("{Enter}");

    await userEvent.keyboard("p");

    expect(useReview.getState().history).toEqual([]);
  });
});

describe("ReviewView focus after an answer", () => {
  it.each([false, true])("moves focus off the answer button, so Enter opens the frame instead of answering again (compact %s)", async (compact) => {
    render(<ReviewView cache={cache} dir="sample" onShowMap={() => {}} compact={compact} />);

    await userEvent.click(screen.getByRole("button", { name: /^person/i }));

    expect(document.activeElement).toBe(screen.getByTestId("candidate-panel"));
    await userEvent.keyboard("{Enter}");
    expect(useReview.getState().history.map((h) => h.answer)).toEqual(["person"]);
    expect(screen.getByRole("dialog", { name: "Full frame" })).toBeInTheDocument();
  });

  it("Enter on a focused answer button does not record an answer", async () => {
    show();
    screen.getByRole("button", { name: /not a person/i }).focus();

    await userEvent.keyboard("{Enter}");

    expect(useReview.getState().history).toEqual([]);
  });
});

describe("ReviewView answer states", () => {
  it("marks the chosen answer as selected with its colour fill, border and a check", async () => {
    render(<ReviewView cache={cache} dir="sample" onShowMap={() => {}} compact />);
    await userEvent.keyboard("p");
    await userEvent.keyboard("k");

    const person = screen.getByRole("button", { name: /^person/i, pressed: true });
    expect(person).toHaveClass("bg-ok/16", "border-ok");
    expect(within(person).getByTestId("selected-check")).toBeInTheDocument();
    const others = screen.getAllByRole("button", { pressed: false }).filter((b) => b.hasAttribute("data-answer"));
    expect(others).toHaveLength(2);
    for (const b of others) expect(within(b).queryByTestId("selected-check")).toBeNull();
  });

  it("uses warn for Unsure and a 10% text fill for Not a person", async () => {
    render(<ReviewView cache={cache} dir="sample" onShowMap={() => {}} compact />);
    await userEvent.keyboard("u");
    await userEvent.keyboard("k");
    expect(screen.getByRole("button", { name: /unsure/i, pressed: true })).toHaveClass("bg-warn/16", "border-warn");
    await userEvent.keyboard("n");
    await userEvent.keyboard("k");
    expect(screen.getByRole("button", { name: /not a person/i, pressed: true })).toHaveClass("bg-text/10", "border-text-2");
  });

  it("says what was marked in a toast whose Undo button takes the answer back", async () => {
    render(<ReviewView cache={cache} dir="sample" onShowMap={() => {}} compact />);
    await userEvent.keyboard("n");

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent("Marked f0005 · Not a person");
    await userEvent.click(within(toast).getByRole("button", { name: /undo/i }));

    expect(useReview.getState().history).toEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(current()).toHaveTextContent("f0005");
  });
});

describe("ReviewView on phones", () => {
  it("puts the three answers in a bar fixed to the bottom of the screen", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(<ReviewView cache={cache} dir="sample" onShowMap={() => {}} compact />);
      const bar = screen.getByTestId("phone-answer-bar");
      expect(bar.parentElement).toBe(document.body);
      expect(bar).toHaveClass("fixed", "bottom-0");
      expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["PersonP", "Not a personN", "UnsureU"]);
      for (const b of within(bar).getAllByRole("button")) expect(b).toHaveClass("h-12", "whitespace-nowrap");
      await userEvent.click(within(bar).getByRole("button", { name: /not a person/i }));
      expect(status(queue()[0]!)).toBe("Not a person");
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("ReviewView compact layout", () => {
  it("drops the frame panel so the queue fits beside the map, keeping the full frame on Enter", async () => {
    render(<ReviewView cache={cache} dir="sample" onShowMap={() => {}} compact />);
    expect(screen.getByRole("list", { name: "Candidates" })).toBeInTheDocument();
    expect(screen.queryByTestId("frame-box")).toBeNull();
    // Instead, the frame sits beside the crop as context, with the candidate boxed where the detector put it.
    const context = screen.getByTestId("frame-context-box");
    expect(context).toHaveAttribute("x", "512");
    expect(screen.getByRole("region", { name: "Review keys" })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Full frame" })).toBeInTheDocument();
  });
});

describe("ReviewView reset", () => {
  it("offers Reset review once there are answers, clears them, and can undo it", async () => {
    show();
    expect(screen.queryByRole("button", { name: "Reset review" })).toBeNull();
    await userEvent.keyboard("p");
    await userEvent.keyboard("n");
    expect(screen.getByText("2 of 3 reviewed · 1 person confirmed")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reset review" }));
    expect(screen.getByText("0 of 3 reviewed · 0 people confirmed")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("sightline.review.sample") as string)).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("2 of 3 reviewed · 1 person confirmed")).toBeInTheDocument();
  });
});
