import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import type { CacheBundle } from "../contract";
import { Annotation, Badge, EmptyState, KeyHint, Panel, Stat } from "./components";
import { Shell, shortSurveyName } from "./Shell";

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
  it("shows the title, the place and one simulated-flight-path label under it", async () => {
    render(<Shell cache={await sample()} />);

    expect(screen.getByRole("link", { name: "Sightline" })).toHaveAttribute("href", "#"); // the brand, back to the overview
    expect(screen.getByTitle("Mount Seymour, North Vancouver")).toHaveTextContent("Mount Seymour");
    expect(screen.getAllByText("Simulated flight path")).toHaveLength(1);
  });

  it("uses the real survey name and hides the simulated badge", async () => {
    render(
      <Shell
        cache={await sample((cache) => {
          cache.survey.simulated_path = false;
          cache.survey.area.name = "HERIDAL SB site (real EXIF positions)";
        })}
      />,
    );

    expect(screen.getByRole("link", { name: "Sightline" })).toHaveAttribute("href", "#"); // the brand, back to the overview
    expect(screen.getByText("HERIDAL SB site")).toBeInTheDocument();
    expect(screen.queryByText("Simulated flight path")).not.toBeInTheDocument();
  });

  it("offers the real-position survey and reports selection changes", async () => {
    const onCacheDirChange = vi.fn();
    render(
      <Shell
        cache={await sample()}
        cacheDir="demo"
        onCacheDirChange={onCacheDirChange}
        surveyOptions={[
          { dir: "demo", label: "Mount Seymour simulation" },
          { dir: "real-gps", label: "Real EXIF positions" },
        ]}
      />,
    );

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Survey" }), "real-gps");

    expect(onCacheDirChange).toHaveBeenCalledWith("real-gps");
    // A native select over the quiet survey button, so keyboard and screen readers get the real control.
    expect(screen.getByRole("combobox", { name: "Survey" })).toHaveClass("absolute", "inset-0", "opacity-0");
  });

  it("goes back to step 1 when the survey changes", async () => {
    window.location.hash = "#review";
    const onCacheDirChange = vi.fn();
    render(
      <Shell
        cache={await sample()}
        cacheDir="demo"
        onCacheDirChange={onCacheDirChange}
        surveyOptions={[
          { dir: "demo", label: "Mount Seymour simulation" },
          { dir: "real-gps", label: "Real EXIF positions" },
        ]}
      />,
    );
    expect(screen.getByRole("main")).toHaveAccessibleName("Review");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Survey" }), "real-gps");

    expect(onCacheDirChange).toHaveBeenCalledWith("real-gps");
    expect(window.location.hash).toBe("#survey");
    expect(screen.getByRole("main")).toHaveAccessibleName("Survey");
  });

  it("removes only a trailing explanatory parenthetical from survey names", () => {
    expect(shortSurveyName("Mount Seymour, North Vancouver (simulated flight path)")).toBe(
      "Mount Seymour, North Vancouver",
    );
    expect(shortSurveyName("HERIDAL SB site (real EXIF positions)")).toBe("HERIDAL SB site");
    expect(shortSurveyName("Survey (north) sector")).toBe("Survey (north) sector");
  });

  it("flags sample data so it is never mistaken for a real run", async () => {
    render(<Shell cache={await sample()} />);

    expect(screen.getByText("Sample data")).toBeInTheDocument();
  });

  it("does not flag a real model's data as sample", async () => {
    render(<Shell cache={await sample((c) => (c.detections.model = "yolo11s-heridal-tiled-hn"))} />);

    expect(screen.queryByText("Sample data")).not.toBeInTheDocument();
  });

  it("keeps the app bar to one row: no frame count or survey id", async () => {
    render(<Shell cache={await sample()} />);

    expect(screen.queryByText(/20 frames/)).not.toBeInTheDocument();
  });

  it("keeps only Shortcuts, Try a photo and the background toggle in the menu (the places are in the app bar)", async () => {
    render(<Shell cache={await sample()} />);

    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const menu = screen.getByRole("menu", { name: "Menu" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Keyboard shortcuts"),
      expect.stringContaining("Try a photo"),
      expect.stringContaining("Background animation: on"),
    ]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("turns the intro's background animation off and on from the menu", async () => {
    window.localStorage.removeItem("sightline.modelBackground");
    render(<Shell cache={await sample()} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Background animation: on/ }));
    expect(window.localStorage.getItem("sightline.modelBackground")).toBe("off");
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Background animation: off/ }));
    expect(window.localStorage.getItem("sightline.modelBackground")).toBe("on");
  });
});

