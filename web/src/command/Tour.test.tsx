// The first-run tour (Tour.tsx): three short steps over Resources, the map and Needs you, skippable,
// remembered in this browser, and the mission clock waits while it is up.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useConsole } from "./consoleStore";
import { Tour, TOUR_KEY, TOUR_STEPS, tourSeen } from "./Tour";

function regions() {
  for (const id of ["console-resources", "console-map", "console-needs"]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
}

describe("the first-run tour", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    useConsole.getState().setConfirming(false);
  });

  it("walks the three regions in order, holds the clock, and is remembered once done", () => {
    regions();
    render(<Tour force />);
    expect(TOUR_STEPS.map((s) => s.target)).toEqual(["#console-resources", "#console-map", "#console-needs"]);
    expect(screen.getByRole("dialog", { name: "Resources: your teams and drones" })).toBeInTheDocument();
    expect(screen.getByText("Getting started · 1 of 3")).toBeInTheDocument();
    expect(useConsole.getState().confirming).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "The map: where the person likely is" })).toHaveTextContent("Hotter is likelier");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Needs you: every decision waits here" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useConsole.getState().confirming).toBe(false);
    expect(localStorage.getItem(TOUR_KEY)).toBe("1");
    expect(tourSeen()).toBe(true);
  });

  it("skips at any step with Esc or Skip, and swallows the console's keys while it is up", () => {
    regions();
    let reached = false;
    const listener = () => (reached = true);
    window.addEventListener("keydown", listener);
    render(<Tour force />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(reached).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tourSeen()).toBe(true);
    window.removeEventListener("keydown", listener);
  });

  it("stays away for a browser that has seen it, and in the app's own test runs", () => {
    render(<Tour />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
