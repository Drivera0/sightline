// MapLibre sources and layers for the heat map. Kept free of React so tests can use a mocked map.
import type { ExpressionSpecification, GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { HEAT_LAYER_PREFIX, MAP_LAYER_IDS } from "../base/layerIds";
import { buildCellFeatures, cellCenter, HEAT_CEIL, HEAT_FLOOR, relativeHeatOpacities, surveyedBoundary } from "./geometry";
import type { MapState } from "../../search/update";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type LonLat = [number, number];

export const HEAT_SOURCE_ID = `${HEAT_LAYER_PREFIX}cells`;
export const HEAT_SURVEYED_SOURCE_ID = `${HEAT_LAYER_PREFIX}surveyed`;
export const HEAT_TRAIL_SOURCE_ID = `${HEAT_LAYER_PREFIX}trail`;
export const HEAT_DRONE_SOURCE_ID = `${HEAT_LAYER_PREFIX}drone`;
export const HEAT_HOTSPOT_SOURCE_ID = `${HEAT_LAYER_PREFIX}hotspots`;
export const HEAT_LAYER_IDS = {
  unsearched: `${HEAT_LAYER_PREFIX}unsearched`,
  review: `${HEAT_LAYER_PREFIX}review`,
  reviewOutline: `${HEAT_LAYER_PREFIX}review-outline`,
  hotspots: `${HEAT_LAYER_PREFIX}hotspots`,
  cells: `${HEAT_LAYER_PREFIX}cells`,
  surveyed: `${HEAT_LAYER_PREFIX}surveyed`,
  trail: `${HEAT_LAYER_PREFIX}trail`,
  droneHalo: `${HEAT_LAYER_PREFIX}drone-halo`,
  drone: `${HEAT_LAYER_PREFIX}drone`,
} as const;

/** How strongly the "not yet searched" veil darkens the basemap (cells not photographed at this step). */
export const UNSEEN_OPACITY = 0.62;

export interface HeatColors {
  accent: string;
  /** Low end of the heat ramp: warm, so a faint cell still reads as "some chance". */
  warm: string;
  outline: string;
  /** The veil over ground not yet photographed at this step (the app background). */
  veil: string;
  /** Tone for cells awaiting review (the shell's "Unsure" token). */
  review: string;
}

/** Opacity of the "awaiting review" fill. Strong enough to read next to the heat, low enough to see the basemap. */
export const REVIEW_OPACITY = 0.5;
/**
 * The heat ramp also starts at --warn, so a held cell gets a dashed --warn outline as well:
 * a faint warm heat cell has no outline, a held cell always has one.
 */
export const REVIEW_OUTLINE_DASH = [2, 1.5];

/** MapLibre cannot read CSS variables, so read the tokens at runtime. */
export function readHeatColors(root: Element = document.documentElement): HeatColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    warm: styles.getPropertyValue("--warn").trim(),
    outline: styles.getPropertyValue("--text").trim(),
    veil: styles.getPropertyValue("--bg").trim(),
    review: styles.getPropertyValue("--warn").trim(),
  };
}

/** Heat layers sit below every lane B layer: before grid-outline, or on top if B has not drawn yet. */
function beforeId(map: Map): string | undefined {
  return map.getLayer(MAP_LAYER_IDS.gridOutline) ? MAP_LAYER_IDS.gridOutline : undefined;
}

const EMPTY: GeoJsonData = { type: "FeatureCollection", features: [] };

/**
 * Add the heat sources and layers if they are missing (first render, or after a style reload
 * dropped them). Returns true when the cell source was (re)added, so feature state must be
 * pushed again. Never rebuilds an existing source.
 */
