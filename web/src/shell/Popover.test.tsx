import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Sourced } from "./Popover";

describe("Sourced", () => {
  it("shows its source on tap and on keyboard focus, and hides it on Escape", async () => {
    render(<Sourced source="metrics.ranking">first 40 photos</Sourced>);
    const trigger = screen.getByRole("button", { name: "first 40 photos" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await userEvent.tab();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Source" + "metrics.ranking");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();

    await userEvent.click(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent("metrics.ranking");
  });
});
