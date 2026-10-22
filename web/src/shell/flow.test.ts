import { describe, expect, it } from "vitest";
import { STEPS, nextStep, previousStep, stepFromHash, stepFromKey } from "./flow";

describe("demo flow steps", () => {
  it("runs Survey, Rank, Review, Search next, Command, Results in that order", () => {
    expect(STEPS.map((s) => s.label)).toEqual(["Survey", "Rank", "Review", "Search next", "Command", "Results"]);
  });

  it("moves forward and back, stopping at the ends", () => {
    expect(nextStep("survey")).toBe("rank");
    expect(nextStep("results")).toBe("results");
    expect(previousStep("rank")).toBe("survey");
    expect(previousStep("survey")).toBe("survey");
  });

  it("reads the step from the URL hash, falling back to the survey", () => {
    expect(stepFromHash("#review")).toBe("review");
    expect(stepFromHash("#search")).toBe("search");
    expect(stepFromHash("#operate")).toBe("operate");
    expect(stepFromHash("")).toBe("survey");
    expect(stepFromHash("#nonsense")).toBe("survey");
  });

  it("maps the number keys 1-6 to the steps", () => {
    expect(stepFromKey("1")).toBe("survey");
    expect(stepFromKey("5")).toBe("operate");
    expect(stepFromKey("6")).toBe("results");
    expect(stepFromKey("7")).toBeNull();
    expect(stepFromKey("p")).toBeNull();
  });
});
