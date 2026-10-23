import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { clockAt } from "./missionTime";
import { Scrubber } from "./Scrubber";

describe("Scrubber", () => {
  it("shows the seven checkpoints, marks the current one, seeks on a tick and tells the clock in local time, UTC on hover", async () => {
    const onSeek = vi.fn();
    render(<Scrubber t={2} progress={1} playing={false} at={clockAt(2)} onSeek={onSeek} onToggle={() => undefined} />);
    const group = screen.getByRole("group", { name: "Mission time" });
    expect(group.querySelectorAll("li")).toHaveLength(7);
    expect([...group.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["The call", "Photos land", "Confirm", "Where next", "Run", "The find", "Debrief"]);
    expect(screen.getByRole("button", { name: /Confirm/ })).toHaveAttribute("aria-current", "step");
    expect(group).toHaveTextContent("14:31"); // 21:31 UTC at Mount Seymour
    expect(screen.getByTitle("Mission clock, 14:31 PDT (21:31 UTC)")).toHaveTextContent("14:31");
    expect(screen.getByRole("button", { name: /Where next/ })).toHaveAttribute("title", "Where next, 14:42 PDT (21:42 UTC)");
    await userEvent.click(screen.getByRole("button", { name: /Where next/ }));
    expect(onSeek).toHaveBeenCalledWith(3);
    // at a checkpoint there is nothing to play
    expect(screen.getByRole("button", { name: /Play the mission clock/ })).toBeDisabled();
  });

  it("it plays on to the end, says so, and shows the hint when idle", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Scrubber t={1} progress={1} playing={false} at={clockAt(1)} canPlay hint="Press Follow the search" onSeek={() => undefined} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("button", { name: /Play the mission clock to the end/ }));
    expect(onToggle).toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Mission clock status" })).toHaveTextContent("Press Follow the search");
    rerender(<Scrubber t={2} progress={0.3} playing at={clockAt(2, 0.3)} canPlay through={clockAt(0)} hint="Press Follow the search" onSeek={() => undefined} onToggle={onToggle} />);
    expect(screen.getByRole("status", { name: "Mission clock status" })).toHaveTextContent("Playing · 13:35 → 15:00");
  });

  it("Skip to now goes to the end of the timeline", async () => {
    const onSkip = vi.fn();
    render(<Scrubber t={3} progress={1} playing={false} at={clockAt(3)} onSkip={onSkip} onSeek={() => undefined} onToggle={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Skip to now" }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("pauses and resumes while the clock runs into a checkpoint", async () => {
    const onToggle = vi.fn();
    render(<Scrubber t={1} progress={0.4} playing at={clockAt(1, 0.4)} onSeek={() => undefined} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: /Confirm/ })).not.toHaveAttribute("aria-current");
    await userEvent.click(screen.getByRole("button", { name: /Pause the mission clock/ }));
    expect(onToggle).toHaveBeenCalled();
  });
});
