// MapLibre sources and layers for the heat map. Kept free of React so tests can use a mocked map.
import type { GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { HEAT_LAYER_PREFIX, MAP_LAYER_IDS } from "../base/layerIds";
import { buildCellFeatures, heatOpacity, maxOf, surveyedBoundary } from "./geometry";
import type { MapState } from "../../search/update";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

export const HEAT_SOURCE_ID = `${HEAT_LAYER_PREFIX}cells`;
export const HEAT_SURVEYED_SOURCE_ID = `${HEAT_LAYER_PREFIX}surveyed`;
export const HEAT_LAYER_IDS = {
  cells: `${HEAT_LAYER_PREFIX}cells`,
  surveyed: `${HEAT_LAYER_PREFIX}surveyed`,
} as const;

export interface HeatColors {
  accent: string;
  outline: string;
}

/** MapLibre cannot read CSS variables, so read the tokens at runtime. */
export function readHeatColors(root: Element = document.documentElement): HeatColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    outline: styles.getPropertyValue("--text").trim(),
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

/**
 * Push opacities as feature state. `last` holds what the map already has (NaN = unknown);
 * only cells whose opacity changed are sent. Mutates and returns `last`.
 */
export function pushHeatState(map: Map, state: MapState, last: Float64Array): Float64Array {
  const maxP = maxOf(state.p);
  for (let i = 0; i < state.p.length; i++) {
    const o = heatOpacity(state.p[i] as number, maxP);
    const prev = last[i] as number;
    if (Number.isNaN(prev) || Math.abs(prev - o) > 1e-4) {
      map.setFeatureState({ source: HEAT_SOURCE_ID, id: i }, { o });
      last[i] = o;
    }
  }
  return last;
}
