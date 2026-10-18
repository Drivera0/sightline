// MapLibre sources and layers for the heat map. Kept free of React so tests can use a mocked map.
import type { GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { HEAT_LAYER_PREFIX, MAP_LAYER_IDS } from "../base/layerIds";
import { buildCellFeatures, relativeHeatOpacities, surveyedBoundary } from "./geometry";
import type { MapState } from "../../search/update";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

export const HEAT_SOURCE_ID = `${HEAT_LAYER_PREFIX}cells`;
export const HEAT_SURVEYED_SOURCE_ID = `${HEAT_LAYER_PREFIX}surveyed`;
export const HEAT_LAYER_IDS = {
  unsearched: `${HEAT_LAYER_PREFIX}unsearched`,
  review: `${HEAT_LAYER_PREFIX}review`,
  cells: `${HEAT_LAYER_PREFIX}cells`,
  surveyed: `${HEAT_LAYER_PREFIX}surveyed`,
} as const;

export interface HeatColors {
  accent: string;
  outline: string;
  /** Neutral tone for "not yet searched" cells. */
  unsearched: string;
  /** Tone for cells awaiting review (the shell's "Unsure" token). */
  review: string;
}

/** Opacity of the neutral "not yet searched" fill. Low, so the basemap shows through. */
export const UNSEARCHED_OPACITY = 0.22;
/** Opacity of the "awaiting review" fill. Strong enough to read next to the heat, low enough to see the basemap. */
export const REVIEW_OPACITY = 0.5;

/** MapLibre cannot read CSS variables, so read the tokens at runtime. */
export function readHeatColors(root: Element = document.documentElement): HeatColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    outline: styles.getPropertyValue("--text").trim(),
    unsearched: styles.getPropertyValue("--text-3").trim(),
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
        paint: { "line-color": colors.outline, "line-opacity": 0.7, "line-width": 1.5 },
      },
      beforeId(map),
    );
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
