import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GuideMark } from "./CoachMark";
import { GuideStrip } from "./Scrubber";

const options = [
  { key: "1", id: "planner", label: "The planner's legs", effect: "the likeliest sectors first", costMin: 0, agent: true },
  { key: "2", id: "serpentine", label: "Serpentine over the grid", effect: "every sector once", costMin: 12 },
];

function mark(over: Partial<Parameters<typeof GuideMark>[0]> = {}) {
  const props = {
    mode: "call" as const,
    heading: "Decision 1 of 6 · Survey",
    text: "Launch the survey: approve the planner's legs A, or fly a serpentine over the whole grid 2.",
    target: "#nowhere",
    options,
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

describe("the guided search's mark", () => {
  it("asks for the decision with its options, what each costs, and the agent's marked; focus on the first", () => {
    mark();
    const dialog = screen.getByRole("dialog", { name: /Your call/ });
    expect(dialog).toHaveTextContent("+12 min");
    expect(dialog).toHaveTextContent("agent");
    expect(screen.getByRole("button", { name: /The planner's legs/ })).toHaveFocus();
    // no Back, no Next, no Skip on a decision
    expect(screen.queryByRole("button", { name: /^(Back|Next|Skip)/ })).toBeNull();
  });

  it("takes the decision from the keyboard: A the agent's option, a number the option with that key", async () => {
    const a = mark();
    await userEvent.keyboard("a");
    expect(a.onPick).toHaveBeenLastCalledWith("planner");
    await userEvent.keyboard("2");
    expect(a.onPick).toHaveBeenLastCalledWith("serpentine");
  });

  it("watching: the options wait for the agent's line, T takes over", async () => {
    const a = mark({ watching: true });
    await userEvent.keyboard("2");
    expect(a.onPick).not.toHaveBeenCalled();
    await userEvent.keyboard("t");
    expect(a.onTakeOver).toHaveBeenCalled();
  });

  it("between decisions: watch this, a progress bar, Space pauses", async () => {
    const a = mark({ mode: "watch", options: [], text: "Drone one flies the survey.", progress: 0.4 });
    expect(screen.getByRole("dialog", { name: /Watch this/ })).toHaveTextContent("Drone one flies the survey.");
    await userEvent.keyboard(" ");
    expect(a.onPause).toHaveBeenCalled();
  });

  it("the strip checks each decision made and reads out the current step", () => {
    render(
      <GuideStrip
        pips={[
          { id: "survey", label: "Survey", state: "done" },
          { id: "triage", label: "Triage", state: "current" },
          { id: "find", label: "Find", state: "next" },
        ]}
        at="2026-10-24T21:31:00Z"
        call
        paused={false}
        announce="Your call, Triage: Answer each candidate."
      />,
    );
    expect(screen.getByText("Survey").closest("li")).toHaveTextContent("✓");
    expect(screen.getByText("Triage").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Mission clock paused")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your call, Triage");
  });
});
