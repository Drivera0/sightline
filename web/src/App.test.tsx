import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, discoverAvailableSurveys, surveyCandidates } from "./App";
import { loadCache, useCache } from "./lib/cache";
import { diskFetch } from "./lib/diskFetch";
import { useSelection } from "./lib/selection";

describe("App", () => {
  beforeEach(() => {
    useCache.getState().reset();
    useSelection.getState().clear();
    vi.unstubAllGlobals();
  });

  it("switches between simulated and real-position caches and clears stale selection", async () => {
    const source = await loadCache("sample", diskFetch());
    const demo = structuredClone(source);
    demo.manifest.survey_id = "seymour-demo";
    demo.survey.survey_id = "seymour-demo";
    const real = structuredClone(source);
    real.manifest.survey_id = "heridal-real-gps";
    real.manifest.simulated_path = false;
    real.survey.survey_id = "heridal-real-gps";
    real.survey.simulated_path = false;
    real.survey.area.name = "HERIDAL SB site (real EXIF positions)";
    vi.stubGlobal(
      "fetch",
      diskFetch({
        "/cache/demo/manifest.json": () => Response.json(demo.manifest),
        "/cache/demo/survey.json": () => Response.json(demo.survey),
        "/cache/demo/detections.json": () => Response.json(demo.detections),
        "/cache/demo/map.json": () => Response.json(demo.map),
        "/cache/demo/metrics.json": () => Response.json(demo.metrics),
        "/cache/real-gps/manifest.json": () => Response.json(real.manifest),
        "/cache/real-gps/survey.json": () => Response.json(real.survey),
        "/cache/real-gps/detections.json": () => Response.json(real.detections),
        "/cache/real-gps/map.json": () => Response.json(real.map),
        "/cache/real-gps/metrics.json": () => Response.json(real.metrics),
      }),
    );
    useSelection.getState().selectDetection("f0001-d01");
    render(<App dir="demo" />);
    await screen.findByRole("heading", { name: /Mount Seymour/ });

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Survey" }),
      "real-gps",
    );

    expect(await screen.findByText("HERIDAL SB site")).toBeInTheDocument();
    expect(useSelection.getState().selectedDetectionId).toBeNull();

    useSelection.getState().selectDetection("f0001-d01");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Survey" }), "demo");
    expect(await screen.findByText("Mount Seymour")).toBeInTheDocument();
    expect(useSelection.getState().selectedDetectionId).toBeNull();
  });

  it("shows a loading state, then the shell", async () => {
    vi.stubGlobal("fetch", diskFetch());
    render(<App dir="sample" />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    expect(await screen.findByRole("heading", { name: /Sightline/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows which file failed and how to fix it, with no tabs", async () => {
    vi.stubGlobal("fetch", diskFetch());
    render(<App dir="missing-cache" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/manifest\.json/);
    expect(alert).toHaveTextContent(/pipeline/);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("only offers surveys whose manifest loads", async () => {
    const options = surveyCandidates(false);
    const fetchManifest = vi.fn<typeof fetch>(async (input) =>
      String(input) === "/cache/demo/manifest.json"
        ? Response.json({ contract_version: "1.1" })
        : new Response("not found", { status: 404 }),
    );

    await expect(discoverAvailableSurveys(options, fetchManifest)).resolves.toEqual([
      { dir: "demo", label: "Mount Seymour simulation" },
    ]);
  });

  it("keeps a working survey selector on the error screen", async () => {
    const demo = await loadCache("sample", diskFetch());
    demo.manifest.survey_id = "seymour-demo";
    demo.survey.survey_id = "seymour-demo";
    const demoFiles: Record<string, () => Response> = {
      "/cache/demo/manifest.json": () => Response.json(demo.manifest),
      "/cache/demo/survey.json": () => Response.json(demo.survey),
      "/cache/demo/detections.json": () => Response.json(demo.detections),
      "/cache/demo/map.json": () => Response.json(demo.map),
      "/cache/demo/metrics.json": () => Response.json(demo.metrics),
      "/cache/sample/manifest.json": () => new Response("not found", { status: 404 }),
      "/cache/real-gps/manifest.json": () => new Response("not found", { status: 404 }),
    };
    vi.stubGlobal("fetch", diskFetch(demoFiles));
    render(<App dir="missing-cache" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/manifest\.json/);
    const picker = await screen.findByRole("combobox", { name: "Survey" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Choose a survey",
      "Mount Seymour simulation",
    ]);

    await userEvent.selectOptions(picker, "demo");
    expect(await screen.findByRole("heading", { name: "Sightline" })).toBeInTheDocument();
  });

  it("keeps sample data out of production survey candidates", () => {
    expect(surveyCandidates(false).map((option) => option.dir)).toEqual(["demo", "real-gps"]);
    expect(surveyCandidates(true).map((option) => option.dir)).toEqual([
      "sample",
      "demo",
      "real-gps",
    ]);
  });
});
