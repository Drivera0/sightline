import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AboutSheet, ENTRIES, LICENCES, MODELS } from "./About";
import { glowFrames, NODES, trip, TRIP } from "./Architecture";
import { INTAKE } from "./copy";
import { FACTS, Home, HOME, JUDGE_STRIP, WALL, WALL_LOOP_PX, WALL_PX_PER_S } from "./Home";
import { PHOTOS } from "./photos";
import { ScenarioBanner } from "./ScenarioBanner";
import { RECOMMENDED, SCENARIO_CARDS } from "./scenarios";

const words = () => document.body.textContent ?? "";

describe("the home page", () => {
  it("leads with the claim, one measured proof and one primary action", () => {
    render(<Home />);
    const top = screen.getByRole("heading", { level: 1 });
    expect(top).toHaveTextContent("The brain of a drone search.");
    expect(top.nextElementSibling).toHaveTextContent("86 %");
    expect(screen.getByRole("button", { name: HOME.primary })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: HOME.secondary })).toHaveAttribute("href", "#m/demo/map");
    expect(document.querySelectorAll(".bg-accent")).toHaveLength(1);
  });

  it("scrolls the primary action to the guided simulation and focuses its heading", async () => {
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: HOME.primary }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: HOME.sim }));
  });

  it("moves the wall of real aerial photos no faster than 8 px/s, local files only", () => {
    render(<Home />);
    expect(Math.max(...WALL_PX_PER_S)).toBeLessThanOrEqual(8);
    const wall = screen.getByTestId("photo-wall");
    const cols = wall.querySelectorAll(".sl-home-wall");
    expect(cols).toHaveLength(WALL_PX_PER_S.length);
    cols.forEach((c, i) => {
      const s = parseFloat((c as HTMLElement).style.animationDuration);
      expect(WALL_LOOP_PX / s).toBeLessThanOrEqual(8);
      expect(WALL_LOOP_PX / s).toBeCloseTo(WALL_PX_PER_S[i]!, 0);
    });
    for (const src of WALL) expect(src).toMatch(/^\/front\/wall\/f\d{4}\.webp$/);
    // decorative: hidden from assistive technology
    expect(wall.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("gives four measured facts, each with its source", () => {
    render(<Home />);
    const facts = screen.getByRole("region", { name: HOME.facts });
    expect(within(facts).getAllByRole("link")).toHaveLength(4);
    for (const f of FACTS) {
      expect(facts).toHaveTextContent(f.label);
      expect(within(facts).getByRole("link", { name: f.source.label }).getAttribute("href")).toMatch(/^https:\/\/github\.com\/Drivera0\/sightline\//);
    }
    expect(facts).toHaveTextContent("0.30 s");
    expect(facts).toHaveTextContent("12 of 12");
  });

  it("draws how it works, one plain line per step and the models named small", () => {
    render(<Home />);
    expect(screen.getAllByRole("figure", { name: "How Sightline fits together" })).toHaveLength(1);
    expect(screen.getByRole("img", { name: /Drone photos go to the detector/ })).toBeInTheDocument();
    for (const n of NODES) expect(words()).toContain(n.plain);
    expect(words()).toContain("YOLO11s on OpenCV 5 cv2.dnn");
  });

  it("says how photos get in, whether it is live, and that it is not a video detector", () => {
    render(<Home />);
    const how = screen.getByRole("region", { name: HOME.how });
    const intake = within(how).getByRole("list", { name: HOME.intake });
    expect(within(intake).getAllByRole("listitem")).toHaveLength(3);
    for (const p of INTAKE) expect(intake).toHaveTextContent(p.title);
    expect(intake).toHaveTextContent("python -m sightline.client watch");
    expect(intake).toHaveTextContent("about 70 px wide in a still and about 15 px in a video frame");
    expect(within(intake).getByRole("link", { name: /sample/i })).toHaveAttribute("href", "/sample/sightline-sample-photos.zip");
  });

  it("sends the photo through every step in order, each lit once as it passes", () => {
    const { at } = trip();
    const times = TRIP.map((id) => at[id]!);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    expect(times[times.length - 1]!).toBeLessThan(1);
    for (const t of times) {
      const f = glowFrames(t);
      const keys = f.keyTimes.split(";").map(Number);
      expect(keys[0]).toBe(0);
      expect(keys[keys.length - 1]).toBe(1);
      for (let i = 1; i < keys.length; i++) expect(keys[i]!).toBeGreaterThan(keys[i - 1]!);
      expect(f.values.split(";")).toHaveLength(keys.length);
    }
  });

  it("says who it is for, over photographs of a real search", () => {
    render(<Home />);
    const who = screen.getByRole("region", { name: HOME.who });
    expect(within(who).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Search manager", "Image reviewer", "Ground team leader"]);
    for (const i of within(who).getAllByRole("img")) {
      expect(PHOTOS.map((p) => p.src)).toContain(i.getAttribute("src"));
      expect(i.getAttribute("alt")!.length).toBeGreaterThan(20);
    }
  });

  it("explains the guided simulation once, with a card for every scenario", () => {
    render(<Home />);
    const sim = screen.getByRole("region", { name: HOME.sim });
    expect(sim).toHaveTextContent("You are the search manager: the AI proposes, you decide");
    const cards = within(sim).getAllByRole("listitem").filter((li) => li.parentElement?.getAttribute("aria-label") === "Scenarios");
    expect(cards.map((c) => within(c).getByRole("heading").textContent)).toEqual(["Overdue hikerStart here", "Missing child", "Despondent", "Dementia walk-away", "Shuffle"]);
    for (const [i, card] of SCENARIO_CARDS.entries()) {
      const el = cards[i]!;
      expect(el).toHaveTextContent(card.subject);
      expect(el).toHaveTextContent(card.setting);
      for (const clue of card.clues) expect(el).toHaveTextContent(clue);
      expect(el).toHaveTextContent(card.length);
      expect(el.textContent!.includes("Start here")).toBe(card.seed === RECOMMENDED);
      const start = within(el).getByRole("link", { name: `Start the simulation: ${card.name}` });
      const plain = within(el).getByRole("link", { name: `Open the console only: ${card.name}` });
      if (card.seed !== "shuffle") {
        expect(start).toHaveAttribute("href", `#m/demo?s=${card.seed}&guide=1`);
        expect(plain).toHaveAttribute("href", `#m/demo/map?s=${card.seed}`);
      }
    }
  });

  it("starts Shuffle on a new seed each time", async () => {
    render(<Home />);
    await userEvent.click(screen.getByRole("link", { name: "Start the simulation: Shuffle" }));
    expect(window.location.hash).toMatch(/^#m\/demo\?s=s[0-9a-z]+&guide=1$/);
  });

  it("lists what judges need, each link to something the page does not show", () => {
    render(<Home />);
    const strip = screen.getByRole("region", { name: HOME.judges });
    const links = within(strip).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(JUDGE_STRIP.map((j) => j.href));
    expect(new Set(links.map((l) => l.getAttribute("href"))).size).toBe(links.length);
    expect(strip).toHaveTextContent("Evidence index");
    expect(strip).toHaveTextContent("Devpost");
  });

  it("has no link to the About sheet, and no link twice outside the judges' strip and the cards", () => {
    render(<Home />);
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => !l.closest("[aria-labelledby='home-judges']") && !l.closest("[aria-label='Scenarios']") && !l.closest("header"))
      .map((l) => l.getAttribute("href"));
    expect(hrefs).not.toContain("#about");
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("has the footer: the one disclosure, the credits and the licence", () => {
    render(<Home />);
    const foot = screen.getByRole("contentinfo");
    expect(foot).toHaveTextContent("Simulation on real aerial photographs");
    expect(foot).toHaveTextContent("HERIDAL");
    expect(foot).toHaveTextContent("Jacob W. Frank");
    expect(within(foot).getByRole("link", { name: /AGPL-3\.0/ }).getAttribute("href")).toMatch(/LICENSE$/);
  });

  it("never says an area is cleared, and keeps demo wording to the disclosure", () => {
    render(<Home />);
    const text = words();
    expect(text).not.toMatch(/\bclear(ed|ing|s)?\b|rule out/i);
    expect(text).not.toMatch(/\b(demo|recorded|scripted)\b/i);
  });
});

describe("the scenario banner", () => {
  it("names the scenario, the area and the clock, and opens the cards in a sheet", async () => {
    render(<ScenarioBanner seed="missing-child" area="Mount Seymour" clock="13:35 PDT" />);
    expect(screen.getByRole("region", { name: "Scenario" })).toHaveTextContent("Missing child · Mount Seymour · 13:35 PDT");
    await userEvent.click(screen.getByRole("button", { name: "Change scenario" }));
    const sheet = screen.getByRole("dialog", { name: "Choose a search" });
    expect(within(sheet).getAllByRole("link", { name: /^Start the simulation: / })).toHaveLength(5);
    expect(within(sheet).getByRole("heading", { name: /Missing child/ })).toHaveTextContent("on screen");
  });
});

describe("About", () => {
  it("says only what the home page does not: who built it, the entries, the colours, the models, the limits, the licences", () => {
    render(<AboutSheet onClose={() => undefined} />);
    const sheet = screen.getByRole("dialog", { name: "About Sightline" });
    expect(within(sheet).queryAllByRole("img").filter((i) => i.tagName === "IMG")).toHaveLength(0);
    expect(within(sheet).queryByRole("figure", { name: "How Sightline fits together" })).toBeNull();
    expect(within(sheet).getByRole("heading", { name: "Who built it" })).toBeInTheDocument();
    for (const e of ENTRIES) expect(within(sheet).getByRole("link", { name: e.name })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "What the colours mean" })).toBeInTheDocument();
    for (const m of MODELS) expect(sheet).toHaveTextContent(m.model);
    for (const l of LICENCES) expect(sheet).toHaveTextContent(l.licence);
    expect(sheet).toHaveTextContent("Simulation on real aerial photographs");
    expect(sheet).toHaveTextContent("It struggles with groups");
    expect(within(sheet).getByRole("list", { name: "How photos get in" })).toHaveTextContent(/not live video/i);
    expect(within(sheet).getByRole("link", { name: "Home page" })).toHaveAttribute("href", "#");
    expect(within(sheet).getByRole("link", { name: "The report" })).toBeInTheDocument();
  });
});
