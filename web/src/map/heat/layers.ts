// MapLibre sources and layers for the heat map. Kept free of React so tests can use a mocked map.
import type { GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { HEAT_LAYER_PREFIX, MAP_LAYER_IDS } from "../base/layerIds";
import { buildCellFeatures, relativeHeatOpacities, surveyedBoundary } from "./geometry";
import type { MapState } from "../../search/update";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type LonLat = [number, number];

export const HEAT_SOURCE_ID = `${HEAT_LAYER_PREFIX}cells`;
export const HEAT_SURVEYED_SOURCE_ID = `${HEAT_LAYER_PREFIX}surveyed`;
export const HEAT_TRAIL_SOURCE_ID = `${HEAT_LAYER_PREFIX}trail`;
export const HEAT_DRONE_SOURCE_ID = `${HEAT_LAYER_PREFIX}drone`;
export const HEAT_LAYER_IDS = {
  unsearched: `${HEAT_LAYER_PREFIX}unsearched`,
  review: `${HEAT_LAYER_PREFIX}review`,
  cells: `${HEAT_LAYER_PREFIX}cells`,
  surveyed: `${HEAT_LAYER_PREFIX}surveyed`,
  trail: `${HEAT_LAYER_PREFIX}trail`,
  droneHalo: `${HEAT_LAYER_PREFIX}drone-halo`,
  drone: `${HEAT_LAYER_PREFIX}drone`,
} as const;

export interface HeatColors {
  accent: string;
  outline: string;
  /** Veil over "not yet searched" cells: the page background, so the photographed area stands out. */
  unsearched: string;
  /** Tone for cells awaiting review (the shell's "Unsure" token). */
  review: string;
}

/** Opacity of the "not yet searched" veil: dark enough to read as "nobody has looked here", light
 * enough that the basemap still shows through. */
export const UNSEARCHED_OPACITY = 0.6;
/** Opacity of the "awaiting review" fill. Strong enough to read next to the heat, low enough to see the basemap. */
export const REVIEW_OPACITY = 0.5;

/** MapLibre cannot read CSS variables, so read the tokens at runtime. */
export function readHeatColors(root: Element = document.documentElement): HeatColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    outline: styles.getPropertyValue("--text").trim(),
    unsearched: styles.getPropertyValue("--bg").trim(),
    review: styles.getPropertyValue("--warn").trim(),
  };
}

/** Heat layers sit below every lane B layer: before grid-outline, or on top if B has not drawn yet. */
function beforeId(map: Map): string | undefined {
  return map.getLayer(MAP_LAYER_IDS.gridOutline) ? MAP_LAYER_IDS.gridOutline : undefined;
}

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
  // Below heat-cells: unphotographed cells in a neutral tone ("u" feature state = 1).
  if (!map.getLayer(HEAT_LAYER_IDS.unsearched)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.unsearched,
        type: "fill",
        source: HEAT_SOURCE_ID,
        paint: {
          "fill-color": colors.unsearched,
          "fill-opacity": ["case", ["==", ["coalesce", ["feature-state", "u"], 0], 1], UNSEARCHED_OPACITY, 0],
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
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.cells,
        type: "fill",
        source: HEAT_SOURCE_ID,
        paint: {
          "fill-color": colors.accent,
          "fill-opacity": ["coalesce", ["feature-state", "o"], 0],
          "fill-antialias": false,
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
        paint: { "line-color": colors.outline, "line-opacity": 0.6, "line-width": 1.25 },
      },
      beforeId(map),
    );
  }
  // The replay trail and the drone go on top of everything: they are what moves.
  if (!map.getSource(HEAT_TRAIL_SOURCE_ID)) map.addSource(HEAT_TRAIL_SOURCE_ID, { type: "geojson", data: EMPTY });
  if (!map.getSource(HEAT_DRONE_SOURCE_ID)) map.addSource(HEAT_DRONE_SOURCE_ID, { type: "geojson", data: EMPTY });
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
        "circle-stroke-color": colors.unsearched,
        "circle-stroke-width": 2,
      },
    });
  }
  return added;
}

const EMPTY: GeoJsonData = { type: "FeatureCollection", features: [] };

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
export function replayFeatures(path: LonLat[], stepIndex: number): { trail: GeoJsonData; drone: GeoJsonData } {
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

/** Move the trail and the drone. Safe before the sources exist (does nothing). */
export function pushReplay(map: Map, path: LonLat[], stepIndex: number): void {
  const { trail, drone } = replayFeatures(path, stepIndex);
  (map.getSource(HEAT_TRAIL_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(trail);
  (map.getSource(HEAT_DRONE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(drone);
}

/** Lane B's flight layers that the legend's "Flight path (simulated)" switch shows and hides. */
export const FLIGHT_LAYER_IDS = [MAP_LAYER_IDS.flightPath, MAP_LAYER_IDS.flightDirection] as const;

/** Show or hide the flight path and its chevrons. Safe before lane B has drawn them. */
export function setFlightPathVisible(map: Map, visible: boolean): void {
  for (const id of FLIGHT_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty?.(id, "visibility", visible ? "visible" : "none");
  }
}