export function ensureHeatLayers(
  map: Map,
  cells: GeoJsonData,
  grid: Grid,
  covered: Uint8Array,
  colors: HeatColors,
): boolean {
  let added = false;
  if (!map.getSource(HEAT_SOURCE_ID)) {
    map.addSource(HEAT_SOURCE_ID, { type: "geojson", data: cells, promoteId: "idx" });
    added = true;
  }
  if (!map.getSource(HEAT_SURVEYED_SOURCE_ID)) {
    map.addSource(HEAT_SURVEYED_SOURCE_ID, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: { type: "MultiLineString", coordinates: surveyedBoundary(grid, covered) },
      },
    });
  }
  if (!map.getSource(HEAT_TRAIL_SOURCE_ID)) map.addSource(HEAT_TRAIL_SOURCE_ID, { type: "geojson", data: EMPTY });
  if (!map.getSource(HEAT_DRONE_SOURCE_ID)) map.addSource(HEAT_DRONE_SOURCE_ID, { type: "geojson", data: EMPTY });

  // Below heat-cells: a dark veil over cells not photographed at this step ("u" feature state = 1).
  if (!map.getLayer(HEAT_LAYER_IDS.unsearched)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.unsearched,
        type: "fill",
        source: HEAT_SOURCE_ID,
        paint: {
          "fill-color": colors.veil,
          "fill-opacity": ["case", ["==", ["coalesce", ["feature-state", "u"], 0], 1], UNSEEN_OPACITY, 0],
          "fill-antialias": false,
        },
      },
      beforeId(map),
    );
  }
  // Between unsearched and cells: photographed cells held for review ("h" feature state = 1).
  if (!map.getLayer(HEAT_LAYER_IDS.review)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.review,
        type: "fill",
        source: HEAT_SOURCE_ID,
        paint: {
          "fill-color": colors.review,
          "fill-opacity": ["case", ["==", ["coalesce", ["feature-state", "h"], 0], 1], REVIEW_OPACITY, 0],
          "fill-antialias": false,
        },
      },
      beforeId(map),
    );
  }
  if (!map.getLayer(HEAT_LAYER_IDS.cells)) {
    const o = ["coalesce", ["feature-state", "o"], 0];
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.cells,
        type: "fill",
        source: HEAT_SOURCE_ID,
        paint: {
          // Warm at the floor of the stretch, the accent at its ceiling.
          "fill-color": ["interpolate", ["linear"], o, HEAT_FLOOR, colors.warm, HEAT_CEIL, colors.accent],
          // Softer than the raw share so the basemap still reads through the hottest cells.
          "fill-opacity": ["*", o, HEAT_BASE_OPACITY],
          "fill-antialias": false,
        },
      } as unknown as Parameters<Map["addLayer"]>[0],
      beforeId(map),
    );
  }
  // Above heat-cells: the dashed outline that tells a held cell from a faint warm heat cell.
  if (!map.getLayer(HEAT_LAYER_IDS.reviewOutline)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.reviewOutline,
        type: "line",
        source: HEAT_SOURCE_ID,
        paint: {
          "line-color": colors.review,
          "line-opacity": ["case", ["==", ["coalesce", ["feature-state", "h"], 0], 1], 0.9, 0],
          "line-width": 1.5,
          "line-dasharray": REVIEW_OUTLINE_DASH,
        },
      },
      beforeId(map),
    );
  }
  if (!map.getLayer(HEAT_LAYER_IDS.surveyed)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.surveyed,
        type: "line",
        source: HEAT_SURVEYED_SOURCE_ID,
        paint: { "line-color": colors.outline, "line-opacity": 0.55, "line-width": 1 },
      },
      beforeId(map),
    );
  }
  // The Search next cells: a ring that breathes with the heat (see setBreath).
  if (!map.getSource(HEAT_HOTSPOT_SOURCE_ID)) map.addSource(HEAT_HOTSPOT_SOURCE_ID, { type: "geojson", data: EMPTY });
  if (!map.getLayer(HEAT_LAYER_IDS.hotspots)) {
    // A white ring at each cell centre: readable at any zoom (a 10 m cell is a few pixels when the
    // whole grid fits) and distinct from the orange heat.
    map.addLayer({
      id: HEAT_LAYER_IDS.hotspots,
      type: "circle",
      source: HEAT_HOTSPOT_SOURCE_ID,
      paint: {
        "circle-radius": HOTSPOT_RADIUS_PX,
        "circle-color": colors.outline,
        "circle-opacity": 0,
        "circle-stroke-color": colors.outline,
        "circle-stroke-width": 2,
        "circle-stroke-opacity": HOTSPOT_OPACITY.mid,
      },
    });
  }
  // The replay trail and the drone go on top of everything: they are what moves.
  if (!map.getLayer(HEAT_LAYER_IDS.trail)) {
    map.addLayer({
      id: HEAT_LAYER_IDS.trail,
      type: "line",
      source: HEAT_TRAIL_SOURCE_ID,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": colors.outline, "line-opacity": 0.5, "line-width": 1.25 },
    });
  }
  if (!map.getLayer(HEAT_LAYER_IDS.droneHalo)) {
    map.addLayer({
      id: HEAT_LAYER_IDS.droneHalo,
      type: "circle",
      source: HEAT_DRONE_SOURCE_ID,
      paint: { "circle-color": colors.outline, "circle-opacity": 0.18, "circle-radius": 14, "circle-blur": 0.4 },
    });
  }
  if (!map.getLayer(HEAT_LAYER_IDS.drone)) {
    map.addLayer({
      id: HEAT_LAYER_IDS.drone,
      type: "circle",
      source: HEAT_DRONE_SOURCE_ID,
      paint: {
        "circle-color": colors.outline,
        "circle-radius": 5,
        "circle-stroke-color": colors.veil,
        "circle-stroke-width": 2,
      },
    });
  }
  return added;
}

/** Built once per grid, reused across style reloads and map instances. */
const cellCache = new WeakMap<Grid, GeoJsonData>();
export function cellFeaturesFor(grid: Grid): GeoJsonData {
  let data = cellCache.get(grid);
  if (!data) {
    data = buildCellFeatures(grid) as GeoJsonData;
    cellCache.set(grid, data);
  }
  return data;
}

/** Redraw the outline of the cells photographed so far. */
export function setSurveyedBoundary(map: Map, grid: Grid, photographed: Uint8Array): void {
  const source = map.getSource(HEAT_SURVEYED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "MultiLineString", coordinates: surveyedBoundary(grid, photographed) },
  });
}

