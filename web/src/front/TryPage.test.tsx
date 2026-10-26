import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { diskFetch } from "../lib/diskFetch";
import { BANNED } from "../command/terms";
import { NEXT_STEPS } from "./TryPage";

/** The demo cache in tests: the repository's sample cache stands in for it; the model file is not there. */
const fetchStub = () => {
  const disk = diskFetch();
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/cache/demo/")) return disk(url.replace("/cache/demo/", "/cache/sample/"));
    return new Response("", { status: 404 });
  };
};

describe("Try your own photo (#try)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a page of its own: the upload first, then what a search does with a box, and no console", async () => {
    vi.stubGlobal("fetch", fetchStub());
    window.history.replaceState(null, "", "#try");
    render(<App base={null} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Try it on your own photo" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Try your own photo" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#try");
    expect(screen.queryByLabelText("Command view")).toBeNull();
    for (const s of NEXT_STEPS) expect(screen.getByText(s.title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See it in the guided simulation" })).toHaveAttribute("href", "#m/demo?guide=1");
    expect(screen.getByRole("link", { name: "Set up your own search" })).toHaveAttribute("href", "#play");
    const text = document.body.textContent ?? "";
    for (const re of BANNED) expect(text).not.toMatch(re);
  });
});
