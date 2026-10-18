import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle } from "../../contract";
import { CacheContext, loadCache } from "../../lib/cache";
import { diskFetch } from "../../lib/diskFetch";
import { useReview } from "../../review/store";
import { useSearch } from "../../search/store";
import type { MapContextValue } from "../MapView";
import { MAP_LAYER_IDS } from "../base/layerIds";
import { HeatLayer } from "./HeatLayer";
import { HEAT_LAYER_IDS, HEAT_SOURCE_ID } from "./layers";

const ctx: { value: MapContextValue | null } = { value: null };
vi.mock("../MapView", () => ({
  useMap: () => {
    if (!ctx.value) throw new Error("useMap must be used within MapProvider");
    return ctx.value;
  },
}));

interface Recorded {
  id: string;
  before: string | undefined;
}

// Just enough of a MapLibre map: sources, ordered layers, feature state and events.
function mockMap(withGridOutline: boolean) {
  const sources = new Map<string, unknown>();
  const layers: Recorded[] = withGridOutline ? [{ id: MAP_LAYER_IDS.gridOutline, before: undefined }] : [];
  const featureState = new Map<number, { o: number; u: number }>();
  const handlers = new Map<string, Set<() => void>>();
  const map = {
    isStyleLoaded: () => true,
    getSource: (id: string) => sources.get(id),
    addSource: vi.fn((id: string, spec: unknown) => {
      sources.set(id, spec);
    }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addLayer: vi.fn((layer: { id: string }, before?: string) => {
      const at = before ? layers.findIndex((l) => l.id === before) : -1;
      const entry = { id: layer.id, before };
      if (at >= 0) layers.splice(at, 0, entry);
      else layers.push(entry);
    }),
    setFeatureState: vi.fn((target: { source: string; id: number }, value: { o: number; u: number }) => {
      featureState.set(target.id, value);
    }),
    on: (event: string, fn: () => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    once: (event: string, fn: () => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off: (event: string, fn: () => void) => handlers.get(event)?.delete(fn),
    /** Pretend a basemap switch dropped every source and layer, then fire styledata. */
    reloadStyle: () => {
      sources.clear();
      layers.splice(0, layers.length);
      if (withGridOutline) layers.push({ id: MAP_LAYER_IDS.gridOutline, before: undefined });
      handlers.get("styledata")?.forEach((fn) => fn());
    },
  };
  return { map, sources, layers, featureState };
}

let cache: CacheBundle;

async function sampleWithSteps(): Promise<CacheBundle> {
  const c = await loadCache("sample", diskFetch());
  // Give the sample real steps over a few cells so the heat changes as we scrub.
  c.map = {
    ...c.map,
    steps: [
      { frame_id: "f0001", cells: [[1275, 0.8], [1276, 0.8]] },
      { frame_id: "f0002", cells: [[1277, 0.5]] },
    ],
  };
  return c;
}

describe("HeatLayer", () => {
  beforeEach(async () => {
    localStorage.clear();
    useReview.setState({ surveyId: null, history: [], answers: {} });
    useSearch.setState({ data: null, stepIndex: 0, stepCount: 0, state: null, found: false, foundDetectionId: null });
    cache = await sampleWithSteps();
  });

  it("renders nothing outside a map provider", () => {
    ctx.value = null;
    const { container } = render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("adds heat-cells before grid-outline and recolours via feature state only", () => {
    const m = mockMap(true);
    const flyTo = vi.fn();
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );

    const ids = m.layers.map((l) => l.id);
    expect(ids.indexOf(HEAT_LAYER_IDS.cells)).toBeLessThan(ids.indexOf(MAP_LAYER_IDS.gridOutline));
    expect(ids.indexOf(HEAT_LAYER_IDS.unsearched)).toBeLessThan(ids.indexOf(HEAT_LAYER_IDS.cells));
    expect(ids.indexOf(HEAT_LAYER_IDS.unsearched)).toBeLessThan(ids.indexOf(MAP_LAYER_IDS.gridOutline));
    expect(ids.indexOf(HEAT_LAYER_IDS.surveyed)).toBeLessThan(ids.indexOf(MAP_LAYER_IDS.gridOutline));
    expect(m.sources.get(HEAT_SOURCE_ID)).toMatchObject({ type: "geojson", promoteId: "idx" });
    const spec = m.sources.get(HEAT_SOURCE_ID) as { data: { features: unknown[] } };
    expect(spec.data.features).toHaveLength(2500);
    expect(m.featureState.size).toBe(2500);
    const addSourceCalls = m.map.addSource.mock.calls.length;

    // Final map: cell 1275 was photographed (heat, not flagged), cell 0 was not (no heat, flagged).
    expect(m.featureState.get(1275)).toMatchObject({ u: 0 });
    expect(m.featureState.get(1275)!.o).toBeGreaterThan(0);
    expect(m.featureState.get(0)).toEqual({ o: 0, u: 1 });
    expect(screen.getByText("After frame 2 of 2")).toBeInTheDocument();

    act(() => useSearch.getState().setStepIndex(0));
    expect(screen.getByText("Before the first frame")).toBeInTheDocument();
    expect(m.featureState.get(0)).toEqual({ o: 0, u: 1 });
    expect(m.map.addSource.mock.calls.length).toBe(addSourceCalls);

    // A confirmed person shows the banner; the slider keeps working.
    act(() => useReview.getState().answer("f0003-d01", "person", 1));
    expect(screen.getByText("Person confirmed: dispatch ground team")).toBeInTheDocument();
    act(() => useSearch.getState().setStepIndex(2));
    expect(screen.getByText("After frame 2 of 2")).toBeInTheDocument();

    // Clicking a "search next" cell flies there.
    act(() => screen.getAllByRole("button").find((b) => b.hasAttribute("data-idx"))!.click());
    expect(flyTo).toHaveBeenCalledTimes(1);

    // A basemap switch drops the layers; they come back with their colours.
    act(() => m.map.reloadStyle());
    expect(m.layers.map((l) => l.id)).toContain(HEAT_LAYER_IDS.cells);
    expect(m.map.setFeatureState.mock.calls.length).toBeGreaterThanOrEqual(2500 * 2);
  });

  it("adds the layers on top when lane B has not drawn yet", () => {
    const m = mockMap(false);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    expect(m.layers.find((l) => l.id === HEAT_LAYER_IDS.cells)?.before).toBeUndefined();
  });

  it("passes map.params.prior_source to the legend", () => {
    ctx.value = { map: mockMap(true).map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    // The sample says "placeholder" in both prior_source and the notes.
    const { unmount } = render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    expect(screen.getByText("Placeholder prior")).toBeInTheDocument();
    unmount();

    // A cited prior wins over notes that still mention a placeholder.
    const cited = { ...cache, map: { ...cache.map, params: { ...cache.map.params, prior_source: "test citation" } } };
    render(
      <CacheContext.Provider value={cited}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    expect(screen.queryByText("Placeholder prior")).not.toBeInTheDocument();
  });
  it("shows the found banner inside the side panel, not over the map", () => {
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    act(() => useReview.getState().answer("f0003-d01", "person", 1));
    const banner = screen.getByText("Person confirmed: dispatch ground team");
    const sidePanel = screen.getByText("Search next in the surveyed area").closest(".w-72");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel!.contains(banner)).toBe(true);
  });
});
