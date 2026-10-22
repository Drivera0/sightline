import { describe, expect, it } from "vitest";
import { STEPS, nextStep, previousStep, redirectFromHash, routeFromHash, stepFromHash, stepFromKey } from "./flow";

describe("demo flow steps", () => {
  it("runs Survey, Rank, Review, Search next, Results in that order (the console is its own place)", () => {
    expect(STEPS.map((s) => s.label)).toEqual(["Survey", "Rank", "Review", "Search next", "Results"]);
  });

  it("moves forward and back, stopping at the ends", () => {
    expect(nextStep("survey")).toBe("rank");
    expect(nextStep("search")).toBe("results");
    expect(nextStep("results")).toBe("results");
    expect(previousStep("results")).toBe("search");
    expect(previousStep("rank")).toBe("survey");
    expect(previousStep("survey")).toBe("survey");
  });

  it("reads the step from the URL hash, falling back to the survey", () => {
    expect(stepFromHash("#review")).toBe("review");
    expect(stepFromHash("#search")).toBe("search");
    expect(stepFromHash("#searchnext")).toBe("search");
    expect(stepFromHash("#operate")).toBe("survey"); // no longer a step: it redirects to the console
    expect(stepFromHash("")).toBe("survey");
    expect(stepFromHash("#nonsense")).toBe("survey");
  });

  it("maps the number keys 1-5 to the steps", () => {
    expect(stepFromKey("1")).toBe("survey");
    expect(stepFromKey("4")).toBe("search");
    expect(stepFromKey("5")).toBe("results");
    expect(stepFromKey("6")).toBeNull();
    expect(stepFromKey("p")).toBeNull();
  });
});

describe("routes and redirects", () => {
  it("sends the old Command step and alias to the console, and #searchnext to Search next", () => {
    expect(redirectFromHash("#operate")).toBe("#m/demo/command");
    expect(redirectFromHash("#command")).toBe("#m/demo/command");
    expect(redirectFromHash("#searchnext")).toBe("#search");
    expect(redirectFromHash("#review")).toBeNull();
    expect(routeFromHash("#operate")).toEqual({ kind: "mission", id: "demo" });
    expect(routeFromHash("#searchnext")).toEqual({ kind: "demo" });
  });

  it("knows Try a photo, For judges and the overview", () => {
    expect(routeFromHash("#try")).toEqual({ kind: "try" });
    expect(routeFromHash("#judges")).toEqual({ kind: "judges" });
    expect(routeFromHash("")).toEqual({ kind: "front" });
    expect(routeFromHash("#results")).toEqual({ kind: "demo" });
  });
});
