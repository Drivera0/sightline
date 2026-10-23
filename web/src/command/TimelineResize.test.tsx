// The timeline's resize (V3 §3): taller by default, a handle to drag or key, clamped to the window, and
// remembered by this browser; the filter chosen is remembered too.
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { clampTimeline, savedTimeline, TIMELINE_DEFAULT_PX, TIMELINE_KEY, TIMELINE_MIN_PX, TIMELINE_STEP_PX, TimelineHandle, useTimelineHeight } from "./TimelineResize";
import { FILTER_KEY, useConsole } from "./consoleStore";

function Harness() {
  const [h, set] = useTimelineHeight();
  return (
    <div>
      <TimelineHandle height={h} onResize={set} />
      <output>{h}</output>
    </div>
  );
}

describe("the timeline's height", () => {
  it("is 20 rem by default, never below its minimum nor above 70 % of the window", () => {
    expect(TIMELINE_DEFAULT_PX).toBe(320);
    expect(savedTimeline(900)).toBe(320);
    expect(clampTimeline(40, 900)).toBe(TIMELINE_MIN_PX);
    expect(clampTimeline(5000, 900)).toBe(630);
  });

  it("grows with the up arrow on its handle, shrinks with the down arrow, and is remembered", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator", { name: "Resize the timeline" });
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle).toHaveAttribute("aria-valuenow", String(320 + TIMELINE_STEP_PX));
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle).toHaveAttribute("aria-valuenow", String(320 - TIMELINE_STEP_PX));
    expect(localStorage.getItem(TIMELINE_KEY)).toBe(String(320 - TIMELINE_STEP_PX));
    fireEvent.keyDown(handle, { key: "End" });
    expect(screen.getByText(String(TIMELINE_MIN_PX))).toBeInTheDocument();
  });

  it("follows a drag: up is taller", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
    expect(handle).toHaveAttribute("aria-valuenow", "420");
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 }); // released: no change
    expect(handle).toHaveAttribute("aria-valuenow", "420");
  });

  it("opens at the height this browser left it", () => {
    localStorage.setItem(TIMELINE_KEY, "480");
    function Read() {
      const [h] = useState(() => savedTimeline(900));
      return <output>{h}</output>;
    }
    render(<Read />);
    expect(screen.getByText("480")).toBeInTheDocument();
  });

  it("keeps the filter chosen", () => {
    useConsole.getState().setFilter("Radio");
    expect(localStorage.getItem(FILTER_KEY)).toBe("Radio");
    useConsole.getState().reset();
    expect(useConsole.getState().filter).toBe("Radio");
    useConsole.getState().setFilter("All");
  });
});
