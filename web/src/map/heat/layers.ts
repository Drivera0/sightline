// MapLibre sources and layers for the heat map. Kept free of React so tests can use a mocked map.
import type { GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { HEAT_LAYER_PREFIX, MAP_LAYER_IDS } from "../base/layerIds";
import { buildCellFeatures, heatOpacity, MAX_OPACITY, surveyedBoundary, type CellFeatureCollection } from "./geometry";
import type { MapState } from "../../search/update";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type LonLat = [number, number];

export const HEAT_SOURCE_ID = `${HEAT_LAYER_PREFIX}cells`;
export const HEAT_SURVEYED_SOURCE_ID = `${HEAT_LAYER_PREFIX}surveyed`;
export const HEAT_UNSEEN_SOURCE_ID = `${HEAT_LAYER_PREFIX}unseen`;
export const HEAT_TRAIL_SOURCE_ID = `${HEAT_LAYER_PREFIX}trail`;
export const HEAT_DRONE_SOURCE_ID = `${HEAT_LAYER_PREFIX}drone`;
export const HEAT_LAYER_IDS = {
  unseen: `${HEAT_LAYER_PREFIX}unseen`,
  cells: `${HEAT_LAYER_PREFIX}cells`,
  surveyed: `${HEAT_LAYER_PREFIX}surveyed`,
  trail: `${HEAT_LAYER_PREFIX}trail`,
  droneHalo: `${HEAT_LAYER_PREFIX}drone-halo`,
  drone: `${HEAT_LAYER_PREFIX}drone`,
} as const;

/** How strongly the "not photographed" veil darkens the basemap. */
export const UNSEEN_OPACITY = 0.62;

export interface HeatColors {
  accent: string;
  /** Low end of the heat ramp: warm, so a faint cell still reads as "some chance". */
  warm: string;
  outline: string;
  /** The veil over ground the drone never photographed. */
  veil: string;
}

/** MapLibre cannot read CSS variables, so read the tokens at runtime. */
export function readHeatColors(root: Element = document.documentElement): HeatColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    warm: styles.getPropertyValue("--warn").trim(),
    outline: styles.getPropertyValue("--text").trim(),
    veil: styles.getPropertyValue("--bg").trim(),
  };
}

/** Heat layers sit below every lane B layer: before grid-outline, or on top if B has not drawn yet. */
function beforeId(map: Map): string | undefined {
  return map.getLayer(MAP_LAYER_IDS.gridOutline) ? MAP_LAYER_IDS.gridOutline : undefined;
}

/** The cells nobody photographed, as one static collection (drawn as a flat veil). */
export function unseenCellFeatures(grid: Grid, covered: Uint8Array): CellFeatureCollection {
  const all = cellFeaturesFor(grid) as unknown as CellFeatureCollection;
  return { type: "FeatureCollection", features: all.features.filter((f) => covered[f.properties.idx] !== 1) };
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
  if (!map.getSource(HEAT_UNSEEN_SOURCE_ID)) {
    map.addSource(HEAT_UNSEEN_SOURCE_ID, {
      type: "geojson",
      data: unseenCellFeatures(grid, covered) as unknown as GeoJsonData,
    });
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

  if (!map.getLayer(HEAT_LAYER_IDS.unseen)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.unseen,
        type: "fill",
        source: HEAT_UNSEEN_SOURCE_ID,
        paint: { "fill-color": colors.veil, "fill-opacity": UNSEEN_OPACITY, "fill-antialias": false },
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
          "fill-color": ["interpolate", ["linear"], o, 0, colors.warm, MAX_OPACITY, colors.accent],
          // Softer than the raw share so the basemap still reads through the hottest cells.
          "fill-opacity": ["*", o, 0.75],
          "fill-antialias": false,
        },
      } as unknown as Parameters<Map["addLayer"]>[0],
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

/** Highest p among photographed cells: the heat is scaled to the ground the drone actually saw. */
export function maxCovered(p: Float64Array, covered: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < p.length; i++) if (covered[i] === 1 && (p[i] as number) > max) max = p[i] as number;
  return max;
}

/**
 * Push opacities as feature state. Only photographed cells get heat, scaled to the most likely
 * photographed cell; the rest sit under the veil at 0. `last` holds what the map already has
 * (NaN = unknown); only cells whose opacity changed are sent. Mutates and returns `last`.
 */
export function pushHeatState(map: Map, state: MapState, last: Float64Array, covered: Uint8Array): Float64Array {
  const maxP = maxCovered(state.p, covered);
  for (let i = 0; i < state.p.length; i++) {
    const o = covered[i] === 1 ? heatOpacity(state.p[i] as number, maxP) : 0;
    const prev = last[i] as number;
    if (Number.isNaN(prev) || Math.abs(prev - o) > 1e-4) {
      map.setFeatureState({ source: HEAT_SOURCE_ID, id: i }, { o });
      last[i] = o;
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

/** Move the trail and the drone. Safe before the sources exist (does nothing). */
export function pushReplay(map: Map, path: LonLat[], stepIndex: number): void {
  const { trail, drone } = replayFeatures(path, stepIndex);
  (map.getSource(HEAT_TRAIL_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(trail);
  (map.getSource(HEAT_DRONE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(drone);
}
