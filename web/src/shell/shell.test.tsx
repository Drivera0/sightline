import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import type { CacheBundle } from "../contract";
import { Annotation, Badge, EmptyState, KeyHint, Panel, Stat } from "./components";
import { Shell } from "./Shell";

// jsdom has no WebGL, so the real MapLibre map throws. Stand in for lane B's MapView so these tests
// check what the shell passes it: lane C's heat layer must be mounted inside the map context.
vi.mock("../map/MapView", () => ({
  MapView: ({ layers }: { layers?: ReactNode }) => <div data-testid="map-view">{layers}</div>,
}));

async function sample(change?: (c: CacheBundle) => void): Promise<CacheBundle> {
  const cache = await loadCache("sample", diskFetch());
  change?.(cache);
  return cache;
}

describe("Shell header", () => {
  it("shows the title and the simulated-flight-path badge", async () => {
    render(<Shell cache={await sample()} />);

    expect(screen.getByRole("heading", { name: "Sightline · Mount Seymour survey" })).toBeInTheDocument();
    expect(screen.getByText("Simulated flight path")).toBeInTheDocument();
  });

  it("hides the badge when the path is real", async () => {
    render(<Shell cache={await sample((c) => (c.survey.simulated_path = false))} />);

    expect(screen.queryByText("Simulated flight path")).not.toBeInTheDocument();
  });

  it("flags sample data so it is never mistaken for a real run", async () => {
    render(<Shell cache={await sample()} />);

    expect(screen.getByText("Sample data")).toBeInTheDocument();
  });

  it("does not flag a real model's data as sample", async () => {
    render(<Shell cache={await sample((c) => (c.detections.model = "yolo11s-heridal-tiled-hn"))} />);

    expect(screen.queryByText("Sample data")).not.toBeInTheDocument();
  });

  it("describes the survey from the manifest", async () => {
    render(<Shell cache={await sample()} />);

    expect(screen.getByText(/20 frames/)).toBeInTheDocument();
  });
});

describe("Shell tabs", () => {
  it("offers Review, Map and Metrics with Review selected first", async () => {
    render(<Shell cache={await sample()} />);

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Review", "Map", "Metrics"]);
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Review" })).toBeInTheDocument();
  });

  it("switches panel on click", async () => {
    render(<Shell cache={await sample()} />);

    await userEvent.click(screen.getByRole("tab", { name: "Map" }));

    expect(screen.getByRole("tab", { name: "Map" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Map" })).toBeInTheDocument();
    expect(screen.queryByRole("tabpanel", { name: "Review" })).not.toBeInTheDocument();
  });

  it("moves between tabs with the arrow keys, wrapping around", async () => {
    render(<Shell cache={await sample()} />);
    screen.getByRole("tab", { name: "Review" }).focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Map" })).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Metrics" })).toHaveAttribute("aria-selected", "true");
  });

  it("gives every lane an empty mount point to fill", async () => {
    render(<Shell cache={await sample()} />);
    await userEvent.click(screen.getByRole("tab", { name: "Map" }));
    expect(screen.getByTestId("mount-map")).toBeInTheDocument();
    expect(screen.getByTestId("mount-heat")).toBeInTheDocument();
    // The heat layer is inside the map, not a sibling of it.
    expect(within(screen.getByTestId("map-view")).getByTestId("mount-heat")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(screen.getByTestId("mount-metrics")).toBeInTheDocument();
  });
});

describe("Shell shortcut overlay", () => {
  it("opens with ? and closes with Escape", async () => {
    render(<Shell cache={await sample()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.keyboard("?");
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Person")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("toggles closed when ? is pressed again", async () => {
    render(<Shell cache={await sample()} />);

    await userEvent.keyboard("??");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens from the header button", async () => {
    render(<Shell cache={await sample()} />);

    await userEvent.click(screen.getByRole("button", { name: /shortcuts/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("ignores ? typed into a text field", async () => {
    render(
      <>
        <input aria-label="note" />
        <Shell cache={await sample()} />
      </>,
    );

    await userEvent.type(screen.getByLabelText("note"), "?");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("shared components", () => {
  it("Stat shows a big number, its label and its source", () => {
    render(<Stat value="33 s" label="Human, per photo" source="Pyrrö et al. 2021" />);

    expect(screen.getByText("33 s")).toBeInTheDocument();
    expect(screen.getByText("Human, per photo")).toBeInTheDocument();
    expect(screen.getByText("Pyrrö et al. 2021")).toBeInTheDocument();
  });

  it("Badge renders its label with a status kind", () => {
    render(<Badge kind="simulated">Simulated evaluation</Badge>);

    expect(screen.getByText("Simulated evaluation")).toHaveAttribute("data-kind", "simulated");
  });

  it("KeyHint renders a kbd element", () => {
    render(<KeyHint>P</KeyHint>);

    expect(screen.getByText("P").tagName).toBe("KBD");
  });

  it("EmptyState shows a title and a message", () => {
    render(<EmptyState title="Nothing yet">Coming in hour 18</EmptyState>);

    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    expect(screen.getByText("Coming in hour 18")).toBeInTheDocument();
  });

  it("Panel renders its children", () => {
    render(<Panel>inside</Panel>);

    expect(screen.getByText("inside")).toBeInTheDocument();
  });
});

describe("Shell review tab", () => {
  it("shows the candidate list from the cache", async () => {
    render(<Shell cache={await sample()} />);

    expect(within(screen.getByRole("list", { name: "Candidates" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("M in the review tab switches to the Map tab", async () => {
    render(<Shell cache={await sample()} />);

    await userEvent.keyboard("m");

    expect(screen.getByRole("tab", { name: "Map" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("mount-map")).toBeInTheDocument();
  });
});

describe("Shell placeholder badge", () => {
  it("flags placeholder detections from a pipeline run without a real detector", async () => {
    render(<Shell cache={await sample((c) => (c.detections.model = "PLACEHOLDER"))} />);

    expect(screen.getByText("Placeholder detections")).toBeInTheDocument();
    expect(screen.queryByText("Sample data")).not.toBeInTheDocument();
  });
});

describe("Annotation", () => {
  it("uses the handwriting font, for one-off notes only", () => {
    render(<Annotation>this is where the team goes next</Annotation>);

    expect(screen.getByText("this is where the team goes next")).toHaveClass("font-hand");
  });
});
