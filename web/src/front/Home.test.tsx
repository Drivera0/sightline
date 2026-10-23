import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AboutSheet, MODELS } from "./About";
import { Home } from "./Home";
import { PHOTOS } from "./photos";
import { ScenarioBanner } from "./ScenarioBanner";
import { SCENARIO_CARDS } from "./scenarios";

describe("the home page", () => {
  it("says what Sightline is in two lines, with one primary action", () => {
    render(<Home />);
    const top = screen.getByRole("heading", { level: 1 });
    expect(top).toHaveTextContent("The brain of a drone search.");
    expect(top.nextElementSibling).toHaveTextContent("nothing moves until a person approves it");
    expect(screen.getByRole("link", { name: "Follow a search" })).toHaveAttribute("href", "#m/demo?s=overdue-hiker&guide=1");
    expect(document.querySelectorAll(".bg-accent")).toHaveLength(1);
  });

  it("shows the four photographs, local, each with a description", () => {
    render(<Home />);
    const imgs = within(screen.getByRole("list", { name: "Photographs of a real search" })).getAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(PHOTOS.map((p) => p.src));
    for (const i of imgs) {
      expect(i.getAttribute("src")).toMatch(/^\/front\/.+\.webp$/);
      expect(i.getAttribute("alt")!.length).toBeGreaterThan(20);
    }
  });

  it("draws how it fits together", () => {
    render(<Home />);
    expect(screen.getAllByRole("figure", { name: "How Sightline fits together" })).toHaveLength(1);
    expect(screen.getByRole("img", { name: /Drone photos go to the detector/ })).toBeInTheDocument();
  });

  it("has a card for every scenario: setting, clues, length, Start and Just the console", () => {
    render(<Home />);
    const cards = within(screen.getByRole("list", { name: "Scenarios" })).getAllByRole("listitem").filter((li) => li.parentElement?.getAttribute("aria-label") === "Scenarios");
    expect(cards.map((c) => within(c).getByRole("heading").textContent)).toEqual(["Overdue hiker", "Missing child", "Despondent", "Dementia walk-away", "Shuffle"]);
    for (const [i, card] of SCENARIO_CARDS.entries()) {
      const el = cards[i]!;
      expect(el).toHaveTextContent(card.setting);
      for (const clue of card.clues) expect(el).toHaveTextContent(clue);
      expect(el).toHaveTextContent(card.length);
      const start = within(el).getByRole("link", { name: `Start: ${card.name}` });
      const plain = within(el).getByRole("link", { name: `Just the console: ${card.name}` });
      if (card.seed !== "shuffle") {
        expect(start).toHaveAttribute("href", `#m/demo?s=${card.seed}&guide=1`);
        expect(plain).toHaveAttribute("href", `#m/demo/map?s=${card.seed}`);
      }
    }
  });

  it("starts Shuffle on a new seed each time", async () => {
    render(<Home />);
    await userEvent.click(screen.getByRole("link", { name: "Start: Shuffle" }));
    expect(window.location.hash).toMatch(/^#m\/demo\?s=s[0-9a-z]+&guide=1$/);
  });

  it("has the footer: the repo, the report, the sample photos, the credits and the one disclosure", () => {
    render(<Home />);
    const foot = screen.getByRole("contentinfo");
    expect(within(foot).getByRole("link", { name: "Code on GitHub" })).toHaveAttribute("href", "https://github.com/Drivera0/sightline");
    expect(within(foot).getByRole("link", { name: "The report" }).getAttribute("href")).toMatch(/OPENCV_REPORT\.md$/);
    expect(within(foot).getByRole("link", { name: "Sample drone photos (.zip)" })).toHaveAttribute("href", "/sample/sightline-sample-photos.zip");
    expect(foot).toHaveTextContent("HERIDAL");
    expect(foot).toHaveTextContent("Simulation on real aerial photographs");
  });
});

describe("the scenario banner", () => {
  it("names the scenario, the area and the clock, and opens the cards in a sheet", async () => {
    render(<ScenarioBanner seed="missing-child" area="Mount Seymour" clock="13:35 PDT" />);
    expect(screen.getByRole("region", { name: "Scenario" })).toHaveTextContent("Missing child · Mount Seymour · 13:35 PDT");
    await userEvent.click(screen.getByRole("button", { name: "Change scenario" }));
    const sheet = screen.getByRole("dialog", { name: "Choose a search" });
    expect(within(sheet).getAllByRole("link", { name: /^Start: / })).toHaveLength(5);
    expect(within(sheet).getByRole("heading", { name: /Missing child/ })).toHaveTextContent("on screen");
  });
});

describe("About", () => {
  it("has the photographs, the four steps, the diagram, the colours, the models, the limits and the links", () => {
    render(<AboutSheet onClose={() => undefined} />);
    const sheet = screen.getByRole("dialog", { name: "About Sightline" });
    expect(within(sheet).getAllByRole("img").filter((i) => i.tagName === "IMG")).toHaveLength(4);
    expect(within(within(sheet).getByRole("list", { name: "How it works" })).getAllByRole("listitem")).toHaveLength(4);
    expect(within(sheet).getByRole("figure", { name: "How Sightline fits together" })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "What the colours mean" })).toBeInTheDocument();
    for (const m of MODELS) expect(sheet).toHaveTextContent(m.model);
    expect(sheet).toHaveTextContent("Nemotron-3.5-Super-VL");
    expect(sheet).toHaveTextContent("Simulation on real aerial photographs");
    expect(sheet).toHaveTextContent("It struggles with groups");
    expect(within(sheet).getByRole("link", { name: "Home: choose a search" })).toHaveAttribute("href", "#");
    expect(within(sheet).getByRole("link", { name: "The report" })).toBeInTheDocument();
  });
});
