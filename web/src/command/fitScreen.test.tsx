// The console fits the screen (round 2 of the cold usability test: "I can't see the button"): the guided
// search's other choices after the step's item on a short screen, the bar folded to a chip over the phone's
// review frame, the ring never over an overlay, the Leave confirm above everything with the clock waiting,
// and no review frame opening over a confirm. The real layout at 1280 × 720 to 1920 × 1080 and 390 × 844
// is checked in Chromium (elementFromPoint on every step's control). Built by lane A.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { covered, GuideMark, primaryIn } from "./CoachMark";
import { useConsole } from "./consoleStore";

/** matchMedia as a browser of this size answers it (jsdom has none). */
function screenOf(w: number, h: number) {
  const answer = (q: string) =>
    q
      .split(/\s+and\s+/)
      .map((part) => part.match(/\((min|max)-(width|height):\s*([\d.]+)px\)/))
      .every((m) => {
        if (!m) return true;
        const v = m[2] === "width" ? w : h;
        return m[1] === "min" ? v >= Number(m[3]) : v <= Number(m[3]);
      });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: answer(q), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}

const onCard = [
  { key: "1", id: "confirm", label: "Confirm the clue", effect: "the map shifts toward it", costMin: 0, agent: true, on: "the card's Confirm clue" },
  { key: "2", id: "bearing", label: "Ask for a bearing", effect: "the map shifts toward it at medium reliability", costMin: 2 },
  { key: "3", id: "log", label: "Log without mapping", effect: "it goes in the log; the map stays as it is", costMin: 0 },
];

function mark(over: Partial<Parameters<typeof GuideMark>[0]> = {}) {
  const props = {
    mode: "call" as const,
    heading: "Step 3 of 6 · Clue",
    text: "Read back Team One's call: press Confirm clue on its card in Needs you, ask for a bearing, or log it without mapping.",
    target: "#nowhere",
    options: onCard,
    onPick: vi.fn(),
    watching: false,
    onWatch: vi.fn(),
    onTakeOver: vi.fn(),
    paused: false,
    onPause: vi.fn(),
    onExit: vi.fn(),
    ...over,
  };
  render(<GuideMark {...props} />);
  return props;
}

beforeEach(() => useConsole.getState().reset());
afterEach(() => vi.unstubAllGlobals());

