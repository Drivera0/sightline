// LANE_E §9 test 6 (front door) and test 1 (no "clear" except the allowlisted negation).
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { routeFromHash } from "../shell/flow";
import { CLEAR_ALLOWLIST, FOOTER, HERO, HOW_IT_WORKS, PRINCIPLES, ROADMAP, WHO_ITS_FOR } from "./copy";
import { CONSOLE_SHOT, FrontDoor, heroStart } from "./FrontDoor";

describe("FrontDoor", () => {
  it("is the default route", () => {
    expect(routeFromHash("")).toEqual({ kind: "front" });
    expect(routeFromHash("#")).toEqual({ kind: "front" });
    expect(routeFromHash("#survey")).toEqual({ kind: "demo" });
  });

  it("renders all the copy, says how photos get in and when it runs, and its buttons go where they say", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<FrontDoor base="https://api.example.org" />);
    const text = document.body.textContent ?? "";
    for (const s of [HERO.tagline, HERO.body, HERO.honesty, ...HOW_IT_WORKS.flatMap((x) => [x.title, x.body]), ...WHO_ITS_FOR.flatMap((x) => [x.title, x.body]), ...PRINCIPLES.flatMap((x) => [x.title, x.body]), ...ROADMAP, FOOTER.data]) {
      expect(text).toContain(s);
    }
    expect(text).toMatch(/straight from the SD card/); // how photos get in, after landing
    expect(text).toMatch(/during the flight/); // or live
    const hero = screen.getByRole("region", { name: "Sightline" });
    expect(within(hero).getByRole("link", { name: HERO.start })).toHaveAttribute("href", "#new");
    expect(within(hero).getByRole("link", { name: HERO.demo })).toHaveAttribute("href", "#survey");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(HERO.tagline);
    expect(fetchSpy).not.toHaveBeenCalled(); // works offline
    expect(screen.getAllByRole("img")).toHaveLength(4); // the four line drawings, inline
  });

  it("opens the console first on the public site, which has no mission server", () => {
    expect(heroStart(null)).toEqual({ label: HERO.startNoServer, href: "#m/demo/command" });
    render(<FrontDoor base={null} />);
    const hero = screen.getByRole("region", { name: "Sightline" });
    expect(within(hero).getByRole("link", { name: "Open the console" })).toHaveAttribute("href", "#m/demo/command");
    expect(within(hero).queryByRole("link", { name: HERO.start })).toBeNull();
  });

  it("has the app bar, with For judges in it, not only in the footer", () => {
    render(<FrontDoor base={null} />);
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("link", { name: "Sightline" })).toHaveAttribute("href", "#");
    expect(within(bar).getByRole("link", { name: "For judges" })).toHaveAttribute("href", "#judges");
    expect(within(bar).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  it("opens on the product: the console above the fold, linked to the demo mission, served locally", () => {
    render(<FrontDoor base={null} />);
    const shot = screen.getByRole("link", { name: "Open the console on the demo mission" });
    expect(shot).toHaveAttribute("href", "#m/demo/command");
    expect(shot.querySelector("img")).toHaveAttribute("src", CONSOLE_SHOT);
    expect(CONSOLE_SHOT.startsWith("/")).toBe(true); // no remote asset
    // the pitch and both buttons come before the four steps
    const hero = screen.getByRole("region", { name: "Sightline" });
    expect(hero).toContainElement(screen.getByRole("link", { name: HERO.startNoServer }));
    expect(hero.compareDocumentPosition(screen.getByRole("region", { name: "How it works" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says "clear" only in the allowlisted negation', () => {
    render(<FrontDoor base={null} />);
    let text = document.body.textContent ?? "";
    for (const ok of CLEAR_ALLOWLIST) text = text.replaceAll(ok, "");
    expect(text).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
