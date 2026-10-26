import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { routeFromHash } from "../shell/flow";
import { TryPhoto } from "./TryPhoto";

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
    // the survey's photos by plain names, never their file ids
    expect(screen.getByRole("button", { name: "Survey photo 1" })).toBeInTheDocument();
    expect(screen.queryByText(/\bf\d{4}\b/)).toBeNull();
  });

  it("explains when this build has no model file (a host answering with index.html counts as missing)", async () => {
    stubModel(true, "text/html");
    render(<TryPhoto cache={cache} dir="sample" />);
    expect(await screen.findByText(/model is not included in this build/)).toBeInTheDocument();
  });

  it("is an action in the Photos rail: ?try opens it there, and nothing traps the keyboard", async () => {
    stubModel(false);
    const pageKeys = vi.fn();
    window.addEventListener("keydown", pageKeys);
    render(<TryPhoto cache={cache} dir="sample" />);
    expect(routeFromHash("#m/demo/photos?try")).toEqual({ kind: "mission", id: "demo", view: "photos", t: null, open: { try: true } });
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("3");
    expect(pageKeys).toHaveBeenCalled(); // nothing swallows the keys
    window.removeEventListener("keydown", pageKeys);
  });
});
