import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { MissionRoute } from "./ingest/LiveMission";

// The console itself is tested in ingest.test.tsx; here, only which console the address opens.
vi.mock("./ingest/LiveMission", () => ({
  LiveMission: ({ missionId, route }: { missionId: string; route: MissionRoute }) => (
    <p data-testid="console">
      {missionId} {String(route.view)} {String(route.t)} {Object.keys(route.open).join(",")}
    </p>
  ),
  LiveCard: ({ sector }: { sector: string }) => <p data-testid="card">card {sector}</p>,
}));
vi.mock("./ingest/LkpPicker", () => ({ LkpPicker: () => <div /> }));

const open = (hash: string, base: string | null = null) => {
  window.history.replaceState(null, "", hash || "#");
  if (!hash) window.history.replaceState(null, "", window.location.pathname);
  return render(<App base={base} />);
};

describe("App: one console behind every address", () => {
  it("opens the home page at the site's root, and the demo mission's landing at #m/demo", () => {
    open("");
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The brain of a drone search.");
    expect(screen.queryByTestId("console")).toBeNull();
    document.body.innerHTML = "";
    open("#m/demo");
    expect(screen.getByTestId("console")).toHaveTextContent("demo null null");
  });

  it("opens a home card's scenario with the guided simulation on", () => {
    open("#m/demo?s=despondent&guide=1");
    expect(screen.getByTestId("console")).toHaveTextContent("demo null null guide");
  });

  it("puts About over the home page, and closing it goes home", async () => {
    open("");
    window.location.hash = "#about";
    const sheet = await screen.findByRole("dialog", { name: "About Sightline" });
    expect(screen.getByRole("region", { name: "Choose a search" })).toBeInTheDocument(); // the home page behind it
    await userEvent.click(within(sheet).getByRole("button", { name: /Close/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "About Sightline" })).toBeNull());
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("region", { name: "Choose a search" })).toBeInTheDocument();
  });

  it.each([
    ["#survey", "#m/demo?t=1", "demo null 1"],
    ["#review", "#m/demo?t=2", "demo null 2"],
    ["#searchnext", "#m/demo?t=3", "demo null 3"],
    ["#results", "#m/demo?t=6", "demo null 6"],
    ["#command", "#m/demo/map", "demo map null"],
    ["#judges", "#m/demo?t=6&judges", "demo null 6 judges"],
    ["#try", "#m/demo/photos?try", "demo photos null try"],
    ["#m/demo/command/conditions", "#m/demo/map/conditions", "demo map null conditions"],
  ])("sends the old address %s to %s", (from, to, shown) => {
    open(from);
    expect(window.location.hash).toBe(to);
    expect(screen.getByTestId("console")).toHaveTextContent(shown);
  });

  it("opens a live mission only with a mission server; without one, the empty console offers the demo", () => {
    open("#m/a1b2c3d4/review", "https://api.example.org");
    expect(window.location.hash).toBe("#m/a1b2c3d4/map?needs"); // the review folds into Needs you
    expect(screen.getByTestId("console")).toHaveTextContent("a1b2c3d4 map null needs");
    document.body.innerHTML = "";
    open("#m/a1b2c3d4/review", null);
    expect(screen.getByRole("link", { name: "Load the demo mission" })).toHaveAttribute("href", "#m/demo/map");
  });

  it("puts About over the console last on screen", async () => {
    open("#m/demo/trace");
    window.location.hash = "#about";
    expect(await screen.findByRole("dialog", { name: "About Sightline" })).toBeInTheDocument();
    expect(screen.getByTestId("console")).toHaveTextContent("demo trace");
  });

  it("opens a sector's printable card on a live mission", () => {
    open("#m/a1b2c3d4/card/B3", "https://api.example.org");
    expect(screen.getByTestId("card")).toHaveTextContent("card B3");
  });
});
