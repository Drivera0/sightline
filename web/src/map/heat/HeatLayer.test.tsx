import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheBundle, Frame } from "../../contract";
import { CacheContext, loadCache } from "../../lib/cache";
import { diskFetch } from "../../lib/diskFetch";
import { useReview } from "../../review/store";
import { useSearch } from "../../search/store";
import type { MapContextValue } from "../MapView";
import { MAP_LAYER_IDS } from "../base/layerIds";
import { HeatLayer } from "./HeatLayer";
import {
  HEAT_CANDIDATE_SOURCE_ID,
  HEAT_DRONE_SOURCE_ID,
  HEAT_HELD_SOURCE_ID,
  HEAT_LAYER_IDS,
  HEAT_SECTOR_LABEL_SOURCE_ID,
  HEAT_SOURCE_ID,
  HEAT_SURVEYED_SOURCE_ID,
  HEAT_TRAIL_SOURCE_ID,
  HEAT_UNSURE_SOURCE_ID,
} from "./layers";
import { PanelSlotContext } from "./panelSlot";
import { HEAT_ALPHA_MAX, HELD_ALPHA, rasterForCanvas, VEIL_ALPHA } from "./raster";

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

// Just enough of a MapLibre map: sources, ordered layers, a canvas source, paint and events.
function mockMap(withGridOutline: boolean) {
  const sources = new Map<string, unknown>();
  const layers: Recorded[] = withGridOutline ? [{ id: MAP_LAYER_IDS.gridOutline, before: undefined }] : [];
  const boundaryDrawn: unknown[] = [];
  const heldDrawn: unknown[] = [];
  const replayDrawn = new Map<string, unknown>();
  const handlers = new Map<string, Set<() => void>>();
  const uploads = { count: 0 };
  const map = {
    isStyleLoaded: () => true,
    getSource: (id: string) => {
      const spec = sources.get(id);
      if (!spec) return undefined;
      const setData = (data: unknown) => {
        if (id === HEAT_SURVEYED_SOURCE_ID) boundaryDrawn.push(data);
        else if (id === HEAT_HELD_SOURCE_ID) heldDrawn.push(data);
        else replayDrawn.set(id, data);
      };
      const canvas = id === HEAT_SOURCE_ID ? { play: () => {}, pause: () => (uploads.count += 1) } : {};
      return { ...(spec as object), setData, ...canvas };
    },
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
    setPaintProperty: vi.fn(),
    setLayoutProperty: vi.fn(),
    hasImage: () => false,
    addImage: vi.fn(),
    fitBounds: vi.fn(),
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
  /** What the raster shows for one cell: "veil" (not yet searched), "held", or "heat". */
  const kind = (idx: number): "veil" | "held" | "heat" => {
    const spec = sources.get(HEAT_SOURCE_ID) as { canvas: HTMLCanvasElement };
    const px = rasterForCanvas(spec.canvas)!.shown;
    const a = px[idx * 4 + 3] as number;
    if (a === Math.round(VEIL_ALPHA * 255) && (px[idx * 4] as number) < 40) return "veil";
    if (a === Math.round(HELD_ALPHA * 255)) return "held";
    return "heat";
  };
  /** Heat alpha of a cell (higher = more likely). */
  const alpha = (idx: number): number => {
    const spec = sources.get(HEAT_SOURCE_ID) as { canvas: HTMLCanvasElement };
    return rasterForCanvas(spec.canvas)!.shown[idx * 4 + 3] as number;
  };
  return { map, sources, layers, boundaryDrawn, heldDrawn, replayDrawn, kind, alpha, uploads };
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
  // Footprints that match the steps: frame 1 covers cells 1275 and 1276, frame 2 covers cell 1277
  // (row 25, columns 25 to 27; each footprint is 1 m inside its cells).
  const g = c.map.grid;
  const mLon = 111_320 * Math.cos((g.origin_nw.lat * Math.PI) / 180);
  const lat = (m: number) => g.origin_nw.lat - (25 * 20 + m) / 111_320;
  const lon = (col: number, m: number) => g.origin_nw.lon + (col * 20 + m) / mLon;
  const box = (c0: number, c1: number): Frame["footprint"] => [
    [lon(c0, 1), lat(1)],
    [lon(c1, 19), lat(1)],
    [lon(c1, 19), lat(19)],
    [lon(c0, 1), lat(19)],
  ];
  c.survey = {
    ...c.survey,
    frames: [
      { ...(c.survey.frames[0] as Frame), footprint: box(25, 26) },
      { ...(c.survey.frames[1] as Frame), footprint: box(27, 27) },
    ],
  };
  // One candidate at the centre of cell 1275, to be held until answered.
  const candidate = { id: "f0001-d01", box_px: [0, 0, 10, 10] as [number, number, number, number], conf: 0.9, crop: "crops/f0001-d01.jpg", lat: lat(10), lon: lon(25, 10), radius_m: 1 };
  c.detections = { ...c.detections, frames: { f0001: [candidate] } };
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

  it("adds the heat raster before grid-outline and recolours the canvas, never the geometry", () => {
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
    expect(ids.indexOf(HEAT_LAYER_IDS.surveyed)).toBeLessThan(ids.indexOf(MAP_LAYER_IDS.gridOutline));
    expect(ids.indexOf(HEAT_LAYER_IDS.sectorLabel)).toBeLessThan(ids.indexOf(MAP_LAYER_IDS.gridOutline));
    expect(m.sources.get(HEAT_SOURCE_ID)).toMatchObject({ type: "canvas", animate: false });
    const addSourceCalls = m.map.addSource.mock.calls.length;

    // Final map: cell 1276 was photographed (heat), cell 0 was not (veil).
    expect(m.kind(1276)).toBe("heat");
    expect(m.kind(0)).toBe("veil");
    expect(screen.getByText("After frame 2 of 2")).toBeInTheDocument();
    // The candidate at cell 1275 is awaiting review: its own look, no heat, and a dashed outline.
    expect(m.kind(1275)).toBe("held");
    expect(m.kind(1277)).toBe("heat");
    const held = m.heldDrawn.at(-1) as { geometry: { coordinates: unknown[] } };
    expect(held.geometry.coordinates).toHaveLength(4);

    // Only what the first frame photographed is photographed at step 1.
    act(() => useSearch.getState().setStepIndex(1));
    expect(m.kind(1276)).toBe("heat");
    expect(m.kind(1277)).toBe("veil");
    expect(m.boundaryDrawn.length).toBeGreaterThan(0);

    const uploadsBefore = m.uploads.count;
    act(() => useSearch.getState().setStepIndex(0));
    expect(screen.getByText("Before the first frame")).toBeInTheDocument();
    expect(m.kind(1275)).toBe("veil");
    expect(m.kind(0)).toBe("veil");
    expect(m.uploads.count).toBeGreaterThan(uploadsBefore);
    expect(m.map.addSource.mock.calls.length).toBe(addSourceCalls);

    // A confirmed person shows the banner; the slider keeps working.
    act(() => useReview.getState().answer("f0001-d01", "person", 1));
    // ...but only once the replay has flown its photo (frame f0001 is step 1).
    expect(screen.queryByText("Person sighted: send ground team to check")).not.toBeInTheDocument();
    act(() => useSearch.getState().setStepIndex(1));
    expect(screen.getByText("Person sighted: send ground team to check")).toBeInTheDocument();
    // Answering "Not a person" releases the held cell into the normal map and clears its outline.
    act(() => useSearch.getState().setStepIndex(2));
    act(() => useReview.getState().answer("f0001-d01", "not_person", 2));
    expect(m.kind(1275)).toBe("heat");
    expect((m.heldDrawn.at(-1) as { geometry: { coordinates: unknown[] } }).geometry.coordinates).toHaveLength(0);
    expect(screen.getByText("After frame 2 of 2")).toBeInTheDocument();

    // Clicking a "search next" cell flies there.
    act(() => screen.getAllByRole("button").find((b) => b.hasAttribute("data-idx"))!.click());
    expect(flyTo).toHaveBeenCalledTimes(1);

    // A basemap switch drops the layers; they come back.
    act(() => m.map.reloadStyle());
    expect(m.layers.map((l) => l.id)).toContain(HEAT_LAYER_IDS.cells);
    expect(m.sources.get(HEAT_SOURCE_ID)).toMatchObject({ type: "canvas" });
  });

  it("draws a sliver cell (overlap below MIN_OVERLAP) as not yet searched, with no heat and no outline", () => {
    // A third frame that only grazes cell 1325 (row 26, col 25): 4 m of its 20 m width, so overlap 0.2.
    const g = cache.map.grid;
    const mLon = 111_320 * Math.cos((g.origin_nw.lat * Math.PI) / 180);
    const lat = (m: number) => g.origin_nw.lat - (26 * 20 + m) / 111_320;
    const lon = (m: number) => g.origin_nw.lon + (25 * 20 + m) / mLon;
    const sliver: Frame["footprint"] = [[lon(0), lat(0)], [lon(4), lat(0)], [lon(4), lat(20)], [lon(0), lat(20)]];
    const sliverCache: CacheBundle = {
      ...cache,
      map: { ...cache.map, steps: [...cache.map.steps, { frame_id: "f0003", cells: [[1325, 0.01]] }] },
      survey: {
        ...cache.survey,
        frames: [
          ...cache.survey.frames,
          { ...(cache.survey.frames[0] as Frame), id: "f0003", flight_index: 2, footprint: sliver },
        ],
      },
    };
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={sliverCache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    act(() => useReview.getState().answer("f0001-d01", "not_person", 1));
    act(() => useSearch.getState().setStepIndex(3));
    // The sliver cell has almost the top p (barely searched) but is not searched: veil, no heat.
    const p = useSearch.getState().state!.p;
    expect(p[1325]).toBeGreaterThan(p[1276] as number);
    expect(m.kind(1325)).toBe("veil");
    // Well-photographed cells keep their heat.
    expect(m.kind(1276)).toBe("heat");
    // The outline does not include the sliver cell: it is the same drawing as at step 2.
    const drawn = m.boundaryDrawn.at(-1) as { geometry: { coordinates: unknown[] } };
    act(() => useSearch.getState().setStepIndex(2));
    const atTwo = m.boundaryDrawn.at(-1) as { geometry: { coordinates: unknown[] } };
    expect(drawn.geometry.coordinates).toEqual(atTwo.geometry.coordinates);
    // At step 0 nothing is coloured.
    act(() => useSearch.getState().setStepIndex(0));
    for (const i of [1275, 1276, 1277, 1325]) expect(m.kind(i)).toBe("veil");
  });

  it("moves the drone icon and its trail with the slider, pointing along the flight, above the heat", () => {
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    const pose = (i: number) => {
      const f = cache.survey.frames[i] as Frame;
      return [f.pose.lon, f.pose.lat];
    };
    // Reduced motion (jsdom): the drone sits exactly on the frame, no glide.
    expect(m.replayDrawn.get(HEAT_DRONE_SOURCE_ID)).toMatchObject({ geometry: { type: "Point", coordinates: pose(1) } });
    expect(m.replayDrawn.get(HEAT_TRAIL_SOURCE_ID)).toMatchObject({ geometry: { coordinates: [pose(0), pose(1)] } });
    const bearing = (m.replayDrawn.get(HEAT_DRONE_SOURCE_ID) as { properties: { bearing: number } }).properties.bearing;
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(360);
    act(() => useSearch.getState().setStepIndex(1));
    expect(m.replayDrawn.get(HEAT_DRONE_SOURCE_ID)).toMatchObject({ geometry: { coordinates: pose(0) } });
    act(() => useSearch.getState().setStepIndex(0));
    expect(m.replayDrawn.get(HEAT_DRONE_SOURCE_ID)).toEqual({ type: "FeatureCollection", features: [] });

    const ids = m.layers.map((l) => l.id);
    // The trail and drone are added on top; the heat layers stay below lane B's grid outline.
    expect(ids.indexOf(HEAT_LAYER_IDS.drone)).toBeGreaterThan(ids.indexOf(MAP_LAYER_IDS.gridOutline));
    expect(ids.indexOf(HEAT_LAYER_IDS.reviewOutline)).toBeGreaterThan(ids.indexOf(HEAT_LAYER_IDS.cells));
    expect(ids.indexOf(HEAT_LAYER_IDS.reviewOutline)).toBeLessThan(ids.indexOf(MAP_LAYER_IDS.gridOutline));
  });

  it("labels the sectors on the map and lists them by remaining probability", () => {
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    // Two frames are not east-west flight lines, so the 4 x 4 map-reference lattice is used.
    const labels = m.replayDrawn.get(HEAT_SECTOR_LABEL_SOURCE_ID) as { features: { properties: { text: string } }[] };
    expect(labels.features).toHaveLength(16);
    expect(labels.features[0]!.properties.text.startsWith("SECTOR A1")).toBe(true);
    const list = screen.getByRole("list", { name: "Sectors by remaining probability" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(16);
    act(() => rows[0]!.click());
    expect(m.map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("review variant: live heat under the pins with a readout, no replay, no side panel", () => {
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer variant="review" />
      </CacheContext.Provider>,
    );
    const ids = m.layers.map((l) => l.id);
    expect(ids).toContain(HEAT_LAYER_IDS.cells);
    expect(ids).not.toContain(HEAT_LAYER_IDS.drone);
    expect(screen.queryByText("Flight replay")).not.toBeInTheDocument();
    expect(screen.queryByText("Search next in the surveyed area")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-readout").textContent).not.toContain("→");
    // The map's one simulated line sits in the review card (the card covers the map's corner).
    expect(screen.getByTestId("simulated-line")).toHaveTextContent(/flight path/);
    expect(m.kind(1275)).toBe("held");
    act(() => useReview.getState().answer("f0001-d01", "not_person", 1));
    // The same store drives it: the held cell is released and the readout shows before → now.
    expect(m.kind(1275)).toBe("heat");
    expect(screen.getByTestId("review-readout").textContent).toContain("→");
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

  it("draws a flown 'Person' answer as a candidate sighting: darkest, ringed, with its reading", () => {
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    act(() => useSearch.getState().setStepIndex(2));
    expect(m.kind(1275)).toBe("held");
    act(() => useReview.getState().answer("f0001-d01", "person", 1));
    // Not "awaiting review" any more: the darkest class, ringed in the Person colour.
    expect(m.alpha(1275)).toBe(Math.round(HEAT_ALPHA_MAX * 255));
    const ring = m.replayDrawn.get(HEAT_CANDIDATE_SOURCE_ID) as { geometry: { coordinates: unknown[] } };
    expect(ring.geometry.coordinates.length).toBeGreaterThan(0);
    expect(screen.getByText(/if this is the missing person, the search ends here \(100%\)/)).toBeInTheDocument();
    expect(screen.getByText("Candidate sighting")).toBeInTheDocument();
    expect(useSearch.getState().sightings).toHaveLength(1);
    // Undo restores everything.
    act(() => useReview.getState().undo());
    expect(m.kind(1275)).toBe("held");
    expect(useSearch.getState().sightings).toHaveLength(0);
    expect(screen.queryByText("Candidate sighting")).toBeNull();
  });

  it("rings a flown 'Unsure' area in amber, lists it under the sectors, and keeps the map unchanged", () => {
    const m = mockMap(true);
    const flyTo = vi.fn();
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    const coords = (id: string) => (m.replayDrawn.get(id) as { geometry: { coordinates: unknown[] } }).geometry.coordinates;
    const heldCoords = () => (m.heldDrawn.at(-1) as { geometry: { coordinates: unknown[] } }).geometry.coordinates;
    expect(m.layers.map((l) => l.id)).toContain(HEAT_LAYER_IDS.unsureOutline);
    const before = Array.from(useSearch.getState().state!.p);
    expect(heldCoords()).toHaveLength(4);
    act(() => useReview.getState().answer("f0001-d01", "unsure", 1));
    // Still held (same raster look, same numbers), but ringed in amber instead of the dashed outline.
    expect(m.kind(1275)).toBe("held");
    expect(Array.from(useSearch.getState().state!.p)).toEqual(before);
    expect(coords(HEAT_UNSURE_SOURCE_ID)).toHaveLength(4);
    expect(heldCoords()).toHaveLength(0);
    expect(screen.getByTestId("unsure-line").textContent).toBe("Unsure · check again: 1 area the reviewer couldn't call");
    // In the legend and as a tag on the sector row holding it.
    expect(screen.getAllByText("Unsure · check again")).toHaveLength(2);
    // Clicking the entry flies to the unsure detection.
    act(() => screen.getAllByRole("button").find((b) => b.hasAttribute("data-unsure"))!.click());
    expect(flyTo).toHaveBeenCalledTimes(1);
    // Replay: before its photo (frame f0001, step 1) is flown there is no ring and no entry.
    act(() => useSearch.getState().setStepIndex(0));
    expect(coords(HEAT_UNSURE_SOURCE_ID)).toHaveLength(0);
    expect(screen.queryByTestId("unsure-line")).toBeNull();
    act(() => useSearch.getState().setStepIndex(1));
    expect(coords(HEAT_UNSURE_SOURCE_ID)).toHaveLength(4);
    // Changing the answer to "Person" swaps the amber ring for the candidate ring; undo brings it back.
    act(() => useReview.getState().answer("f0001-d01", "person", 2));
    expect(coords(HEAT_UNSURE_SOURCE_ID)).toHaveLength(0);
    expect(coords(HEAT_CANDIDATE_SOURCE_ID).length).toBeGreaterThan(0);
    act(() => useReview.getState().undo());
    expect(coords(HEAT_UNSURE_SOURCE_ID)).toHaveLength(4);
    // Undo the "Unsure" too: back to the dashed awaiting-review outline only.
    act(() => useReview.getState().undo());
    expect(coords(HEAT_UNSURE_SOURCE_ID)).toHaveLength(0);
    expect(screen.queryByTestId("unsure-line")).toBeNull();
  });

  it("review variant: says how many unsure areas are kept, only when there are some", () => {
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer variant="review" />
      </CacheContext.Provider>,
    );
    expect(screen.queryByTestId("review-unsure")).toBeNull();
    const readout = screen.getByTestId("review-readout").textContent;
    act(() => useReview.getState().answer("f0001-d01", "unsure", 1));
    expect(screen.getByTestId("review-unsure").textContent).toBe("1 unsure area kept at its value before the photo");
    expect(screen.getByTestId("review-readout").textContent).toBe(readout);
    expect(screen.getByText("Unsure · check again")).toBeInTheDocument();
    expect((m.replayDrawn.get(HEAT_UNSURE_SOURCE_ID) as { geometry: { coordinates: unknown[] } }).geometry.coordinates).toHaveLength(4);
    act(() => useReview.getState().undo());
    expect(screen.queryByTestId("review-unsure")).toBeNull();
  });

  it("shows the found banner inside the side panel, not over the map", () => {
    const m = mockMap(true);
    ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
    render(
      <CacheContext.Provider value={cache}>
        <HeatLayer />
      </CacheContext.Provider>,
    );
    act(() => useReview.getState().answer("f0001-d01", "person", 1));
    const banner = screen.getByText("Person sighted: send ground team to check");
    const sidePanel = screen.getByText("Search next in the surveyed area").closest(".w-80");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel!.contains(banner)).toBe(true);
  });

  it("narrow screens: puts the panels below the map, in the shell's slot, behind a segmented control", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const m = mockMap(true);
      ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
      const slot = document.createElement("div");
      document.body.appendChild(slot);
      const { container } = render(
        <CacheContext.Provider value={cache}>
          <PanelSlotContext.Provider value={slot}>
            <HeatLayer />
          </PanelSlotContext.Provider>
        </CacheContext.Provider>,
      );
      // Nothing floats over the map; the replay, tabs and legend are in the slot.
      expect(container.querySelector(".w-80")).toBeNull();
      expect(within(slot).getByText("Flight replay")).toBeInTheDocument();
      expect(within(slot).getByText("Lower probability")).toBeInTheDocument();
      const tabs = within(slot).getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["Legend", "Sectors", "Search next"]);
      act(() => tabs[1]!.click());
      expect(within(slot).getByRole("list", { name: "Sectors by remaining probability" })).toBeInTheDocument();
      expect(tabs[1]).toHaveAttribute("aria-selected", "true");
      slot.remove();
    } finally {
      window.matchMedia = original;
    }
  });

  /** matchMedia with fixed answers per query and a reduced-motion flag that can flip live. */
  function fakeMedia(answers: { wide: boolean; roomy: boolean; reduced: boolean }) {
    const listeners = new Set<() => void>();
    const state = { ...answers };
    const matches = (q: string) =>
      q.includes("reduced-motion") ? state.reduced : q.includes("1280") ? state.roomy : q.includes("1024") ? state.wide : false;
    const media = ((query: string) => ({
      get matches() {
        return matches(query);
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia;
    const setReduced = (v: boolean) => {
      state.reduced = v;
      listeners.forEach((fn) => fn());
    };
    return { media, setReduced };
  }

  it("shows the Skip pill only while the map builds up, and never under reduced motion", () => {
    const original = window.matchMedia;
    const fake = fakeMedia({ wide: true, roomy: true, reduced: false });
    window.matchMedia = fake.media;
    try {
      const m = mockMap(true);
      ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
      render(
        <CacheContext.Provider value={cache}>
          <HeatLayer />
        </CacheContext.Provider>,
      );
      expect(screen.getByRole("button", { name: /Building the map/ })).toBeInTheDocument();
      // Reduced motion switched on mid build-up: the (invisible-by-CSS) pill must not stay focusable.
      act(() => fake.setReduced(true));
      expect(screen.queryByRole("button", { name: /Building the map/ })).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it("folds the legend into a pill below 1280 px and opens it on click", () => {
    const original = window.matchMedia;
    window.matchMedia = fakeMedia({ wide: true, roomy: false, reduced: true }).media;
    try {
      const m = mockMap(true);
      ctx.value = { map: m.map as unknown as MapContextValue["map"], flyTo: vi.fn() };
      render(
        <CacheContext.Provider value={cache}>
          <HeatLayer />
        </CacheContext.Provider>,
      );
      expect(screen.queryByText("Lower probability")).toBeNull();
      const pill = screen.getByRole("button", { name: "Reading the map" });
      expect(pill).toHaveAttribute("aria-expanded", "false");
      expect(pill).toHaveAttribute("data-map-overlay", "corner");
      act(() => pill.click());
      expect(screen.getByText("Lower probability")).toBeInTheDocument();
      act(() => screen.getByRole("button", { name: "Hide" }).click());
      expect(screen.queryByText("Lower probability")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});
