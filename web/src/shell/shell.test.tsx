import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Annotation, Badge, EmptyState, KeyHint, Panel, Stat } from "./components";
import { SHORTCUT_GROUPS } from "./shortcuts";

describe("shared components", () => {
  it("Stat shows a big number, its label and its source", () => {
    render(<Stat value="33 s" label="Human, per photo" source="Pyrrö et al. 2021" />);

    expect(screen.getByText("33 s")).toBeInTheDocument();
    expect(screen.getByText("Human, per photo")).toBeInTheDocument();
    expect(screen.getByText("Pyrrö et al. 2021")).toBeInTheDocument();
  });

  it("Badge renders its label with a status kind", () => {
    render(<Badge kind="simulated">Simulated evaluation</Badge>);

    expect(screen.getByText("Simulated evaluation")).toHaveAttribute("data-kind", "simulated");
  });

  it("KeyHint renders a kbd element", () => {
    render(<KeyHint>P</KeyHint>);

    expect(screen.getByText("P").tagName).toBe("KBD");
  });

  it("KeyHint hides on touch screens: no hover, or a coarse pointer", () => {
    render(<KeyHint>P</KeyHint>);

    expect(screen.getByText("P")).toHaveClass("[@media(hover:none)]:hidden", "[@media(pointer:coarse)]:hidden");
  });

  it("EmptyState shows a title and a message", () => {
    render(<EmptyState title="Nothing yet">Coming in hour 18</EmptyState>);

    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    expect(screen.getByText("Coming in hour 18")).toBeInTheDocument();
  });

  it("Panel renders its children", () => {
    render(<Panel>inside</Panel>);

    expect(screen.getByText("inside")).toBeInTheDocument();
  });
});

describe("Annotation", () => {
  it("uses the handwriting font, for one-off notes only", () => {
    render(<Annotation>this is where the team goes next</Annotation>);

    expect(screen.getByText("this is where the team goes next")).toHaveClass("font-hand");
  });
});

describe("the shortcuts list", () => {
  it("lists the story's keys, the views, the console's and the review's, and no guided-demo steps", () => {
    const all = SHORTCUT_GROUPS.flatMap((g) => g.shortcuts.map((s) => `${s.keys.join(" ")}: ${s.description}`));
    expect(SHORTCUT_GROUPS.map((g) => g.title)).toEqual(["The story", "Views", "Console", "Review", "Everywhere"]);
    expect(all).toContain("Space: Pause or play the mission clock");
    expect(all).toContain("Esc: Leave the story (the console stays at that mission time), or close");
    expect(all.join("\n")).not.toMatch(/guided demo|tour/i);
  });
});
