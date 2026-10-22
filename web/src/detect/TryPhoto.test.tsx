import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { routeFromHash } from "../shell/flow";
import { TryPage, TryPhoto } from "./TryPhoto";

let cache: CacheBundle;
beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
});
afterEach(() => vi.unstubAllGlobals());

const stubModel = (ok: boolean, type = "application/octet-stream") =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(ok ? "" : "<html>", { status: ok ? 200 : 404, headers: { "content-type": type } })),
  );

describe("TryPhoto", () => {
  it("says it runs on the visitor's device, that non-aerial photos are meaningless, and uses the survey's threshold", async () => {
    stubModel(true);
    render(<TryPhoto cache={cache} dir="sample" />);
    expect(screen.getByRole("region", { name: "Try your own photo" })).toBeInTheDocument();
    expect(screen.getByText("Runs on your device")).toBeInTheDocument();
    expect(screen.getByText(/its boxes\s+are meaningless/)).toBeInTheDocument();
    expect(screen.getByText(/its boxes/).textContent).toContain(`a box counts from a score of ${cache.metrics.detector.threshold}`);
    expect(screen.getByText(/its boxes/).textContent).not.toContain("metrics.detector");
    expect(await screen.findByText(/Drop a JPEG here/)).toBeInTheDocument();
  });

  it("explains when this build has no model file (a host answering with index.html counts as missing)", async () => {
    stubModel(true, "text/html");
    render(<TryPhoto cache={cache} dir="sample" />);
    expect(await screen.findByText(/model is not included in this build/)).toBeInTheDocument();
  });

  it("is a page at #try with the app bar, not a dialog that traps the keyboard", async () => {
    stubModel(false);
    const pageKeys = vi.fn();
    window.addEventListener("keydown", pageKeys);
    render(<TryPage cache={cache} dir="sample" />);
    expect(routeFromHash("#try")).toEqual({ kind: "try" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Run Sightline's detector in your browser" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Sightline" })).getByRole("link", { name: "Guided demo" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Rank step/ })).toHaveAttribute("href", "#rank");
    await userEvent.keyboard("3");
    expect(pageKeys).toHaveBeenCalled(); // nothing swallows the keys
    window.removeEventListener("keydown", pageKeys);
  });
});
