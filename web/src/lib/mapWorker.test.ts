import { beforeEach, describe, expect, it, vi } from "vitest";

const setWorkerUrl = vi.fn();
vi.mock("maplibre-gl", () => ({ setWorkerUrl }));

describe("configureMapWorker", () => {
  beforeEach(() => {
    setWorkerUrl.mockClear();
    vi.resetModules();
  });

  it("points MapLibre at a bundled worker script", async () => {
    const { configureMapWorker } = await import("./mapWorker");

    configureMapWorker();

    expect(setWorkerUrl).toHaveBeenCalledTimes(1);
    expect(typeof setWorkerUrl.mock.calls[0]?.[0]).toBe("string");
    expect(setWorkerUrl.mock.calls[0]?.[0]).toMatch(/worker/i);
  });

  it("does it only once, however often it is called", async () => {
    const { configureMapWorker } = await import("./mapWorker");

    configureMapWorker();
    configureMapWorker();

    expect(setWorkerUrl).toHaveBeenCalledTimes(1);
  });
});
