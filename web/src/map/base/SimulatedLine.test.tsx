import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SimulatedLine } from "./SimulatedLine";

describe("SimulatedLine", () => {
  it("names every simulated thing once: the flight path, the radius and the placeholder prior", () => {
    render(<SimulatedLine simulatedPath radiusM={10} placeholderPrior />);
    expect(screen.getByTestId("simulated-line")).toHaveTextContent("Simulated:flight path·10 m radius·placeholder prior");
  });

  it("lists only what applies (real positions, a cited prior)", () => {
    render(<SimulatedLine simulatedPath={false} radiusM={10} placeholderPrior={false} />);
    expect(screen.getByTestId("simulated-line")).toHaveTextContent("Simulated:10 m radius");
    expect(screen.queryByText("flight path")).toBeNull();
  });

  it("explains an item on tap", async () => {
    render(<SimulatedLine simulatedPath radiusM={10} placeholderPrior={false} />);
    await userEvent.click(screen.getByRole("button", { name: "flight path" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(/not recorded GPS/);
  });
});
