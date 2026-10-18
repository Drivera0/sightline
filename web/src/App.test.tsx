import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { loadCache, useCache } from "./lib/cache";
import { diskFetch } from "./lib/diskFetch";
import { useSelection } from "./lib/selection";

describe("App", () => {
  beforeEach(() => {
    useCache.getState().reset();
    useSelection.getState().clear();
    vi.unstubAllGlobals();
  });

  it("loads the selected real-position cache and clears stale map selection", async () => {
    const real = await loadCache("sample", diskFetch());
    real.manifest.survey_id = "heridal-real-gps";
    real.manifest.simulated_path = false;
    real.survey.survey_id = "heridal-real-gps";
    real.survey.simulated_path = false;
    real.survey.area.name = "HERIDAL SB site (real EXIF positions)";
    vi.stubGlobal(
      "fetch",
      diskFetch({
        "/cache/real-gps/manifest.json": () => Response.json(real.manifest),
        "/cache/real-gps/survey.json": () => Response.json(real.survey),
        "/cache/real-gps/detections.json": () => Response.json(real.detections),
        "/cache/real-gps/map.json": () => Response.json(real.map),
        "/cache/real-gps/metrics.json": () => Response.json(real.metrics),
      }),
    );
    useSelection.getState().selectDetection("f0001-d01");
    render(<App dir="sample" />);
    await screen.findByRole("heading", { name: /Mount Seymour/ });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Survey" }), "real-gps");

    expect(await screen.findByText("HERIDAL SB site (real EXIF positions)")).toBeInTheDocument();
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
});