/**
 * Push feature state: "o" = heat opacity (relative to the photographed cells that are not held),
 * "u" = 1 for a cell not photographed yet, "h" = 1 for a photographed cell awaiting review.
 * `last` holds what the map already has per cell (NaN = unknown) as o + 10 * u + 20 * h; only
 * cells whose value changed are sent. Mutates and returns `last`.
 */
export function pushHeatState(
  map: Map,
  state: MapState,
  last: Float64Array,
  covered: Uint8Array,
  held: Uint8Array,
): Float64Array {
  const opacities = relativeHeatOpacities(state.p, covered, held);
  for (let i = 0; i < opacities.length; i++) {
    const o = opacities[i] as number;
    const u = covered[i] === 1 ? 0 : 1;
    const h = covered[i] === 1 && held[i] === 1 ? 1 : 0;
    const sig = o + 10 * u + 20 * h;
    const prev = last[i] as number;
    if (Number.isNaN(prev) || Math.abs(prev - sig) > 1e-4) {
      map.setFeatureState({ source: HEAT_SOURCE_ID, id: i }, { o, u, h });
      last[i] = sig;
    }
  }
  return last;
}

/** Where the drone has flown after `stepIndex` frames, and where it is now. */
export function replayFeatures(
  path: LonLat[],
  stepIndex: number,
): { trail: GeoJsonData; drone: GeoJsonData } {
  const flown = path.slice(0, Math.max(0, Math.min(stepIndex, path.length)));
  const at = flown.at(-1);
  return {
    trail:
      flown.length >= 2
        ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: flown } }
        : EMPTY,
    drone: at ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: at } } : EMPTY,
  };
}

/** Lane B's flight layers that the legend's "Flight path (simulated)" switch shows and hides. */
export const FLIGHT_LAYER_IDS = [MAP_LAYER_IDS.flightPath, MAP_LAYER_IDS.flightDirection] as const;

/** Show or hide the flight path and its chevrons. Safe before lane B has drawn them. */
export function setFlightPathVisible(map: Map, visible: boolean): void {
  for (const id of FLIGHT_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty?.(id, "visibility", visible ? "visible" : "none");
  }
}

/** Move the trail and the drone. Safe before the sources exist (does nothing). */
export function pushReplay(map: Map, path: LonLat[], stepIndex: number): void {
  const { trail, drone } = replayFeatures(path, stepIndex);
  (map.getSource(HEAT_TRAIL_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(trail);
  (map.getSource(HEAT_DRONE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(drone);
}

/** Heat opacity multiplier at rest; breathing moves it by ±BREATH_AMPLITUDE of itself. */
export const HEAT_BASE_OPACITY = 0.75;
/** Breathing: ±10 % over 5 s. Slow and small on purpose (nothing flashes; WCAG 2.3.1). */
export const BREATH_AMPLITUDE = 0.1;
export const BREATH_PERIOD_MS = 5000;
/** Hotspot ring opacity across one breath, and its radius at rest (it breathes ±1.5 px). */
export const HOTSPOT_OPACITY = { low: 0.45, mid: 0.7, high: 0.95 } as const;
export const HOTSPOT_RADIUS_PX = 9;

/** 1 ± BREATH_AMPLITUDE, a sine of period BREATH_PERIOD_MS. */
export function breathFactor(tMs: number): number {
  return 1 + BREATH_AMPLITUDE * Math.sin((2 * Math.PI * tMs) / BREATH_PERIOD_MS);
}

/** Apply one breath: the heat's opacity scale and the hotspot rings, in step. */
export function setBreath(map: Map, factor: number): void {
  const o: ExpressionSpecification = ["coalesce", ["feature-state", "o"], 0];
  if (map.getLayer(HEAT_LAYER_IDS.cells)) {
    map.setPaintProperty(HEAT_LAYER_IDS.cells, "fill-opacity", ["*", o, HEAT_BASE_OPACITY * factor]);
  }
  if (map.getLayer(HEAT_LAYER_IDS.hotspots)) {
    const t = (factor - (1 - BREATH_AMPLITUDE)) / (2 * BREATH_AMPLITUDE); // 0 … 1
    const { low, high } = HOTSPOT_OPACITY;
    map.setPaintProperty(HEAT_LAYER_IDS.hotspots, "circle-stroke-opacity", low + t * (high - low));
    map.setPaintProperty(HEAT_LAYER_IDS.hotspots, "circle-radius", HOTSPOT_RADIUS_PX + 3 * (t - 0.5));
  }
}

/** Centres of the given cells (the Search next list), for the hotspot rings. */
export function hotspotFeatures(grid: Grid, cells: readonly number[]): GeoJsonData {
  return {
    type: "FeatureCollection",
    features: cells.map((idx, rank) => {
      const c = cellCenter(grid, idx);
      return { type: "Feature", properties: { idx, rank: rank + 1 }, geometry: { type: "Point", coordinates: [c.lon, c.lat] } };
    }),
  };
}

/** Redraw the hotspot outlines. Safe before the source exists (does nothing). */
export function pushHotspots(map: Map, grid: Grid, cells: readonly number[]): void {
  (map.getSource(HEAT_HOTSPOT_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(hotspotFeatures(grid, cells));
}
