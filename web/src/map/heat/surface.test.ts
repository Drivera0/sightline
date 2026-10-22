import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map } from "maplibre-gl";
import { CELL, surfaceData } from "./classes";
import { HEAT_PALETTES, zoomOpacity } from "./palette";
import {
  ensureSurfaceLayers,
  pushSurface,
  setSurfaceMode,
  setSurfacePalette,
  SURFACE_LOAD_TIMEOUT_MS,
  surfaceIds,
  surfaceLayerIds,
} from "./surface";

const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 5, rows: 2, cols: 2 };
const theme = { veil: "#0a0b0d", held: "#f2f2f0" };
const ids = surfaceIds("t-", "t-cells");

function mockMap() {
  const layers: { id: string; layout: Record<string, unknown>; paint: Record<string, unknown> }[] = [];
  const sources = new globalThis.Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const handlers = new Set<(e: unknown) => void>();
  let loaded = false;
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addLayer: (l: { id: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> }) =>
      layers.push({ id: l.id, layout: { ...l.layout }, paint: { ...l.paint } }),
    getLayoutProperty: (id: string, p: string) => layers.find((l) => l.id === id)?.layout[p],
    setLayoutProperty: vi.fn((id: string, p: string, v: unknown) => {
      layers.find((l) => l.id === id)!.layout[p] = v;
    }),
    setPaintProperty: (id: string, p: string, v: unknown) => {
      layers.find((l) => l.id === id)!.paint[p] = v;
    },
    on: (_: string, fn: (e: unknown) => void) => handlers.add(fn),
    off: (_: string, fn: (e: unknown) => void) => handlers.delete(fn),
    isSourceLoaded: () => loaded,
  };
  const fire = (e: { sourceId: string; sourceDataType?: string }) => [...handlers].forEach((fn) => fn(e));
  const visible = (id: string) => layers.find((l) => l.id === id)?.layout.visibility === "visible";
  return { map: map as unknown as Map, raw: map, layers, sources, handlers, fire, visible, setLoaded: (v: boolean) => (loaded = v) };
}

const canvas = {} as HTMLCanvasElement;

afterEach(() => vi.useRealTimers());

describe("surface layers", () => {
  it("adds the raster, one fill per kind and the cased contours, all before the given layer", () => {
    const m = mockMap();
    const added = ensureSurfaceLayers(m.map, ids, canvas, grid, HEAT_PALETTES.satellite, theme, 1, "vector", "roads");
    expect(added).toBe(true);
    expect(m.layers.map((l) => l.id)).toEqual(surfaceLayerIds(ids));
    expect(m.visible(ids.raster)).toBe(false);
    expect(m.visible(ids.fills[CELL.top] as string)).toBe(true);
    // A second call (every styledata) adds nothing.
    expect(ensureSurfaceLayers(m.map, ids, canvas, grid, HEAT_PALETTES.satellite, theme, 1, "vector")).toBe(false);
    expect(m.layers).toHaveLength(surfaceLayerIds(ids).length);
  });

  it("recolours every fill and line for another basemap", () => {
    const m = mockMap();
    ensureSurfaceLayers(m.map, ids, canvas, grid, HEAT_PALETTES.satellite, theme, 1, "vector");
    setSurfacePalette(m.map, ids, HEAT_PALETTES.dark, theme, 0.75);
    const paint = (id: string) => m.layers.find((l) => l.id === id)!.paint;
    expect(paint(ids.fills[CELL.top] as string)["fill-color"]).toBe(HEAT_PALETTES.dark.top.color);
    expect(paint(ids.fills[CELL.low] as string)["fill-opacity"]).toEqual(zoomOpacity(HEAT_PALETTES.dark.low.alpha * 0.75));
    expect(paint(ids.line50)["line-color"]).toBe(HEAT_PALETTES.dark.contour50.color);
    expect(paint(ids.raster)["raster-opacity"]).toEqual(zoomOpacity(0.75));
  });
});

describe("raster and fills hand over", () => {
  it("shows the raster while animating and the fills at rest", () => {
    const m = mockMap();
    ensureSurfaceLayers(m.map, ids, canvas, grid, HEAT_PALETTES.dark, theme, 1, "vector");
    setSurfaceMode(m.map, ids, "raster");
    expect(m.visible(ids.raster)).toBe(true);
    expect(m.visible(ids.line50)).toBe(false);
    setSurfaceMode(m.map, ids, "vector");
    expect(m.visible(ids.raster)).toBe(false);
    expect(m.visible(ids.line50)).toBe(true);
    // Asking for the mode it is already in changes nothing.
    m.raw.setLayoutProperty.mockClear();
    setSurfaceMode(m.map, ids, "vector");
    expect(m.raw.setLayoutProperty).not.toHaveBeenCalled();
  });

  it("keeps the raster until new fills are drawn, so the old picture never flashes", () => {
    const m = mockMap();
    ensureSurfaceLayers(m.map, ids, canvas, grid, HEAT_PALETTES.dark, theme, 1, "raster");
    pushSurface(m.map, ids, surfaceData(grid, Uint8Array.from([1, 2, 3, 0])));
    expect(m.sources.get(ids.fillSource)!.setData).toHaveBeenCalledTimes(1);
    setSurfaceMode(m.map, ids, "vector");
    expect(m.visible(ids.raster)).toBe(true); // still loading
    m.fire({ sourceId: ids.fillSource, sourceDataType: "content" });
    m.setLoaded(true);
    m.fire({ sourceId: "other" });
    expect(m.visible(ids.raster)).toBe(true);
    m.fire({ sourceId: ids.fillSource });
    expect(m.visible(ids.raster)).toBe(false);
    expect(m.visible(ids.fills[CELL.top] as string)).toBe(true);
    expect(m.handlers.size).toBe(0);
  });

  it("hands over after a timeout if the load event never comes, and a newer push replaces a pending one", () => {
    vi.useFakeTimers();
    const m = mockMap();
    ensureSurfaceLayers(m.map, ids, canvas, grid, HEAT_PALETTES.dark, theme, 1, "raster");
    pushSurface(m.map, ids, surfaceData(grid, new Uint8Array(4)));
    setSurfaceMode(m.map, ids, "vector");
    vi.advanceTimersByTime(SURFACE_LOAD_TIMEOUT_MS - 10);
    pushSurface(m.map, ids, surfaceData(grid, new Uint8Array(4)));
    expect(m.handlers.size).toBe(1);
    vi.advanceTimersByTime(20);
    expect(m.visible(ids.raster)).toBe(true); // the first push's timer was cancelled
    vi.advanceTimersByTime(SURFACE_LOAD_TIMEOUT_MS);
    expect(m.visible(ids.raster)).toBe(false);
    expect(m.handlers.size).toBe(0);
  });

  it("does not hand over at load if an animation started meanwhile", () => {
    const m = mockMap();
    ensureSurfaceLayers(m.map, ids, canvas, grid, HEAT_PALETTES.dark, theme, 1, "vector");
    pushSurface(m.map, ids, surfaceData(grid, new Uint8Array(4)));
    setSurfaceMode(m.map, ids, "raster");
    m.fire({ sourceId: ids.fillSource, sourceDataType: "content" });
    m.setLoaded(true);
    m.fire({ sourceId: ids.fillSource });
    expect(m.visible(ids.raster)).toBe(true);
  });
});
