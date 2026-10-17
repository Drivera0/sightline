import type { CacheBundle } from "../../contract";
import type { Answer } from "../../review/store";
import type { GeoJSONSource, Map } from "maplibre-gl";
import {
  buildDetectionFeatures,
  buildFlightDirectionFeatures,
  buildFlightPathFeature,
  buildFootprintFeatures,
  buildGridOutlineFeature,
  buildLkpFeature,
} from "./features";
import { MAP_LAYER_IDS, MAP_SOURCE_IDS } from "./layerIds";

interface MapColors {
  accent: string;
  accentSoft: string;
  background: string;
  text: string;
  textSecondary: string;
  warning: string;
}

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

// Read the shared design tokens because MapLibre canvas paint cannot resolve CSS variables.
export function readMapColors(root: Element = document.documentElement): MapColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    accentSoft: styles.getPropertyValue("--accent-soft").trim(),
    background: styles.getPropertyValue("--bg").trim(),
    text: styles.getPropertyValue("--text").trim(),
    textSecondary: styles.getPropertyValue("--text-2").trim(),
    warning: styles.getPropertyValue("--warn").trim(),
  };
}

// Refresh detection geometry with the latest browser-only review answers.
export function syncDetectionSource(
  map: Map,
  bundle: Pick<CacheBundle, "detections">,
  answers: Readonly<Record<string, Answer>>,
): void {
  const source = map.getSource(MAP_SOURCE_IDS.pins) as GeoJSONSource | undefined;
  source?.setData(buildDetectionFeatures(bundle.detections, answers));
}

// Replace an existing GeoJSON source or add it on the first render.
function setGeoJsonSource(map: Map, id: string, data: GeoJsonData): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(id, { type: "geojson", data });
}

// Install or refresh all Lane B sources and their deterministic base layers.
export function syncBaseLayers(
  map: Map,
  bundle: Pick<CacheBundle, "survey" | "detections"> & {
    map: Pick<CacheBundle["map"], "grid">;
  },
  answers: Readonly<Record<string, Answer>> = {},
  colors = readMapColors(),
): void {
  setGeoJsonSource(map, MAP_SOURCE_IDS.grid, buildGridOutlineFeature(bundle.map.grid));
  setGeoJsonSource(map, MAP_SOURCE_IDS.footprints, buildFootprintFeatures(bundle.survey));
  setGeoJsonSource(map, MAP_SOURCE_IDS.flightPath, buildFlightPathFeature(bundle.survey));
  setGeoJsonSource(
    map,
    MAP_SOURCE_IDS.flightDirection,
    buildFlightDirectionFeatures(bundle.survey),
  );
  setGeoJsonSource(map, MAP_SOURCE_IDS.pins, buildDetectionFeatures(bundle.detections, answers));
  setGeoJsonSource(map, MAP_SOURCE_IDS.lkp, buildLkpFeature(bundle.survey));

  if (!map.getLayer(MAP_LAYER_IDS.gridOutline)) {
    map.addLayer({
      id: MAP_LAYER_IDS.gridOutline,
      type: "line",
      source: MAP_SOURCE_IDS.grid,
      paint: {
        "line-color": colors.textSecondary,
        "line-opacity": 0.8,
        "line-width": 2,
        "line-dasharray": [4, 2],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.footprints)) {
    map.addLayer({
      id: MAP_LAYER_IDS.footprints,
      type: "line",
      source: MAP_SOURCE_IDS.footprints,
      paint: { "line-color": colors.textSecondary, "line-opacity": 0.35, "line-width": 1 },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.selectedFootprint)) {
    map.addLayer({
      id: MAP_LAYER_IDS.selectedFootprint,
      type: "line",
      source: MAP_SOURCE_IDS.footprints,
      filter: ["==", ["get", "frameId"], ""],
      paint: { "line-color": colors.accent, "line-opacity": 0.95, "line-width": 3 },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.flightPath)) {
    map.addLayer({
      id: MAP_LAYER_IDS.flightPath,
      type: "line",
      source: MAP_SOURCE_IDS.flightPath,
      paint: {
        "line-color": colors.accentSoft,
        "line-opacity": 0.8,
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.flightDirection)) {
    map.addLayer({
      id: MAP_LAYER_IDS.flightDirection,
      type: "line",
      source: MAP_SOURCE_IDS.flightDirection,
      paint: {
        "line-color": colors.accentSoft,
        "line-opacity": 0.9,
        "line-width": 2,
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.pins)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pins,
      type: "fill",
      source: MAP_SOURCE_IDS.pins,
      paint: {
        "fill-color": colors.accent,
        "fill-opacity": ["case", ["==", ["get", "reviewState"], "person"], 0.65, 0],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.pinOutlines)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pinOutlines,
      type: "line",
      source: MAP_SOURCE_IDS.pins,
      filter: ["!=", ["get", "reviewState"], "not_person"],
      paint: {
        "line-color": [
          "match",
          ["get", "reviewState"],
          "unsure",
          colors.warning,
          "person",
          colors.accentSoft,
          colors.accent,
        ],
        "line-opacity": 0.95,
        "line-width": ["case", ["==", ["get", "reviewState"], "person"], 3, 2],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.rejectedPins)) {
    map.addLayer({
      id: MAP_LAYER_IDS.rejectedPins,
      type: "line",
      source: MAP_SOURCE_IDS.pins,
      filter: ["==", ["get", "reviewState"], "not_person"],
      paint: {
        "line-color": colors.textSecondary,
        "line-opacity": 0.7,
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.pinLabels)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pinLabels,
      type: "symbol",
      source: MAP_SOURCE_IDS.pins,
      layout: {
        "text-field": ["get", "reviewLabel"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 13,
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": [
          "case",
          ["==", ["get", "reviewState"], "unsure"],
          colors.warning,
          colors.text,
        ],
        "text-halo-color": colors.accent,
        "text-halo-width": 1,
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.lkp)) {
    map.addLayer({
      id: MAP_LAYER_IDS.lkp,
      type: "circle",
      source: MAP_SOURCE_IDS.lkp,
      paint: {
        "circle-color": colors.text,
        "circle-radius": 7,
        "circle-stroke-color": colors.accent,
        "circle-stroke-width": 3,
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.lkpLabel)) {
    map.addLayer({
      id: MAP_LAYER_IDS.lkpLabel,
      type: "symbol",
      source: MAP_SOURCE_IDS.lkp,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 13,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": colors.text,
        "text-halo-color": colors.background,
        "text-halo-width": 2,
      },
    });
  }
}

// Highlight the footprint associated with the shared review/map selection.
export function setSelectedFootprint(map: Map, frameId: string | null): void {
  if (!map.getLayer(MAP_LAYER_IDS.selectedFootprint)) return;
  map.setFilter(MAP_LAYER_IDS.selectedFootprint, ["==", ["get", "frameId"], frameId ?? ""]);
}
