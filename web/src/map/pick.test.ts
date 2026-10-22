// LANE_B §6 test 8 (B-M3): a pick resolves once, Esc cancels, one at a time; the page-level request.
import { describe, expect, it, vi } from "vitest";
import { startPick } from "./MapView";
import { usePick } from "./pick";

function fakeMap() {
  const canvas = document.createElement("canvas");
  canvas.style.cursor = "grab";
  let handler: ((e: { lngLat: { lat: number; lng: number } }) => void) | null = null;
  return {
    map: {
      getCanvas: () => canvas,
      once: (_: string, h: typeof handler) => {
        handler = h;
      },
      off: () => {
        handler = null;
      },
    } as never,
    canvas,
    click: (lat: number, lng: number) => handler?.({ lngLat: { lat, lng } }),
  };
}

describe("onPick", () => {
  it("resolves once on a click, with a crosshair until then", () => {
    const m = fakeMap();
    const cb = vi.fn();
    startPick(m.map, cb);
    expect(m.canvas.style.cursor).toBe("crosshair");
    m.click(49.37, -122.94);
    m.click(49.0, -122.0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ lat: 49.37, lon: -122.94 });
    expect(m.canvas.style.cursor).toBe("grab");
  });

  it("cancels on Esc, on the returned function, and when another pick starts", () => {
    const m = fakeMap();
    const [cb, cancelled] = [vi.fn(), vi.fn()];
    startPick(m.map, cb, cancelled);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    m.click(1, 2);
    expect(cb).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);

    const stop = startPick(m.map, cb, cancelled);
    stop();
    expect(cancelled).toHaveBeenCalledTimes(2);

    const first = vi.fn();
    startPick(m.map, vi.fn(), first);
    startPick(m.map, cb, cancelled);
    expect(first).toHaveBeenCalledTimes(1);
  });
});

describe("pick requests from the page", () => {
  it("resolves with the point the map gives, and an earlier request with null", async () => {
    const a = usePick.getState().request();
    const b = usePick.getState().request();
    await expect(a).resolves.toBeNull();
    usePick.getState().pending?.({ lat: 1, lon: 2 });
    await expect(b).resolves.toEqual({ lat: 1, lon: 2 });
    expect(usePick.getState().pending).toBeNull();
  });
});
