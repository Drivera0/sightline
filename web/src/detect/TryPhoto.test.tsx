import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
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
    render(<TryPhoto cache={cache} dir="sample" onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Try your own photo" })).toBeInTheDocument();
    expect(screen.getByText("Runs on your device")).toBeInTheDocument();
    expect(screen.getByText(/its boxes\s+are meaningless/)).toBeInTheDocument();
    expect(screen.getByText(/its boxes/).textContent).toContain(`threshold (${cache.metrics.detector.threshold}, metrics.detector)`);
    expect(await screen.findByText(/Drop a JPEG here/)).toBeInTheDocument();
  });

  it("explains when this build has no model file (a host answering with index.html counts as missing)", async () => {
    stubModel(true, "text/html");
    render(<TryPhoto cache={cache} dir="sample" onClose={() => {}} />);
    expect(await screen.findByText(/model is not included in this build/)).toBeInTheDocument();
  });

  it("closes on Esc and keeps the page's shortcuts from firing underneath", async () => {
    stubModel(false);
    const onClose = vi.fn();
    const pageKeys = vi.fn();
    window.addEventListener("keydown", pageKeys);
    render(<TryPhoto cache={cache} dir="sample" onClose={onClose} />);
    await userEvent.keyboard("3");
    expect(pageKeys).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    window.removeEventListener("keydown", pageKeys);
  });
});
