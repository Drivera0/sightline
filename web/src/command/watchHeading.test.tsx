// The guide's heading in Watch instead is never cut short (the cold test, 2026-10-26: "Next: Revie…" at
// 1440×900 and 1280×720): it keeps its whole width and the buttons wrap after it as one group. jsdom has
// no layout, so this pins the rule the layout rests on; the screenshots at both sizes are the check of
// the layout itself. Built by lane A.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuideMark } from "./CoachMark";

describe("the guide's heading while you watch", () => {
  it("is never truncated, and Take over, Restart and Leave wrap together after it", () => {
    render(
      <GuideMark
        mode="watch"
        heading="Next: Review photos"
        text="The drones fly the survey; photos land and the detector ranks each one."
        target="#nowhere"
        options={[]}
        onPick={vi.fn()}
        watching
        onWatch={vi.fn()}
        onTakeOver={vi.fn()}
        onRestart={vi.fn()}
        paused={false}
        onPause={vi.fn()}
        onExit={vi.fn()}
      />,
    );
    const heading = screen.getByText("Next: Review photos");
    expect(heading).toHaveAttribute("data-guide-heading");
    // its whole text shown: no ellipsis, and it does not shrink below its own width
    expect(heading.className).not.toMatch(/\btruncate\b/);
    expect(heading.className).toMatch(/flex-\[1_0_auto\]/);
    // the buttons are one group of their own, so they move to the next line together
    const takeOver = screen.getByRole("button", { name: /Take over/ });
    const group = takeOver.parentElement!;
    expect(group).not.toBe(heading.parentElement);
    expect(group).toContainElement(screen.getByRole("button", { name: "Restart" }));
    expect(group).toContainElement(screen.getByRole("button", { name: "Leave" }));
  });
});
