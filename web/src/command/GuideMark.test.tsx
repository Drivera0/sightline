import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GuideMark } from "./CoachMark";
import { GuideStrip } from "./Scrubber";

const options = [
  { key: "1", id: "planner", label: "The AI's flight lines", effect: "the likeliest sectors first", costMin: 0, agent: true },
  { key: "2", id: "serpentine", label: "Serpentine over the grid", effect: "every sector once", costMin: 12 },
];

function mark(over: Partial<Parameters<typeof GuideMark>[0]> = {}) {
  const props = {
    mode: "call" as const,
    heading: "Decision 1 of 6 · Survey",
    text: "Launch the survey: fly the AI's flight lines, or a lawnmower pattern over the whole grid.",
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
    expect(dialog).toHaveTextContent("AI's pick");
    expect(screen.getByRole("button", { name: /The AI's flight lines/ })).toHaveFocus();
    // no Back, no Next, no Skip on a decision
    expect(screen.queryByRole("button", { name: /^(Back|Next|Skip)/ })).toBeNull();
  });

  it("Esc never leaves the run; Leave asks first, Stay keeps it, Leave leaves", async () => {
    const a = mark();
    await userEvent.keyboard("{Escape}");
    expect(a.onExit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    const ask = screen.getByRole("alertdialog", { name: "Leave the simulation?" });
    expect(ask).toHaveTextContent("Your decisions so far will be lost");
    await userEvent.keyboard("{Escape}"); // closes the question, not the run
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(a.onExit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Stay" }));
    expect(a.onExit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(a.onExit).toHaveBeenCalledOnce();
  });

  it("never greys the screen around its ring", () => {
    mark();
    for (const el of document.querySelectorAll("[data-guide-ring]")) expect((el as HTMLElement).className).not.toMatch(/9999px/);
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

  it("one place to decide: a choice the console has a control for gets no button here, only its key", async () => {
    document.body.insertAdjacentHTML("beforeend", '<article id="card"><button type="button">Reject</button><button type="button" data-primary>Send Team One to C2</button></article>');
    const a = mark({
      heading: "Step 4 of 6 · Assign",
      text: "Assign a team: press Approve on the card in Needs you A.",
      target: "#card",
      options: [
        { key: "1", id: "approve", label: "Team One to C2", effect: "Team One sweeps C2", costMin: 0, agent: true, on: "Approve on the card in Needs you" },
        { key: "M", id: "map", label: "Another sector, on the map", effect: "", costMin: 0, on: "a sector on the map" },
      ],
    });
    const dialog = screen.getByRole("dialog", { name: /Your call: Step 4 of 6/ });
    expect(within(dialog).queryByRole("group", { name: "Options" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Team One to C2/ })).toBeNull();
    // focus goes to the real control's main button
    expect(screen.getByRole("button", { name: "Send Team One to C2" })).toHaveFocus();
    await userEvent.keyboard("a");
    expect(a.onPick).toHaveBeenLastCalledWith("approve");
    document.getElementById("card")?.remove();
  });

  it("between decisions: the time-lapse, the clock large, the row that landed, Pause, speed and Skip ahead", async () => {
    const onSpeed = vi.fn();
    const onSkip = vi.fn();
    const a = mark({ mode: "watch", options: [], text: "Drone one flies the survey.", progress: 0.4, clock: "14:05", caption: "14:05 · Drone 1: leg L001 (sector C2)", onSpeed, onSkip });
    const dialog = screen.getByRole("dialog", { name: /Watch this/ });
    expect(dialog).toHaveTextContent("14:05 · Drone 1: leg L001 (sector C2)");
    expect(within(dialog).getByLabelText("Mission clock 14:05")).toBeInTheDocument();
    await userEvent.keyboard(" ");
    expect(a.onPause).toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "4×" }));
    expect(onSpeed).toHaveBeenCalledWith(4);
    await userEvent.keyboard("{ArrowRight}");
    expect(onSkip).toHaveBeenCalled();
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