describe("Shell steps (replace the old tabs)", () => {
  it("gives every lane a mount point on its step, heat layer inside the map", async () => {
    render(<Shell cache={await sample()} />);
    await userEvent.keyboard("3");
    expect(screen.getByTestId("mount-map")).toBeInTheDocument();
    await userEvent.keyboard("4");
    expect(screen.getByTestId("mount-heat")).toBeInTheDocument();
    // The heat layer is inside the map, not a sibling of it.
    expect(within(screen.getByTestId("map-view")).getByTestId("mount-heat")).toBeInTheDocument();
    await userEvent.keyboard("5");
    expect(screen.getByTestId("mount-metrics")).toBeInTheDocument();
    await userEvent.keyboard("1");
  });

  it("C opens the console: the guided demo has no Command step of its own", async () => {
    window.location.hash = "#review";
    render(<Shell cache={await sample()} />);
    await userEvent.keyboard("c");
    expect(window.location.hash).toBe("#m/demo/command");
  });

  it("sits under the one app bar, with the steps as its second row", async () => {
    window.location.hash = "#survey";
    render(<Shell cache={await sample()} />);
    const bar = screen.getByRole("navigation", { name: "Sightline" }).closest("header") as HTMLElement;
    expect(within(bar).getByRole("link", { name: "Guided demo" })).toHaveAttribute("aria-current", "page");
    expect(within(bar).getByRole("navigation", { name: "Demo steps" })).toBeInTheDocument();
    expect(within(bar).getByRole("link", { name: "For judges" })).toHaveAttribute("href", "#judges");
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

  it("opens from the app bar menu", async () => {
    render(<Shell cache={await sample()} />);

    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /keyboard shortcuts/i }));

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

  it("KeyHint hides on touch screens: no hover, or a coarse pointer", () => {
    render(<KeyHint>P</KeyHint>);

    expect(screen.getByText("P")).toHaveClass("[@media(hover:none)]:hidden", "[@media(pointer:coarse)]:hidden");
  });

  it("StepBar numbers future steps in text-2, for contrast on the chip", async () => {
    const { StepBar } = await import("./StepBar");
    render(<StepBar value="rank" onChange={() => {}} />);

    const future = screen.getByRole("button", { name: /Results/ });
    expect(future.querySelector("span")).toHaveClass("text-text-2");
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

describe("Shell review step", () => {
  it("shows the candidate list from the cache", async () => {
    render(<Shell cache={await sample()} />);
    await userEvent.keyboard("3");
    expect(within(screen.getByRole("listbox", { name: "Candidates" })).getAllByRole("option")).toHaveLength(3);
    await userEvent.keyboard("1");
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

describe("Shell credits", () => {
  it("credits the HERIDAL imagery and its licence on every screen", async () => {
    render(<Shell cache={await sample()} />);
    const credit = screen.getByText(/HERIDAL dataset/);
    expect(credit).toHaveTextContent(/Božić-Štulić/);
    expect(credit).toHaveTextContent(/CC BY 3\.0/);
    for (const key of ["2", "3", "4", "5", "1"]) {
      await userEvent.keyboard(key);
      expect(screen.getByText(/HERIDAL dataset/)).toBeInTheDocument();
    }
  });

  it("describes whether image positions are simulated or recorded", async () => {
    const { rerender } = render(<Shell cache={await sample()} />);
    expect(screen.getByText(/Real photos on a simulated flight path/)).toBeInTheDocument();

    rerender(<Shell cache={await sample((cache) => (cache.survey.simulated_path = false))} />);
    expect(screen.getByText(/Real photos at recorded EXIF positions/)).toBeInTheDocument();
  });
});
