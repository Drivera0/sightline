// The one visual system: Brand, Button, Panel, PageHeader, Page and AppBar.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppBar, lastMission, rememberMission } from "./AppBar";
import { Button, Page, PageHeader, Panel } from "./components";
import { Brand } from "./Logo";

afterEach(() => sessionStorage.clear());

describe("Brand", () => {
  it("is one link to the About sheet, at the title size", () => {
    render(<Brand />);
    const link = screen.getByRole("link", { name: "Sightline" });
    expect(link).toHaveAttribute("href", "#about");
    expect(link.className).toMatch(/text-title/);
  });
});

describe("Button", () => {
  it("has three variants and two sizes; primary is solid accent with no glow", () => {
    render(
      <>
        <Button variant="primary" size="lg">Go</Button>
        <Button>Second</Button>
        <Button variant="ghost">Third</Button>
      </>,
    );
    const go = screen.getByRole("button", { name: "Go" });
    expect(go.className).toMatch(/\bbg-accent\b/);
    expect(go.className).toMatch(/\bh-12\b/);
    expect(go.className).not.toMatch(/shadow/);
    expect(go).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Second" }).className).toMatch(/\bborder\b.*\bh-10\b/);
    expect(screen.getByRole("button", { name: "Third" }).className).not.toMatch(/(^| )border( |$)/);
  });

  it("is a link when it has an href, and clicks when it hasn't", async () => {
    const onClick = vi.fn();
    render(
      <>
        <Button href="#survey">Guided demo</Button>
        <Button onClick={onClick}>Press</Button>
      </>,
    );
    expect(screen.getByRole("link", { name: "Guided demo" })).toHaveAttribute("href", "#survey");
    await userEvent.click(screen.getByRole("button", { name: "Press" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("Panel, PageHeader, Page", () => {
  it("Panel is the one opaque surface (no glass)", () => {
    render(<Panel data-testid="p">x</Panel>);
    const p = screen.getByTestId("p");
    expect(p.className).toMatch(/bg-surface-solid/);
    expect(p.className).toMatch(/border-line/);
    expect(p.className).not.toMatch(/backdrop-blur/);
  });

  it("PageHeader: eyebrow, one h1 at the headline size, one sub-line", () => {
    render(<PageHeader eyebrow="For judges" title="Where to look" sub="Two minutes." />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Where to look" });
    expect(h1.className).toMatch(/text-headline/);
    expect(h1.className).toMatch(/font-medium/);
    expect(screen.getByText("For judges")).toBeInTheDocument();
    expect(screen.getByText("Two minutes.")).toBeInTheDocument();
  });

  it("Page is the main landmark at one width", () => {
    render(<Page>x</Page>);
    expect(screen.getByRole("main").className).toMatch(/max-w-6xl.* px-4 .*lg:px-8/);
  });
});

describe("AppBar", () => {
  const views = (current: "map" | "debrief" = "map", onSelect = vi.fn()) => ({ current, onSelect, counts: { map: 2 } });

  it("is one row: the wordmark, the mission with its mode and clock, the view switch and one button", () => {
    render(<AppBar mission={{ name: "Mount Seymour (demo)", mode: "demo", clock: "21:18 UTC" }} views={views()} action={{ label: "New search", href: "#new" }} />);
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("link", { name: "Sightline" })).toHaveAttribute("href", "#about");
    expect(within(bar).getByText("Mount Seymour (demo)")).toBeInTheDocument();
    expect(within(bar).getByText("Demo")).toBeInTheDocument();
    expect(within(bar).getByText("21:18 UTC")).toBeInTheDocument();
    expect(within(bar).getByRole("link", { name: "New search" })).toHaveAttribute("href", "#new");
    // no places, no stepper: the views are the only navigation
    expect(screen.queryByRole("navigation", { name: "Sightline" })).toBeNull();
  });

  it("gives phones four tabs: Map, Needs you (with its count), Timeline, More with the other views", async () => {
    const onTab = vi.fn();
    const onSelect = vi.fn();
    render(<AppBar mission={null} views={views("map", onSelect)} tabs={{ current: "map", onSelect: onTab, needs: 3 }} />);
    const [bar, bottom] = screen.getAllByRole("navigation", { name: "Mission views" });
    expect(within(bar!).queryByRole("button", { name: /Needs you/ })).toBeNull();
    expect(within(bottom!).getAllByRole("button").map((b) => b.textContent)).toEqual(["Map", "Needs you3", "Timeline", "More"]);
    expect(within(bottom!).getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(bottom!).getByRole("button", { name: "Needs you3" }));
    expect(onTab).toHaveBeenCalledWith("needs");
    await userEvent.click(within(bottom!).getByRole("button", { name: "More" }));
    await userEvent.click(within(bottom!).getByRole("menuitem", { name: "Debrief" }));
    expect(onSelect).toHaveBeenCalledWith("debrief");
  });

  it("switches views with aria-pressed, in the bar and in the bottom bar for phones", async () => {
    const onSelect = vi.fn();
    render(<AppBar mission={null} views={views("debrief", onSelect)} />);
    const navs = screen.getAllByRole("navigation", { name: "Mission views" });
    expect(navs).toHaveLength(2);
    expect(navs[1]!.className).toMatch(/fixed .*bottom-0.*lg:hidden/);
    for (const nav of navs) {
      expect(within(nav).getByRole("button", { name: "Debrief" })).toHaveAttribute("aria-pressed", "true");
      expect(within(nav).getByRole("button", { name: /Map/ })).toHaveAttribute("aria-pressed", "false");
    }
    expect(within(navs[0]!).getAllByRole("button").map((b) => b.textContent)).toEqual(["Map2", "Photos", "Trace", "Debrief"]);
    await userEvent.click(within(navs[0]!).getByRole("button", { name: "Photos" }));
    expect(onSelect).toHaveBeenCalledWith("photos");
  });

  it("has no view switch and no button but the theme toggle where there is nothing to switch or start", () => {
    render(<AppBar />);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Switch to the (light|dark) theme$/)]);
  });

  it("remembers the live mission that is open", () => {
    expect(lastMission()).toBeNull();
    rememberMission("deadbeef");
    expect(lastMission()).toBe("deadbeef");
  });
});
