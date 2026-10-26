import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Annotation, Badge, EmptyState, KeyHint, Panel, Stat } from "./components";
import { ShortcutOverlay } from "./ShortcutOverlay";
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
  it("has one group per region of the console, the guided simulation's keys last, and no checkpoints", () => {
    const all = SHORTCUT_GROUPS.flatMap((g) => g.shortcuts.map((s) => `${s.keys.join(" ")}: ${s.description}`));
    expect(SHORTCUT_GROUPS.map((g) => g.title)).toEqual(["Views", "Needs you", "Map", "Timeline and radio", "Guided simulation"]);
    const guided = SHORTCUT_GROUPS.find((g) => g.title === "Guided simulation")!;
    expect(guided.shortcuts.flatMap((s) => s.keys)).toEqual(["A", "1", "2", "3", "4", "M", "T", "Space", "Esc"]);
    expect(all).toContain("Esc: Close an overlay (Leave the simulation asks first)");
    // the review answers by the names on their buttons (the usability test: help said "Person P")
    expect(all).toEqual(expect.arrayContaining(["P: The subject", "S: Another person", "N: Not a person", "U: Unsure (under More)"]));
    expect(all).not.toContain("P: Person");
    expect(all.join("\n")).not.toMatch(/checkpoint|the story|guided demo|tour|→|←/i);
    expect(all.join("\n")).not.toMatch(/\bclear(s|ed|ing)?\b|\brul(e|ed) out\b/i);
  });

  it("the overlay shows every group and key", () => {
    render(<ShortcutOverlay onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    for (const g of SHORTCUT_GROUPS) expect(dialog).toHaveTextContent(g.title);
    expect(dialog).toHaveTextContent("Take the agent's option");
    expect(dialog).not.toHaveTextContent(/checkpoint/i);
  });
});