describe("the guided search on a short screen (1280 × 720)", () => {
  it("keeps the step and its instruction in the bar, and puts the other choices after Needs you, one link away", () => {
    screenOf(1280, 720);
    mark();
    const bar = screen.getByRole("dialog", { name: /Your call/ });
    expect(bar).toHaveTextContent("Read back Team One's call");
    // the choices the console has no control for are not in the bar…
    expect(within(bar).queryByRole("button", { name: /Ask for a bearing/ })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Or, instead: 2 other choices, under Needs you" })).toBeInTheDocument();
    // …but in their own box, ordered after Needs you, each with what it does on hover
    const more = screen.getByRole("group", { name: "Other choices" });
    expect(more.closest("[data-guide-more]")?.className).toMatch(/lg:order-2/);
    expect(within(more).getByRole("button", { name: /Ask for a bearing/ })).toHaveAttribute("title", "the map shifts toward it at medium reliability");
  });

  it("a tall screen keeps every choice in the bar", () => {
    screenOf(1920, 1080);
    mark();
    const bar = screen.getByRole("dialog", { name: /Your call/ });
    expect(within(bar).getByRole("button", { name: /Ask for a bearing/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Other choices" })).toBeNull();
  });

  it("the choices that are the decision itself (the survey) stay in the bar on a short screen too", () => {
    screenOf(1280, 720);
    mark({ options: onCard.map((o) => ({ ...o, on: undefined })) });
    expect(within(screen.getByRole("dialog", { name: /Your call/ })).getByRole("button", { name: /Ask for a bearing/ })).toBeInTheDocument();
  });
});

describe("the guided search on a phone (390 × 844)", () => {
  it("folds to a one-line chip while the review frame is open, so the answers are in reach; a tap opens it", async () => {
    screenOf(390, 844);
    mark({ heading: "Step 2 of 6 · Review photos, photo 1 of 3", options: [] });
    expect(screen.getByRole("dialog", { name: /Your call/ })).toBeVisible();
    act(() => useConsole.getState().openReview("f0336-d01"));
    const chip = screen.getByRole("button", { name: /Show the guide/ });
    // the step cut short on one line keeps its whole text on hover
    expect(within(chip).getByTitle("Step 2 of 6 · Review photos, photo 1 of 3")).toBeInTheDocument();
    expect(document.querySelector("[data-guide-mark]")).not.toBeVisible();
    await userEvent.click(chip);
    expect(screen.getByRole("dialog", { name: /Your call/ })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("button", { name: /Show the guide/ })).toBeInTheDocument();
    // the review frame closed: the bar is back
    act(() => useConsole.getState().closeReview());
    expect(screen.queryByRole("button", { name: /Show the guide/ })).toBeNull();
    expect(screen.getByRole("dialog", { name: /Your call/ })).toBeVisible();
  });
});

describe("Leave the simulation?", () => {
  it("sits above every sheet, holds the console's confirm flag while open (the clock waits) and clears it on Stay", async () => {
    mark();
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    const ask = screen.getByRole("alertdialog", { name: "Leave the simulation?" });
    expect(ask).toHaveAttribute("aria-modal", "true");
    // above the review frame (z-40), the shortcuts list (z-[70]) and the end screen (z-50)
    expect(ask.parentElement!.className).toMatch(/fixed inset-0 z-\[80\]/);
    expect(useConsole.getState().confirming).toBe(true);
    await userEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(useConsole.getState().confirming).toBe(false);
  });

  it("no guided key acts while it is open", async () => {
    const a = mark({ options: onCard.map((o) => ({ ...o, on: undefined })) });
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    await userEvent.keyboard("a2");
    expect(a.onPick).not.toHaveBeenCalled();
  });
});

describe("no review frame over a confirm", () => {
  it("a review asked for while a confirm is open waits, and opens when it closes", () => {
    const c = useConsole.getState();
    c.setConfirming(true);
    c.openReview("f0273-d02");
    expect(useConsole.getState().review.open).toBe(false);
    useConsole.getState().setConfirming(false);
    expect(useConsole.getState().review).toEqual({ open: true, id: "f0273-d02" });
  });

  it("one closed meanwhile is not opened later", () => {
    const c = useConsole.getState();
    c.setConfirming(true);
    c.openReview(null);
    c.closeReview();
    c.setConfirming(false);
    expect(useConsole.getState().review.open).toBe(false);
  });
});

describe("the ring", () => {
  function box(el: HTMLElement, r: { top: number; left: number; width: number; height: number }) {
    el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r }) as DOMRect;
  }
  it("is not drawn where an overlay (the Conditions panel, the Trace page) covers any part of its target", () => {
    document.body.innerHTML = `<div id="t"><button data-primary>Confirm clue</button></div><div id="panel"></div>`;
    const t = document.getElementById("t")!;
    box(t, { top: 100, left: 100, width: 200, height: 80 });
    const panel = document.getElementById("panel")!;
    const mine = vi.fn(() => t as Element);
    document.elementFromPoint = mine;
    expect(covered([t])).toBe(false);
    // the panel over its top half
    document.elementFromPoint = vi.fn((_x: number, y: number) => (y < 140 ? panel : t));
    expect(covered([t])).toBe(true);
  });

  it("points at the item's main button (data-primary), else its own answer button", () => {
    document.body.innerHTML = `<div id="a"><button>Reply</button><button data-primary>Record find in C2</button></div><div id="b"><button>More…</button><button>The subject</button></div>`;
    expect(primaryIn(document.getElementById("a"))?.textContent).toBe("Record find in C2");
    expect(primaryIn(document.getElementById("b"))?.textContent).toBe("The subject");
  });
});
