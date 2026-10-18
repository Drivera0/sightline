import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle, Frame } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { ModelPanel, ScoreStrip } from "./ModelPanel";

let cache: CacheBundle;
const frame = (id: string) => cache.survey.frames.find((f) => f.id === id) as Frame;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
});

function panel(frameId: string | undefined, done = false) {
  const f = frameId ? frame(frameId) : undefined;
  return render(
    <ModelPanel
      cache={cache}
      dir="sample"
      frame={f}
      boxes={f ? (cache.detections.frames[f.id] ?? []) : []}
      pulseKey={`0-${frameId ?? ""}`}
      stopMs={1400}
      done={done}
    />,
  );
}

describe("ModelPanel", () => {
  it("shows the model and the facts read from the weights' layer table", () => {
    panel("f0005");
    const facts = within(screen.getByRole("list", { name: "Detector facts" }));
    expect(facts.getByText("YOLO11s")).toBeInTheDocument();
    expect(facts.getByText("1024 px")).toBeInTheDocument();
    expect(facts.getByText("9.43 M parameters")).toBeInTheDocument();
    expect(facts.getByText("24 layers")).toBeInTheDocument();
    expect(facts.getByText("1 class: person")).toBeInTheDocument();
    expect(screen.getByText(cache.detections.model)).toBeInTheDocument();
  });

  it("labels the graph as a schematic and gives the real grid count", () => {
    panel("f0005");
    expect(screen.getByText(/Schematic of our weights' real layers, not live activations/)).toBeInTheDocument();
    expect(screen.getByText("Schematic")).toBeInTheDocument();
    expect(screen.getByText("21,504")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Schematic of the detector's 24 layers/ })).toBeInTheDocument();
  });

  it("highlights the cell containing the top box's centre at all three strides", () => {
    panel("f0005");
    expect(screen.getByText("128×96")).toBeInTheDocument();
    expect(screen.getByText("64×48")).toBeInTheDocument();
    expect(screen.getByText("32×24")).toBeInTheDocument();
    // top box [512, 300, 560, 362] → stride-32 cell (17, 10) of 32×24
    const cell = within(screen.getByTestId("grid-stride-32")).getByTestId("grid-cell");
    expect(cell.style.left).toBe(`${(17 / 32) * 100}%`);
    expect(cell.style.top).toBe(`${(10 / 24) * 100}%`);
    expect(screen.getAllByTestId("grid-cell")).toHaveLength(3);
    expect(screen.getByText(/cell containing the top box's centre/)).toBeInTheDocument();
  });

  it("highlights nothing on a photo with no box", () => {
    panel("f0001");
    expect(screen.queryAllByTestId("grid-cell")).toHaveLength(0);
    expect(screen.getByText(/No box, so no cell is highlighted/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing to score/)).toBeInTheDocument();
  });

  it("gives the verdict against the flag threshold", () => {
    const { unmount } = panel("f0005");
    expect(screen.getByText("Flagged for review")).toBeInTheDocument();
    expect(screen.getAllByText("0.87").length).toBeGreaterThan(0);
    unmount();
    panel("f0003"); // top 0.12, threshold 0.25
    expect(screen.getByText("Not flagged")).toBeInTheDocument();
  });

  it("shows every box in the histogram with the threshold, and the survey totals when done", () => {
    panel(undefined, true);
    expect(screen.getByText("6 boxes ≥ 0.05 in 20 photos")).toBeInTheDocument();
    expect(screen.getByText("flag at 0.25")).toBeInTheDocument();
    expect(screen.getByText(/boxes kept across 20 photos/)).toHaveTextContent(
      "6 boxes kept across 20 photos · 3 at or above 0.25 · 3 photos flagged for review.",
    );
  });

  it("swaps the graph for the full layer table", async () => {
    panel("f0005");
    await userEvent.click(screen.getByRole("button", { name: "Layer table" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(25); // header + 24 layers
    expect(within(table).getByText("656,896")).toBeInTheDocument(); // SPPF
    expect(within(table).getByText("P3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("cites its sources", () => {
    panel("f0005");
    expect(screen.getByText(/export_model_spec\.py \(cba1f723…\)/)).toBeInTheDocument();
    expect(screen.getByText("docs.ultralytics.com/models/yolo11")).toBeInTheDocument();
    expect(screen.getByText(/80 epochs on 1024 px tiles, 890 labelled HERIDAL photos/)).toHaveAttribute(
      "title",
      "scripts/README.md and the weights-v2 release notes",
    );
    expect(screen.getByText(`${cache.metrics.detector.seconds_per_image.toFixed(2)} s per full 4000×3000 photo`)).toBeInTheDocument();
  });
});

describe("ScoreStrip", () => {
  it("places the marker at the photo's top score", () => {
    render(<ScoreStrip cache={cache} boxes={cache.detections.frames.f0005 ?? []} done={false} />);
    expect(screen.getByTestId("score-marker").style.left).toBe(`${((0.874 - 0.05) / 0.95) * 100}%`);
    expect(screen.getByText("this photo 0.87")).toBeInTheDocument();
  });
});
