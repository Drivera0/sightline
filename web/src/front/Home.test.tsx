import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ABOUT, AboutSection, COLOURS, ENTRIES } from "./About";
import { BUILT_WITH, OPENCV, PARTNERS } from "./BuiltWith";
import { ABOUT_ID } from "../shell/flow";
import { glowFrames, NODES, trip, TRIP } from "./Architecture";
import { INTAKE } from "./copy";
import { EVIDENCE_CLAIMS, FACTS, Home, HOME, JUDGE_STRIP, WALL, WALL_LOOP_PX, WALL_PX_PER_S } from "./Home";
import { PHOTOS } from "./photos";
import { ScenarioBanner } from "./ScenarioBanner";
import { RECOMMENDED, SCENARIO_CARDS } from "./scenarios";

const words = () => document.body.textContent ?? "";

describe("the home page", () => {
  it("leads with the name, the claim, one measured proof naming OpenCV, and one primary action", () => {
    render(<Home />);
    const top = screen.getByRole("heading", { level: 1 });
    expect(top).toHaveTextContent(/^Sightline$/);
    expect(top.nextElementSibling).toHaveTextContent("The brain of a drone search.");
    const proof = top.parentElement!.nextElementSibling!;
    expect(proof).toHaveTextContent("86 %");
    expect(proof).toHaveTextContent("OpenCV 5");
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

  it("gives four measured facts: a number, a headline of at most eight words, one line and its source", () => {
    render(<Home />);
    const facts = screen.getByRole("region", { name: HOME.facts });
    expect(within(facts).getAllByRole("link")).toHaveLength(4);
    for (const f of FACTS) {
      expect(f.headline.split(/\s+/).length).toBeLessThanOrEqual(8);
      expect(facts).toHaveTextContent(f.headline);
      expect(facts).toHaveTextContent(f.detail);
      expect(within(facts).getByRole("link", { name: f.source.label }).getAttribute("href")).toMatch(/^https:\/\/github\.com\/Drivera0\/sightline\//);
    }
    // no IntersectionObserver here: every number is already at its final value, never 0
    expect(facts).toHaveTextContent("86 %");
    expect(facts).toHaveTextContent("0.30 s");
    expect(facts).toHaveTextContent("12 of 12");
    expect(facts).toHaveTextContent("291 of the 337 people");
  });

  it("counts the evidence index's claims exactly", () => {
    const index = readFileSync(resolve(__dirname, "../../../docs/report/EVIDENCE_INDEX.md"), "utf8");
    const rows = index.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Claim"));
    expect(EVIDENCE_CLAIMS).toBe(rows.length);
  });

  it("shows what it is built with, OpenCV first and largest, each with a measured number and its source", () => {
    render(<Home />);
    const built = screen.getByRole("region", { name: BUILT_WITH.title });
    const cards = within(built).getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-labelledby"))).toEqual(["built-opencv", "built-nvidia", "built-nebius", "built-tavily"]);
    const opencv = cards[0]!;
    expect(opencv).toHaveTextContent(OPENCV.wordmark);
    expect(within(opencv).getAllByRole("listitem")).toHaveLength(OPENCV.steps.length);
    for (const s of OPENCV.steps) if (s.stat) expect(opencv).toHaveTextContent(s.stat);
    expect(opencv).toHaveTextContent("cv2.dnn");
    expect(opencv).toHaveTextContent("0.30 s per photo on CUDA");
    for (const [i, p] of PARTNERS.entries()) {
      const card = cards[i + 1]!;
      expect(card).toHaveTextContent(p.stat);
      for (const part of p.parts) expect(card).toHaveTextContent(part.name);
      expect(within(card).getByRole("link", { name: new RegExp(p.link.label) }).getAttribute("href")).toMatch(/^https:\/\/github\.com\/Drivera0\/sightline\//);
    }
    // the models, by name
    for (const m of ["Nemotron-3.5-Super-VL", "Nemotron 3 Nano", "Nemotron 3 Super", "Parakeet TDT 0.6B v2", "Magpie TTS", "Token Factory", "Tavily"]) expect(built).toHaveTextContent(m);
    // the hero names the stack, OpenCV first, and takes you here
    const stack = screen.getByRole("button", { name: /^Built with: OpenCV 5 cv2\.dnn, / });
    expect(stack).toBeInTheDocument();
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
      // no spoilers: the clues come in during the run, never on the card
      for (const clue of card.clues) expect(el).not.toHaveTextContent(clue);
      expect(el).toHaveTextContent(card.lastSeen);
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

  it("has no link to #about (About is on this page), and no link twice outside the judges' strip and the cards", () => {
    render(<Home />);
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => !l.closest("[aria-labelledby='home-judges']") && !l.closest("[aria-label='Scenarios']") && !l.closest("header"))
      .map((l) => l.getAttribute("href"));
    expect(hrefs).not.toContain("#about");
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("ends with About: who built it, the entries, the colours, the limits and where to ask", () => {
    render(<Home />);
    const about = screen.getByRole("region", { name: ABOUT.title });
    expect(within(about).getByRole("heading", { level: 2, name: ABOUT.title })).toHaveAttribute("id", ABOUT_ID);
    expect(within(about).getByRole("heading", { name: ABOUT.who })).toBeInTheDocument();
    expect(about).toHaveTextContent("Daniel Rivera");
    for (const e of ENTRIES) expect(within(about).getByRole("link", { name: e.name })).toBeInTheDocument();
    for (const c of COLOURS) expect(about).toHaveTextContent(c.label);
    expect(about).toHaveTextContent("It struggles with groups");
    expect(about).toHaveTextContent("every move needs a person");
    expect(within(about).getByRole("link", { name: "Questions and issues" })).toHaveAttribute("href", "https://github.com/Drivera0/sightline/issues");
    // the section stands alone too
    document.body.innerHTML = "";
    render(<AboutSection />);
    expect(screen.getByRole("heading", { level: 2, name: ABOUT.title })).toBeInTheDocument();
  });

  it("lands on About and focuses its heading when the address is #about", () => {
    render(<Home section="about" />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: ABOUT.title }));
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
