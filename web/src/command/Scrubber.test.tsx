import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { clockAt } from "./missionTime";
import { Scrubber } from "./Scrubber";

describe("Scrubber", () => {
  it("shows the six checkpoints, marks the current one, seeks on a tick and tells the clock in UTC", async () => {
    const onSeek = vi.fn();
    render(<Scrubber t={2} progress={1} playing={false} at={clockAt(2)} onSeek={onSeek} onToggle={() => undefined} />);
    const group = screen.getByRole("group", { name: "Mission time" });
    expect(group.querySelectorAll("li")).toHaveLength(6);
    expect(screen.getByRole("button", { name: /Confirm/ })).toHaveAttribute("aria-current", "step");
    expect(group).toHaveTextContent("21:31");
    await userEvent.click(screen.getByRole("button", { name: /Where next/ }));
    expect(onSeek).toHaveBeenCalledWith(3);
    // at a checkpoint there is nothing to play
    expect(screen.getByRole("button", { name: /Play the mission clock/ })).toBeDisabled();
  });

  it("pauses and resumes while the clock runs into a checkpoint", async () => {
    const onToggle = vi.fn();
    render(<Scrubber t={1} progress={0.4} playing at={clockAt(1, 0.4)} onSeek={() => undefined} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: /Confirm/ })).not.toHaveAttribute("aria-current");
    await userEvent.click(screen.getByRole("button", { name: /Pause the mission clock/ }));
    expect(onToggle).toHaveBeenCalled();
  });
});
