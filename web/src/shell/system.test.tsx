// The one visual system: Brand, Button, Panel, PageHeader, Page and AppBar.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppBar, consoleHref, primaryAction, rememberMission } from "./AppBar";
import { Button, Page, PageHeader, Panel } from "./components";
import { Brand } from "./Logo";

afterEach(() => sessionStorage.clear());

describe("Brand", () => {
  it("is one link back to the overview, at the title size", () => {
    render(<Brand />);
    const link = screen.getByRole("link", { name: "Sightline" });
    expect(link).toHaveAttribute("href", "#");
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
  it("has the brand, the four places and New search when there is a server", () => {
    render(<AppBar current="judges" base="https://api.example.org" />);
    const nav = screen.getByRole("navigation", { name: "Sightline" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Overview", "Guided demo", "Console", "For judges"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#", "#survey", "#m/demo/command", "#judges"]);
    expect(within(nav).getByRole("link", { name: "For judges" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Sightline" })).toHaveAttribute("href", "#");
    expect(screen.getByRole("link", { name: "New search" })).toHaveAttribute("href", "#new");
  });

  it("offers the demo console instead of New search on a site with no server", () => {
    render(<AppBar current="overview" base={null} />);
    expect(screen.getByRole("link", { name: "Open demo console" })).toHaveAttribute("href", "#m/demo/command");
    expect(screen.queryByRole("link", { name: "New search" })).toBeNull();
    expect(primaryAction(null)).toEqual({ label: "Open demo console", href: "#m/demo/command" });
  });

  it("leads Console to the live mission that is open, else the last one, else the demo", () => {
    expect(consoleHref("https://api", "a1b2c3d4")).toBe("#m/a1b2c3d4/command");
    expect(consoleHref("https://api")).toBe("#m/demo/command");
    rememberMission("deadbeef");
    expect(consoleHref("https://api")).toBe("#m/deadbeef/command");
    expect(consoleHref(null)).toBe("#m/demo/command"); // no server: the demo, whatever was remembered
  });

  it("renders the centre slot, extras and a second row", () => {
    render(<AppBar current="demo" base={null} center={<span>tabs</span>} extra={<button type="button">Menu</button>} below={<nav aria-label="Demo steps" />} />);
    expect(screen.getByText("tabs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menu" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Demo steps" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});
