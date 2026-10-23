import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PhotosHowTo } from "./PhotosRail";

describe("the Photos view says how photos get in", () => {
  it("in three lines: drop after landing or the samples, the live watch, stills not video and why", () => {
    render(<PhotosHowTo />);
    const lines = screen.getAllByRole("listitem").map((l) => l.textContent);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/drop .*photos here, or Load 20 sample photos/);
    expect(lines[1]).toMatch(/laptop client watches the card or controller folder/);
    expect(lines[2]).toMatch(/Stills, not video: .*70 px.*15 px/);
  });
});
