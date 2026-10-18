import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetModelAvailable, useModelAvailable } from "./useModelAvailable";

afterEach(() => {
  vi.unstubAllGlobals();
  resetModelAvailable();
});

describe("useModelAvailable", () => {
  it("is true when the model file answers the HEAD check", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "application/octet-stream" } })));
    const { result } = renderHook(() => useModelAvailable());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays false when the file is missing or the host answers with index.html", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    const { result } = renderHook(() => useModelAvailable());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBe(false);
  });
});
