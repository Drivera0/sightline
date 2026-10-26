import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import secondLook from "../command/__fixtures__/second_look/verdict.json";
import { AGENTIC } from "./AgenticVision";
import { Home, HOME } from "./Home";

const section = () => screen.getByRole("region", { name: AGENTIC.title });

describe("what the photo changes", () => {
  it("comes right after the facts, before Built with, and names Agentic vision once", () => {
    render(<Home />);
    const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2s.indexOf(AGENTIC.title)).toBe(h2s.indexOf(HOME.built) - 1);
    expect((document.body.textContent!.match(/agentic vision/gi) ?? []).length).toBe(1);
    expect(section()).toHaveTextContent(/^Agentic vision/);
  });

  it("shows the real chain in five steps, with the fixture's numbers and words", () => {
    render(<Home />);
    const steps = within(within(section()).getByRole("list", { name: "One chain, step by step" })).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => within(s).getByRole("heading").textContent)).toEqual(AGENTIC.steps.map((s) => s.title));
    const [perceive, look, reason, propose, decide] = steps as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(perceive).toHaveTextContent("OpenCV 5 cv2.dnn");
    expect(perceive).toHaveTextContent("scores it 0.17");
    expect(perceive).toHaveTextContent("Below the 0.29 review line");
    expect(look).toHaveTextContent("79 px box");
    expect(look).toHaveTextContent("CLAHE");
    expect(reason).toHaveTextContent(secondLook.verdict.reason);
    expect(reason).toHaveTextContent("Nemotron-3.5-Super-VL");
    expect(propose).toHaveTextContent("Add f0273-d02 to the review queue");
    expect(decide).toHaveTextContent("logged with your name and the time");
    // the two pictures are the frame (with the detector's box) and OpenCV's zoom
    expect(within(perceive).getByRole("img").getAttribute("src")).toBe("/front/wall/f0273.webp");
    expect(within(look).getByRole("img").getAttribute("src")).toMatch(/f0273-d02-zoom_native\.jpg/);
    // each step says where it lives
    expect(within(reason).getByRole("link").getAttribute("href")).toBe("#m/demo/trace");
    expect(within(propose).getByRole("link").getAttribute("href")).toBe("#m/demo/map?needs");
  });

  it("sends step 5 to the guided simulation", async () => {
    render(<Home />);
    await userEvent.click(within(section()).getByRole("button", { name: AGENTIC.decide }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: HOME.sim }));
  });

  it("offers Try your own photo, labelled honestly, opening the existing panel", () => {
    render(<Home />);
    const tryIt = within(section()).getByRole("group", { name: AGENTIC.try.title });
    expect(within(tryIt).getByRole("link", { name: AGENTIC.try.action })).toHaveAttribute("href", "#try");
    expect(tryIt).toHaveTextContent("in your browser, with ONNX Runtime Web");
    expect(tryIt).toHaveTextContent("OpenCV 5 cv2.dnn");
    expect(tryIt).toHaveTextContent("never leaves your device");
  });
});
